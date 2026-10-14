import type { Game } from "../types/game.ts";
import { createVisiblePoller, type VisiblePollOptions } from "./visible-poller.ts";

export type GameStateFallbackOptions = VisiblePollOptions & {
  getGame: () => Game | null;
  setGame: (game: Game) => void;
  fetchGame: (gameId: string) => Promise<Game>;
  shouldDefer?: () => boolean;
  isActive?: () => boolean;
};

/** Refresh stale game state while sync reconnects; transient hydration gaps keep retrying. */
export function createGameStateFallbackPoller(gameId: string, options: GameStateFallbackOptions): () => void {
  const { getGame, setGame, fetchGame, shouldDefer = () => false, isActive = () => true, ...pollOptions } = options;
  return createVisiblePoller(async () => {
    const current = getGame();
    if (current?.status === "finished") return null;
    // Room restoration can finish before the initial game-state request.
    if (current?.id !== gameId) return 3000;
    if (shouldDefer()) return 3000;
    try {
      const next = await fetchGame(gameId);
      if (!isActive()) return null;
      if (getGame()?.id === gameId) setGame(next);
      return next.status === "finished" ? null : 3000;
    } catch {
      return isActive() ? 3000 : null;
    }
  }, { ...pollOptions, initialDelayMs: 3000 });
}
