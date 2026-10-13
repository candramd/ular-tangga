import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { createEventQueue } from "../src/services/event-queue.ts";

test("final server snapshot cannot skip movement steps", async () => {
  const seen = [];
  const queue = createEventQueue((event) => seen.push(event), (event) => event.startsWith("step") ? 10 : 0);
  queue.push("moving"); queue.push("step28"); queue.push("step29"); queue.push("nextTurn");
  assert.deepEqual(seen, ["moving", "step28"]);
  await wait(50);
  assert.deepEqual(seen, ["moving", "step28", "step29", "nextTurn"]);
  queue.dispose();
});

test("reconnect discards stale animation and accepts authoritative snapshot", async () => {
  const seen = [];
  const queue = createEventQueue((event) => seen.push(event), () => 10);
  queue.push("oldStep"); queue.push("staleSnapshot");
  queue.clear(); queue.push("reconnectedSnapshot");
  await wait(30);
  assert.deepEqual(seen, ["oldStep", "reconnectedSnapshot"]);
  queue.dispose();
});

test("disposed subscriptions never mutate a new game", async () => {
  const seen = [];
  const queue = createEventQueue((event) => seen.push(event), () => 10);
  queue.push(1); queue.push(2); queue.dispose(); queue.push(3);
  await wait(30);
  assert.deepEqual(seen, [1]);
});
