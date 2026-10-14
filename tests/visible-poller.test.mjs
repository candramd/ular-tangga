import test from "node:test";
import assert from "node:assert/strict";
import { createVisiblePoller } from "../src/services/visible-poller.ts";
import { createGameStateFallbackPoller } from "../src/services/game-state-fallback.ts";
import { connectGame } from "../src/services/websocket.ts";
import { useGameStore } from "../src/stores/game.store.ts";

class FakeDocument {
  hidden = false;
  listeners = new Set();
  addEventListener(type, listener) { if (type === "visibilitychange") this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === "visibilitychange") this.listeners.delete(listener); }
  setHidden(hidden) {
    this.hidden = hidden;
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeTimers {
  nextId = 1;
  jobs = new Map();
  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.jobs.set(id, { callback, delay });
    return id;
  }
  clearTimeout(id) { this.jobs.delete(id); }
  get delays() { return [...this.jobs.values()].map((job) => job.delay); }
  runNext() {
    const [id, job] = this.jobs.entries().next().value ?? [];
    if (!job) throw new Error("no scheduled timer");
    this.jobs.delete(id);
    job.callback();
  }
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const room = (status = "playing") => ({ id: "room-1", code: "ABC123", hostId: "user-1", status, isPublic: false, players: [], gameId: "game-1" });
const game = (status = "playing") => ({ id: "game-1", roomId: "room-1", status, turnNumber: 1, currentPlayerId: "user-1", turnState: status === "finished" ? "FINISHED" : "QUESTION", players: [], deadline: "2026-10-14T00:00:00.000Z", diceResult: 0, totalSteps: 100, snakes: {}, ladders: {} });
const syncResponse = ({ status = "playing", sequence, events = [] }) => ({
  room: room(status), game: game(status), events, sequence, serverTime: "2026-10-14T00:00:00.000Z",
});

function resetStore() {
  useGameStore.setState({ user: null, room: room(), game: game(), connection: "offline", result: null, resultTurnNumber: null, diceRoll: null });
}

const originalFetch = globalThis.fetch;
const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-publishable-key";

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
});

test("hidden pages pause polling and resume immediately without overlapping an in-flight sync or losing its cursor", async () => {
  resetStore();
  const doc = new FakeDocument();
  const timers = new FakeTimers();
  const requests = [];
  let resolveFirst;
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body).p_body;
    requests.push(body);
    active++;
    maxActive = Math.max(maxActive, active);
    if (requests.length === 1) {
      const response = await new Promise((resolve) => { resolveFirst = resolve; });
      active--;
      return response;
    }
    active--;
    const finalGame = game("finished");
    return Response.json({ ok: true, status: 200, data: syncResponse({
      status: "finished", sequence: 6,
      events: [{ sequence: 6, event: "game:state", payload: finalGame, timestamp: "2026-10-14T00:00:01.000Z" }],
    }) });
  };
  const stop = connectGame("room-1", "game-1", { document: doc, timers });
  await flush();
  assert.equal(requests.length, 1);
  doc.setHidden(true);
  doc.setHidden(false);
  assert.equal(requests.length, 1, "resume waits for an in-flight request instead of overlapping it");

  resolveFirst(Response.json({ ok: true, status: 200, data: syncResponse({ status: "playing", sequence: 5 }) }));
  await flush();
  assert.deepEqual(timers.delays, [0], "visibility during an in-flight request schedules immediate catch-up");
  timers.runNext();
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].afterSequence, 5, "resume keeps the last acknowledged event cursor");
  assert.equal(maxActive, 1);
  assert.equal(useGameStore.getState().game.status, "finished", "the terminal event is applied before polling stops");
  assert.equal(timers.jobs.size, 0, "a finished room does not schedule another poll");
  assert.equal(doc.listeners.size, 0, "terminal state removes the visibility listener");
  doc.setHidden(true);
  doc.setHidden(false);
  await flush();
  assert.equal(requests.length, 2);
  stop();
});

test("an initially hidden page waits for visibility and close removes timers/listeners", async () => {
  const doc = new FakeDocument();
  doc.hidden = true;
  const timers = new FakeTimers();
  let calls = 0;
  const stop = createVisiblePoller(() => { calls++; return 5000; }, { document: doc, timers });
  await flush();
  assert.equal(calls, 0);
  doc.setHidden(false);
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays, [5000]);
  stop();
  assert.equal(timers.jobs.size, 0);
  assert.equal(doc.listeners.size, 0);
  doc.setHidden(true);
  doc.setHidden(false);
  await flush();
  assert.equal(calls, 1);
});

test("disconnected fallback scheduling uses the same visibility gate and avoids overlap", async () => {
  const doc = new FakeDocument();
  const timers = new FakeTimers();
  let calls = 0;
  let finishFirst;
  const stop = createVisiblePoller(() => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { finishFirst = resolve; });
    return null;
  }, { document: doc, timers, initialDelayMs: 3000 });
  assert.deepEqual(timers.delays, [3000], "fallback preserves its normal first-refresh delay");
  timers.runNext();
  await flush();
  doc.setHidden(true);
  doc.setHidden(false);
  assert.equal(calls, 1);
  finishFirst(3000);
  await flush();
  assert.deepEqual(timers.delays, [0]);
  timers.runNext();
  await flush();
  assert.equal(calls, 2);
  assert.equal(doc.listeners.size, 0, "terminal fallback removes its listener");
  stop();
});


test("game-state fallback retries a room hydration gap and stops only after terminal state", async () => {
  const doc = new FakeDocument();
  const timers = new FakeTimers();
  let current = null;
  let fetches = 0;
  let stored = null;
  const stop = createGameStateFallbackPoller("game-1", {
    document: doc, timers,
    getGame: () => current,
    setGame: (next) => { current = stored = next; },
    fetchGame: async () => { fetches++; return game("playing"); },
  });
  assert.deepEqual(timers.delays, [3000]);
  timers.runNext();
  await flush();
  assert.equal(fetches, 0, "a transient missing game does not terminate polling");
  assert.deepEqual(timers.delays, [3000]);
  current = game("playing");
  timers.runNext();
  await flush();
  assert.equal(fetches, 1);
  assert.equal(stored.id, "game-1");
  assert.deepEqual(timers.delays, [3000]);
  current = game("finished");
  timers.runNext();
  await flush();
  assert.equal(timers.jobs.size, 0);
  assert.equal(doc.listeners.size, 0);
  stop();
});

test("fallback ignores an in-flight state response after sync reconnect cleanup", async () => {
  const doc = new FakeDocument();
  const timers = new FakeTimers();
  let current = game("playing");
  let stored = null;
  let resolveFetch;
  let active = true;
  useGameStore.setState({ connection: "offline" });
  const stop = createGameStateFallbackPoller("game-1", {
    document: doc, timers,
    getGame: () => current,
    setGame: (next) => { stored = next; current = next; },
    isActive: () => active && useGameStore.getState().connection !== "connected",
    fetchGame: () => new Promise((resolve) => { resolveFetch = resolve; }),
  });
  timers.runNext();
  await flush();
  useGameStore.setState({ connection: "connected" });
  resolveFetch({ ...game("playing"), turnNumber: 2 });
  await flush();
  assert.equal(stored, null, "late fallback data cannot overwrite the primary sync state");
  assert.equal(timers.jobs.size, 0);
  active = false;
  stop();
});
