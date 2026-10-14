import { useGameStore } from "../stores/game.store.ts";
import type { AnswerResult, Game, GameEvent, Room } from "../types/game.ts";
import { createEventQueue } from "./event-queue.ts";
import { DICE_ROLL_DURATION_MS } from "../game/dice-motion.ts";
import { api } from "./api.ts";
import { requestId } from "./api.ts";
import { setServerTime } from "./server-clock.ts";
import { createVisiblePoller, type VisiblePollOptions } from "./visible-poller.ts";

type SyncResponse = { room: Room; game?: Game; events: GameEvent[]; sequence: number; serverTime: string };
export function connectGame(roomId: string, gameId?: string, pollOptions?: VisiblePollOptions) {
  let stopped = false, sequence: number | undefined;
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

  const stopPolling = createVisiblePoller(async () => {
    if (stopped) return null;
    try {
      const response = await api<SyncResponse>(`/rooms/${encodeURIComponent(roomId)}/sync`, { ...(sequence === undefined ? {} : { afterSequence: sequence }), ...(gameId ? { gameId } : {}) }, requestId());
      if (stopped || store().room?.id !== roomId || (gameId && store().game?.id && store().game?.id !== gameId)) return null;
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
      if (response.room?.status === "finished" || response.game?.status === "finished") return null;
      return response.room?.status === "playing" ? 1200 : 2000;
    } catch {
      if (stopped) return null;
      failures++;
      store().setConnection("offline");
      return Math.min(1000 * 2 ** Math.min(failures, 4), 15000);
    }
  }, pollOptions);
  store().setConnection("connecting");
  return () => { stopped = true; stopPolling(); queue.dispose(); store().setDiceRoll(null); store().setConnection("offline"); };
}
