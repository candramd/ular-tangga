import { create } from "zustand";
import type { AnswerResult, Game, Player, Room, User } from "../types/game.ts";
import type { DiceRoll } from "../game/dice-motion.ts";

type State = {
  user: User | null; room: Room | null; game: Game | null;
  connection: "offline" | "connecting" | "connected"; result: AnswerResult | null; resultTurnNumber: number | null;
  diceRoll: DiceRoll | null; setDiceRoll: (roll: DiceRoll | null) => void;
  setUser: (user: User | null) => void; setRoom: (room: Room | null) => void;
  setGame: (game: Game | null) => void; setResult: (result: AnswerResult | null, turnNumber?: number) => void;
  setConnection: (connection: State["connection"]) => void;
  resetGameplay: () => void;
  step: (playerId: string, position: number) => void;
};

export const useGameStore = create<State>((set) => ({
  user: null, room: null, game: null, result: null, resultTurnNumber: null, connection: "offline",
  diceRoll: null, setDiceRoll: (diceRoll) => set({ diceRoll }),
  setUser: (user) => set({ user }), setRoom: (room) => set({ room }),
  setGame: (game) => set((state) => {
    const me = game?.players.find((p: Player) => p.id === state.user?.id);
    return { game, diceRoll: game?.id === state.game?.id ? state.diceRoll : null,
      user: me ? { ...state.user!, xp: me.xp, coins: me.coins, level: me.level } : state.user };
  }),
  setResult: (result, resultTurnNumber) => set({ result, resultTurnNumber: result ? resultTurnNumber ?? null : null }), setConnection: (connection) => set({ connection }),
  resetGameplay: () => set({ room: null, game: null, result: null, resultTurnNumber: null, diceRoll: null, connection: "offline" }),
  step: (playerId, position) => set((state) => ({ game: state.game ? {
    ...state.game, players: state.game.players.map((p) => p.id === playerId ? { ...p, position } : p),
  } : null })),
}));
