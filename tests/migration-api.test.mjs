import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError, clearSessionTokens, claimLocalMigrationSession } from "../src/services/api.ts";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const values = new Map([["ular-session-token", "session-test-token"], ["ular-admin-token", "admin-test-token"]]);
const originalStorage = globalThis.localStorage;
const originalWindow = globalThis.window;
const originalLegacyUrl = process.env.NEXT_PUBLIC_LEGACY_API_URL;

test.before(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co/";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-test-key";
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
});

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  if (originalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalStorage;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalLegacyUrl === undefined) delete process.env.NEXT_PUBLIC_LEGACY_API_URL;
  else process.env.NEXT_PUBLIC_LEGACY_API_URL = originalLegacyUrl;
});

test("static API sends the agreed RPC envelope and opaque client tokens", async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return Response.json({ ok: true, status: 200, data: { room: { id: "r1" }, events: [], sequence: 9 } });
  };
  const result = await api("/rooms/r1/sync", { afterSequence: 8 }, "retry-1", "GET");
  assert.equal(result.sequence, 9);
  assert.equal(captured.url, "https://example.supabase.co/rest/v1/rpc/ular_api");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.cache, "no-store");
  assert.equal(captured.init.headers.apikey, "public-test-key");
  assert.equal(captured.init.headers.Authorization, "Bearer public-test-key");
  assert.deepEqual(captured.body, {
    p_path: "/rooms/r1/sync", p_method: "GET", p_body: { afterSequence: 8 },
    p_session_token: "session-test-token", p_admin_token: null, p_request_id: "retry-1",
  });
});

test("API stores returned session token and removes it on logout", async () => {
  globalThis.fetch = async () => Response.json({ ok: true, status: 200, data: {}, meta: { sessionToken: "rotated-session" } });
  await api("/auth/me", undefined, "me-1", "GET");
  assert.equal(values.get("ular-session-token"), "rotated-session");
  await api("/auth/logout", {}, "logout-1");
  assert.equal(values.has("ular-session-token"), false);
});

test("auth cleanup invalidates an in-flight response before it can return data or store its token", async () => {
  values.delete("ular-session-token");
  let releaseFetch;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  globalThis.fetch = async () => {
    notifyStarted();
    return new Promise((resolve) => { releaseFetch = resolve; });
  };
  const pending = api("/teacher/session", {}, "deferred-session-1");
  await started;
  clearSessionTokens();
  releaseFetch(Response.json({ ok: true, status: 200, data: { id: "teacher-a" }, meta: { sessionToken: "stale-teacher-token" } }));
  await assert.rejects(pending, (error) => error instanceof ApiError && error.code === "SESSION_CHANGED");
  assert.equal(values.has("ular-session-token"), false);
});

test("RPC failures become ApiError without exposing envelope internals as success", async () => {
  globalThis.fetch = async () => Response.json({ ok: false, status: 403, error: { code: "FORBIDDEN", message: "denied" } }, { status: 200 });
  await assert.rejects(api("/rooms/r1/start", {}, "start-1"), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.status, 403);
    return true;
  });
});

test("clearing token storage removes both opaque tokens", () => {
  clearSessionTokens();
  assert.equal(values.has("ular-session-token"), false);
  assert.equal(values.has("ular-admin-token"), false);
});

test("legacy cookie exchange is unavailable on public hostnames", async () => {
  values.delete("ular-session-token");
  process.env.NEXT_PUBLIC_LEGACY_API_URL = "http://localhost:8080";
  globalThis.window = { location: { hostname: "game.example.com" } };
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("should not call legacy host"); };
  assert.equal(await claimLocalMigrationSession(), false);
  assert.equal(called, false);
});

test("legacy cookie exchange requires loopback on both browser and API origins", async () => {
  values.delete("ular-session-token");
  globalThis.window = { location: { hostname: "localhost" } };
  process.env.NEXT_PUBLIC_LEGACY_API_URL = "https://localhost:8080";
  assert.equal(await claimLocalMigrationSession(), false);
  process.env.NEXT_PUBLIC_LEGACY_API_URL = "http://api.example.com";
  assert.equal(await claimLocalMigrationSession(), false);
});

test("legacy cookie exchange is one-time and saves only a valid returned token", async () => {
  values.delete("ular-session-token");
  globalThis.window = { location: { hostname: "127.0.0.1" } };
  process.env.NEXT_PUBLIC_LEGACY_API_URL = "http://localhost:18082";
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return Response.json({ sessionToken: "migrated-session-token-123456789", user: { id: "user-1" } });
  };
  assert.equal(await claimLocalMigrationSession(), true);
  assert.equal(captured.url, "http://localhost:18082/api/migration/session");
  assert.equal(captured.init.credentials, "include");
  assert.equal(values.get("ular-session-token"), "migrated-session-token-123456789");
  let calledAgain = false;
  globalThis.fetch = async () => { calledAgain = true; throw new Error("existing token should short-circuit"); };
  assert.equal(await claimLocalMigrationSession(), false);
  assert.equal(calledAgain, false);
});
