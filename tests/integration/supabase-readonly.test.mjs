import test from "node:test";
import assert from "node:assert/strict";

const base = process.env.TEST_SUPABASE_URL?.replace(/\/$/, "") || "";
const key = process.env.TEST_SUPABASE_ANON_KEY || "";
const skipReason = !base || !key ? "Set TEST_SUPABASE_URL and TEST_SUPABASE_ANON_KEY for read-only RPC checks" : false;

function headers() {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

test("anonymous RPC returns the standard unauthorized envelope without a session", { skip: skipReason }, async () => {
  const response = await fetch(`${base}/rest/v1/rpc/ular_api`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      p_path: "/auth/me", p_method: "GET", p_body: {},
      p_session_token: null, p_admin_token: null, p_request_id: "qa-readonly-auth-check",
    }),
  });
  assert.equal(response.ok, true, `PostgREST transport returned HTTP ${response.status}`);
  const envelope = await response.json();
  assert.equal(envelope.ok, false);
  assert.equal(envelope.status, 401);
  assert.equal(typeof envelope.error?.code, "string");
  assert.equal("answer" in (envelope.data || {}), false);
});

test("anonymous role cannot read the private state table", { skip: skipReason }, async () => {
  const response = await fetch(`${base}/rest/v1/ular_server_state?select=id,state`, { headers: headers() });
  assert.ok(response.status === 401 || response.status === 403, `expected denied table read, got HTTP ${response.status}`);
});
