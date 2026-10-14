import test from "node:test";
import assert from "node:assert/strict";
import { accessToken, createUsernameAuthActions, getTeacherActorId, normalizeTeacherUsername, setTeacherActorId, signOutTeacher, supabaseAuth, usernameAuthEmail, TeacherAuthError } from "../src/services/supabase-auth.ts";
import { shouldReconcileAuthIdentity } from "../src/services/auth-transition.ts";

test("usernames normalize case and map to a reserved non-deliverable Supabase identity", () => {
  assert.equal(normalizeTeacherUsername("  Bu_Guru-1 "), "bu_guru-1");
  assert.equal(usernameAuthEmail("Bu_Guru-1"), "bu_guru-1@accounts.ular-tangga.invalid");
  assert.equal(usernameAuthEmail("BU_GURU-1"), usernameAuthEmail("bu_guru-1"));
});

test("invalid and reserved usernames are rejected before any Auth request", async () => {
  for (const name of ["ab", "with space", "éclair", ".starts", "trailing.", "admin", "GURU", "a..b", "user/name"]) {
    assert.throws(() => normalizeTeacherUsername(name), TeacherAuthError, name);
  }
  let called = false;
  const actions = createUsernameAuthActions({ signUp: async () => { called = true; } });
  await assert.rejects(actions.signUp("root", "long-password"), (e) => e.code === "RESERVED_USERNAME");
  assert.equal(called, false);
});

test("signup immediately creates a password account using only Supabase Auth", async () => {
  let input;
  const actions = createUsernameAuthActions({
    signUp: async (payload) => { input = payload; return { data: { user: { id: "teacher-1" }, session: { access_token: "sdk-session" } }, error: null }; },
  });
  assert.deepEqual(await actions.signUp("TeacherA", "long-password"), { userId: "teacher-1" });
  assert.deepEqual(input, { email: "teachera@accounts.ular-tangga.invalid", password: "long-password" });
});

test("signup requires an immediate session and never claims a pending email was sent", async () => {
  const actions = createUsernameAuthActions({ signUp: async () => ({ data: { user: { id: "teacher-1" }, session: null }, error: null }) });
  await assert.rejects(actions.signUp("teacherA", "long-password"), (e) => e instanceof TeacherAuthError && e.code === "SIGNUP_NOT_INSTANT");
});

test("signup enforces password length locally", async () => {
  let called = false;
  const actions = createUsernameAuthActions({ signUp: async () => { called = true; } });
  await assert.rejects(actions.signUp("teacherA", "short"), (e) => e.code === "PASSWORD_TOO_SHORT");
  assert.equal(called, false);
});

test("password login uses the same case-insensitive username mapping", async () => {
  let input;
  const actions = createUsernameAuthActions({ signInWithPassword: async (payload) => { input = payload; return { data: { user: { id: "teacher-1" }, session: { access_token: "sdk-session" } }, error: null }; } });
  await actions.signIn("TeacherA", "long-password");
  assert.deepEqual(input, { email: "teachera@accounts.ular-tangga.invalid", password: "long-password" });
});

test("login propagates Supabase credential failures and rejects missing sessions", async () => {
  const failure = new Error("Invalid login credentials");
  await assert.rejects(createUsernameAuthActions({ signInWithPassword: async () => ({ data: { user: null, session: null }, error: failure }) }).signIn("teacherA", "wrong"), failure);
  await assert.rejects(createUsernameAuthActions({ signInWithPassword: async () => ({ data: { user: { id: "teacher-1" }, session: null }, error: null }) }).signIn("teacherA", "long-password"), (e) => e.code === "SESSION_MISSING");
});

test("auth transition compares the component owner when another tab already changed shared storage", () => {
  assert.equal(shouldReconcileAuthIdentity({ currentOwnerId: "A", nextOwnerId: "B", event: "SIGNED_IN" }), true);
});
test("auth transition clears the current owner on sign-out", () => {
  assert.equal(shouldReconcileAuthIdentity({ currentOwnerId: "A", nextOwnerId: null, event: "SIGNED_OUT" }), true);
});
test("sign-out cleans up before restore establishes the component owner", () => {
  assert.equal(shouldReconcileAuthIdentity({ currentOwnerId: null, nextOwnerId: null, event: "SIGNED_OUT" }), true);
});
test("initial null session does not trigger a needless reload", () => {
  assert.equal(shouldReconcileAuthIdentity({ currentOwnerId: null, nextOwnerId: null, event: "INITIAL_SESSION" }), false);
});
test("guest gameplay reconciles when a teacher signs in", () => {
  assert.equal(shouldReconcileAuthIdentity({ currentOwnerId: null, nextOwnerId: "B", event: "SIGNED_IN", hasGuestIdentity: true }), true);
});

test("Supabase Auth client is a singleton for all API/session requests", () => {
  const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const oldKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://username-auth.example.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-test-key";
  try { assert.strictEqual(supabaseAuth(), supabaseAuth()); }
  finally {
    if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
    if (oldKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = oldKey;
  }
});

test("session refresh errors propagate and local signout always clears the teacher actor pointer", async () => {
  const auth = supabaseAuth().auth;
  const oldGetSession = auth.getSession;
  const oldSignOut = auth.signOut;
  const originalWindow = globalThis.window;
  const values = new Map();
  globalThis.window = { localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) } };
  const failure = new Error("auth refresh failed");
  try {
    auth.getSession = async () => ({ data: { session: null }, error: failure });
    await assert.rejects(accessToken(), failure);
    setTeacherActorId("teacher-1");
    auth.signOut = async () => ({ error: failure });
    await assert.rejects(signOutTeacher(), failure);
    assert.equal(getTeacherActorId(), null);
  } finally {
    auth.getSession = oldGetSession;
    auth.signOut = oldSignOut;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  }
});
