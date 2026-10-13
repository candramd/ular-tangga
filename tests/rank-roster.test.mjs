import test from "node:test";
import assert from "node:assert/strict";
import { rankRoster } from "../src/services/rank-roster.ts";

const player = (id, username, classroomHost = false) => ({
  id, username, xp: 0, coins: 0, level: 1, position: 0, isConnected: true, classroomHost,
});

test("room leaderboard reranks the visible children and preserves competition ties", () => {
  const ranked = rankRoster(
    [player("host", "Sesi perangkat", true), player("a", "Ayu"), player("b", "Bima"), player("c", "Cici")],
    [
      { id: "a", username: "Ayu", rank: 1, correctAnswers: 12 },
      { id: "b", username: "Bima", rank: 6, correctAnswers: 7 },
      { id: "c", username: "Cici", rank: 6, correctAnswers: 7 },
    ],
  );
  assert.deepEqual(ranked.map(({ id, rank, correctAnswers }) => ({ id, rank, correctAnswers })), [
    { id: "a", rank: 1, correctAnswers: 12 },
    { id: "b", rank: 2, correctAnswers: 7 },
    { id: "c", rank: 2, correctAnswers: 7 },
  ]);
});
