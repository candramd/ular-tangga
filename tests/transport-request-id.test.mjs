import test from "node:test";
import assert from "node:assert/strict";
import { requestId, api } from "../src/services/api.ts";

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const originalFetch = globalThis.fetch;
test.before(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-test-key";
});
test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
});

test("requestId returns distinct non-empty opaque identifiers", () => {
  const seen = new Set(Array.from({ length: 500 }, () => requestId()));
  assert.equal(seen.size, 500);
  for (const id of seen) assert.ok(typeof id === "string" && id.length >= 16);
});

test("requestId remains unique when crypto.randomUUID is unavailable", () => {
  const original = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    const first = requestId();
    const second = requestId();
    assert.ok(first.length >= 16);
    assert.notEqual(first, second);
  } finally {
    Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
  }
});

test("RPC POST carries requestId separately from the method body", async () => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ ok: true, status: 200, data: {} });
  };
  await api("/rooms", { isPublic: true });
  await api("/rooms", { isPublic: true }, "fixed-request-id");
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].p_request_id.length >= 16);
  assert.equal(bodies[0].p_method, "POST");
  assert.deepEqual(bodies[0].p_body, { isPublic: true });
  assert.equal(bodies[1].p_request_id, "fixed-request-id");
  assert.deepEqual(bodies[1].p_body, { isPublic: true });
});

test("RPC GET preserves the read method and cursor in p_body", async () => {
  let call;
  globalThis.fetch = async (_url, init) => {
    call = JSON.parse(init.body);
    return Response.json({ ok: true, status: 200, data: {} });
  };
  await api("/rooms/r1/sync", { afterSequence: 12 }, "sync-request-id", "GET");
  assert.equal(call.p_path, "/rooms/r1/sync");
  assert.equal(call.p_method, "GET");
  assert.deepEqual(call.p_body, { afterSequence: 12 });
  assert.equal(call.p_request_id, "sync-request-id");
});
