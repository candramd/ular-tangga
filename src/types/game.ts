export type User = { id: string; username: string; xp: number; coins: number; level: number; synthetic?: boolean };
export type Player = User & { position: number; isConnected: boolean };
export type Room = {
  id: string; code: string; hostId: string; status: "waiting" | "playing" | "finished";
  mode?: "local"; isPublic: boolean; players: Player[]; gameId?: string;
};
export type Question = {
  id: string; question: string; options: string[]; category: string;
  difficulty: string; timeLimit: number;
};
export type Game = {
  id: string; roomId: string; status: "playing" | "finished"; turnNumber: number;
  currentPlayerId: string; turnState: "QUESTION" | "DICE_UNLOCKED" | "MOVING" | "FINISHED";
  players: Player[]; question?: Question; deadline: string; diceResult: number;
  winnerId?: string; totalSteps: number; snakes: Record<string, number>; ladders: Record<string, number>;
};
export type AnswerResult = {
  playerId?: string; result: "correct" | "wrong" | "timeout"; correctAnswer?: number;
  explanation?: string; position: number; xp: number; coins?: number; diceUnlocked: boolean;
};
export type LeaderboardEntry = { id: string; username: string; rank: number; correctAnswers: number };
export type GameEvent = { event: string; gameId?: string; turnNumber?: number; timestamp: string; payload: unknown; sequence?: number };
