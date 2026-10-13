import { useGameStore } from "@/stores/game.store";
import type { AnswerResult, Game, GameEvent, Room } from "@/types/game";
import { createEventQueue } from "./event-queue";
import { DICE_ROLL_DURATION_MS } from "@/game/dice-motion";
import { api } from "./api";
import { requestId } from "./api";
import { setServerTime } from "./server-clock";

type SyncResponse = { room: Room; game?: Game; events: GameEvent[]; sequence: number; serverTime: string };
export function connectGame(roomId: string, gameId?: string) {
  let stopped = false, sequence: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const store = useGameStore.getState;
  let stepDelay = 300;
  const queue = createEventQueue<GameEvent>(({ event, payload, timestamp, turnNumber }) => {
    if (event === "room:state") store().setRoom(payload as Room);
    if (event === "game:state") store().setGame(payload as Game);
    if (event === "question:result") store().setResult(payload as AnswerResult, turnNumber ?? store().game?.turnNumber);
    if (event === "dice:rolled") {
      const state = store().game;
      store().setDiceRoll({ id: `${state?.id}:${turnNumber}:${timestamp}`, value: (payload as { value: number }).value, startedAt: Date.now() });
      if (state) store().setGame({ ...state, turnState: "MOVING", diceResult: (payload as { value: number }).value });
    }
    if (event === "player:step") {
      const step = payload as { playerId: string; position: number };
      const previous = store().game?.players.find((p) => p.id === step.playerId)?.position ?? step.position;
      stepDelay = Math.abs(step.position - previous) > 1 ? 1300 : 300;
      store().step(step.playerId, step.position);
    }
  }, (message) => message.event === "player:step" ? stepDelay : message.event === "dice:rolled" ? DICE_ROLL_DURATION_MS : 0);

  const poll = async () => {
    if (stopped) return;
    try {
      const response = await api<SyncResponse>(`/rooms/${encodeURIComponent(roomId)}/sync`, { ...(sequence === undefined ? {} : { afterSequence: sequence }), ...(gameId ? { gameId } : {}) }, requestId());
      if (stopped || store().room?.id !== roomId || (gameId && store().game?.id && store().game?.id !== gameId)) return;
      failures = 0;
      store().setConnection("connected");
      setServerTime(response.serverTime);
      if (response.room) store().setRoom(response.room);
      const initialSync = sequence === undefined;
      if (response.game && (!gameId || response.game.id === gameId) && (initialSync || (queue.isIdle && !store().diceRoll && !(response.events || []).length))) store().setGame(response.game);
      const incoming = [...(response.events || [])].filter((event) => event.sequence === undefined || event.sequence > (sequence ?? -1));
      // The initial snapshot already includes the full state. Animating its historic events would replay an old turn.
      if (!initialSync) incoming.forEach((event) => queue.push(event));
      sequence = Math.max(sequence ?? -1, response.sequence ?? -1);
      timer = setTimeout(poll, response.room?.status === "playing" ? 1200 : 2000);
    } catch {
      if (stopped) return;
      failures++;
      store().setConnection("offline");
      timer = setTimeout(poll, Math.min(1000 * 2 ** Math.min(failures, 4), 15000));
    }
  };
  store().setConnection("connecting");
  void poll();
  return () => { stopped = true; if (timer) clearTimeout(timer); queue.dispose(); store().setDiceRoll(null); store().setConnection("offline"); };
}
