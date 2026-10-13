import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/services/api.ts";

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const entries = new Map([
  ["ular-session-token", "guest-token"],
  ["ular-admin-token", "admin-token"],
]);
globalThis.localStorage = {
  getItem: (key) => entries.get(key) ?? null,
  setItem: (key, value) => entries.set(key, value),
  removeItem: (key) => entries.delete(key),
};
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-test-key";

test("guest logout revokes local guest token without clearing admin token", async () => {
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(init.body);
    assert.equal(rpc.p_path, "/auth/logout");
    assert.equal(rpc.p_session_token, "guest-token");
    return Response.json({ ok: true, status: 200, data: { ok: true } });
  };
  try {
    await api("/auth/logout", {});
    assert.equal(entries.has("ular-session-token"), false);
    assert.equal(entries.get("ular-admin-token"), "admin-token");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  }
});
