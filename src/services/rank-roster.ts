import type { LeaderboardEntry, Player } from "@/types/game";

/** Rank only the players in the visible room, using their all-time totals. */
export function rankRoster(players: Player[], totals: LeaderboardEntry[]): LeaderboardEntry[] {
  const totalsById = new Map(totals.map((entry) => [entry.id, entry.correctAnswers]));
  const ranked = players
    .filter((player) => !player.classroomHost)
    .map((player) => ({ id: player.id, username: player.username, correctAnswers: totalsById.get(player.id) ?? 0 }))
    .sort((a, b) => b.correctAnswers - a.correctAnswers || a.username.localeCompare(b.username));
  let rank = 0;
  let priorScore: number | null = null;
  return ranked.map((entry, index) => {
    if (entry.correctAnswers !== priorScore) rank = index + 1;
    priorScore = entry.correctAnswers;
    return { ...entry, rank };
  });
}
