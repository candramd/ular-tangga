import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, test } from "node:test";

const SUPABASE_URL = process.env.TEST_SUPABASE_URL || "";
const API_URL = SUPABASE_URL || process.env.TEST_API_URL || "";
const SUPABASE_KEY = process.env.TEST_SUPABASE_ANON_KEY || "";
const ADMIN_SECRET = process.env.TEST_ADMIN_SECRET || "";
const allowMutations = process.env.TEST_ALLOW_MUTATIONS === "true";
const skipReason = !API_URL || !ADMIN_SECRET || !allowMutations || (SUPABASE_URL && !SUPABASE_KEY)
  ? "Set TEST_ALLOW_MUTATIONS=true, an isolated TEST_API_URL or TEST_SUPABASE_URL, TEST_ADMIN_SECRET, and TEST_SUPABASE_ANON_KEY for Supabase"
  : false;

function assertError(res, status, code) {
  assert.equal(res.status, status, `expected ${status} got ${res.status}: ${res.raw}`);
  assert.equal(res.data?.error?.code, code, `expected code ${code} got ${res.raw}`);
}

function validQuestion(overrides = {}) {
  return {
    question: "Apa ibu kota Jawa Tengah?",
    options: ["Semarang", "Yogyakarta", "Surakarta", "Magelang"],
    answer: 0,
    category: "Geografi",
    difficulty: "mudah",
    timeLimit: 30,
    active: true,
    explanation: "Semarang adalah ibu kota Jawa Tengah.",
    ...overrides,
  };
}

function assertQuestionShape(q) {
  assert.equal(typeof q.id, "string");
  assert.equal(typeof q.question, "string");
  assert.ok(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 6);
  assert.equal(typeof q.answer, "number");
  assert.ok(["mudah", "sedang", "sulit"].includes(q.difficulty));
  assert.ok(q.timeLimit >= 10 && q.timeLimit <= 120);
  assert.equal(typeof q.active, "boolean");
}

let seq = 0;
function requestId(prefix) {
  seq++;
  return `${prefix}-${seq}-${crypto.randomBytes(6).toString("hex")}`;
}

class Client {
  constructor(base) {
    this.base = base.replace(/\/$/, "");
    this.cookies = new Map();
    this.sessionToken = null;
    this.adminToken = null;
  }

  setCookie(setCookieHeader) {
    for (const raw of setCookieHeader.split(",")) {
      const m = raw.match(/^([^=]+)=([^;]*)/);
      if (!m) continue;
      const name = m[1].trim();
      if (m[2].trim() === "") this.cookies.delete(name);
      else this.cookies.set(name, decodeURIComponent(m[2]));
    }
  }

  cookieHeader() {
    return this.cookies.size
      ? [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
      : undefined;
  }

  async request(method, path, { body, cookie, headers = {} } = {}) {
    const rpc = Boolean(SUPABASE_URL);
    const url = rpc ? `${this.base.replace(/\/$/, "")}/rest/v1/rpc/ular_api` : `${this.base}${path}`;
    const init = { method: rpc ? "POST" : method, headers: rpc ? {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    } : { ...headers } };
    if (rpc) {
      const pPath = path.replace(/^\/api(?=\/|$)/, "") || "/";
      init.body = JSON.stringify({ p_path: pPath, p_method: method, p_body: body ?? {}, p_session_token: this.sessionToken, p_admin_token: this.adminToken, p_request_id: body?.requestId || requestId("rpc") });
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
      if (cookie) init.headers["Cookie"] = cookie;
    }
    const res = await fetch(url, init);
    const text = await res.text();
    if (!rpc) {
      const sc = res.headers.get("set-cookie");
      if (sc) this.setCookie(sc);
    }
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (rpc && data && typeof data === "object") {
      const envelope = data;
      if (envelope.meta?.sessionToken) this.sessionToken = envelope.meta.sessionToken;
      if (envelope.meta?.adminToken) this.adminToken = envelope.meta.adminToken;
      const safeEnvelope = JSON.stringify(envelope, (key, value) => ["sessionToken", "adminToken"].includes(key) ? "[redacted]" : value);
      return { status: envelope.status || res.status, data: envelope.ok ? envelope.data : { error: envelope.error }, raw: safeEnvelope, ok: Boolean(envelope.ok) };
    }
    return { status: res.status, data, raw: text, ok: res.ok };
  }

  get(path, cookie) { return this.request("GET", path, { cookie: cookie || this.cookieHeader() }); }
  post(path, body, cookie) { return this.request("POST", path, { body, cookie: cookie || this.cookieHeader() }); }
  del(path, cookie) { return this.request("DELETE", path, { cookie: cookie || this.cookieHeader() }); }
}

async function guestUser(client, name, id) {
  const res = await client.post("/api/auth/guest", { username: name, requestId: id });
  assert.equal(res.status, 200, `guest create failed: ${res.raw}`);
  assert.ok(res.data.id, "guest id missing");
  return res.data;
}

const createdQuestionIds = new Set();
const createdRooms = new Map();
const adminClient = new Client(API_URL);

async function createQuestion(client, question) {
  const res = await client.post("/api/admin/questions", question);
  // Record ownership before any caller assertion so failed assertions cannot leak fixtures.
  if (typeof res.data?.id === "string") createdQuestionIds.add(res.data.id);
  return res;
}

async function createLocalRoom(client, playerNames, id) {
  const res = await client.post("/api/rooms/local", { players: playerNames, requestId: id });
  if (typeof res.data?.id === "string") createdRooms.set(res.data.id, { client, room: res.data });
  assert.equal(res.status, 200, `local room create failed: ${res.raw}`);
  assert.ok(res.data.id, `local room id missing: ${res.raw}`);
  return res.data;
}

async function startLocalGame(client, room, id) {
  const res = await client.post(`/api/rooms/${room.id}/start`, { requestId: id });
  assert.equal(res.status, 200, `start failed: ${res.raw}`);
  return res.data;
}

async function answerQuestion(client, game, answer, id, playerId) {
  const body = { requestId: id, questionId: game.question.id, answer };
  if (playerId) body.playerId = playerId;
  return client.post(`/api/games/${game.id}/question/answer`, body);
}

async function rollDice(client, game, id, playerId) {
  const body = { requestId: id };
  if (playerId) body.playerId = playerId;
  return client.post(`/api/games/${game.id}/dice/roll`, body);
}

async function fetchState(client, game) {
  return client.get(`/api/games/${game.id}/state`);
}

async function adminLogin(client, secret) {
  return client.post("/api/admin/session", { secret });
}

async function adminListQuestions(client) {
  return client.get("/api/admin/questions");
}

async function adminUpdateQuestion(client, id, question) {
  return client.post(`/api/admin/questions/${id}`, question);
}

async function adminDeleteQuestion(client, id) {
  return client.del(`/api/admin/questions/${id}`);
}

async function adminLogout(client) {
  return client.post("/api/admin/session/logout");
}

async function deleteOtherOwnedQuestions(keepId) {
  for (const id of createdQuestionIds) {
    if (id === keepId) continue;
    const res = await adminDeleteQuestion(adminClient, id);
    assert.ok([200, 404].includes(res.status), `could not remove owned question ${id}: ${res.raw}`);
  }
}

after(async () => {
  if (skipReason) return;

  const failures = [];
  for (const [id, { client }] of createdRooms) {
    try {
      const res = await client.post(`/api/rooms/${id}/leave`, { requestId: requestId("cleanup-room") });
      if (![200, 404].includes(res.status)) failures.push(`room ${id}: ${res.status} ${res.raw}`);
    } catch (error) {
      failures.push(`room ${id}: ${error.message}`);
    }
  }

  const cleanupAdmin = new Client(API_URL);
  try {
    const login = await adminLogin(cleanupAdmin, ADMIN_SECRET);
    if (login.status !== 200) {
      if (createdQuestionIds.size) failures.push(`admin cleanup login: ${login.status} ${login.raw}`);
    } else {
      for (const id of createdQuestionIds) {
        try {
          const res = await adminDeleteQuestion(cleanupAdmin, id);
          if (![200, 404].includes(res.status)) failures.push(`question ${id}: ${res.status} ${res.raw}`);
        } catch (error) {
          failures.push(`question ${id}: ${error.message}`);
        }
      }
      const logout = await adminLogout(cleanupAdmin);
      if (logout.status !== 200) failures.push(`cleanup admin logout: ${logout.status} ${logout.raw}`);
    }
  } catch (error) {
    failures.push(`question cleanup: ${error.message}`);
  }

  // The main session may still exist after an early assertion failure; logout is idempotent.
  try {
    const logout = await adminLogout(adminClient);
    if (logout.status !== 200) failures.push(`admin logout: ${logout.status} ${logout.raw}`);
  } catch (error) {
    failures.push(`admin logout: ${error.message}`);
  }

  assert.deepEqual(failures, [], `fixture cleanup failed: ${failures.join("; ")}`);
});

test("admin-game integration", { skip: skipReason }, async (t) => {
  const login = await adminLogin(adminClient, ADMIN_SECRET);
  assert.equal(login.status, 200, `login failed: ${login.raw}`);
  assert.equal(login.data.ok, true);

  // Never modify an existing bank: this suite is safe only on a fresh test backend.
  const initial = await adminListQuestions(adminClient);
  assert.equal(initial.status, 200, `initial question list failed: ${initial.raw}`);
  assert.ok(Array.isArray(initial.data.questions));
  assert.equal(initial.data.questions.length, 0, "refusing to run: initial question bank must be empty");

  let primaryQuestionId;

  await t.test("admin create question succeeds and returns question with answer", async () => {
    const suffix = requestId("q1");
    const question = validQuestion({ question: `Integration create test? ${suffix}`, options: ["A", "B"], answer: 1 });
    const res = await createQuestion(adminClient, question);
    assert.equal(res.status, 200, `create failed: ${res.raw}`);
    assert.ok(res.data.id);
    primaryQuestionId = res.data.id;
    assert.equal(res.data.question, question.question);
    assert.equal(res.data.answer, question.answer);
    assert.ok(res.data.explanation);
  });

  await t.test("admin create rejects duplicate question", async () => {
    const suffix = requestId("qdup");
    const question = validQuestion({ question: `Integration duplicate test? ${suffix}` });
    const first = await createQuestion(adminClient, question);
    assert.equal(first.status, 200, `first create failed: ${first.raw}`);
    assert.ok(first.data.id);
    const duplicate = await createQuestion(adminClient, question);
    assertError(duplicate, 409, "CONFLICT");
  });

  await t.test("admin list includes created questions", async () => {
    const res = await adminListQuestions(adminClient);
    assert.equal(res.status, 200);
    const found = res.data.questions.filter((q) => createdQuestionIds.has(q.id));
    assert.equal(found.length, createdQuestionIds.size);
    for (const question of found) assertQuestionShape(question);
  });

  await t.test("admin update question replaces entirely", async () => {
    assert.ok(primaryQuestionId, "primary question was not created");
    const suffix = requestId("qupdate");
    const updated = validQuestion({
      question: `Updated integration question? ${suffix}`,
      options: ["X", "Y", "Z"],
      answer: 2,
      category: "Updated",
      difficulty: "sedang",
      timeLimit: 45,
      active: false,
    });
    const res = await adminUpdateQuestion(adminClient, primaryQuestionId, updated);
    assert.equal(res.status, 200, `update failed: ${res.raw}`);
    assert.equal(res.data.id, primaryQuestionId);
    assert.equal(res.data.question, updated.question);
    assert.deepEqual(res.data.options, updated.options);
    assert.equal(res.data.answer, updated.answer);
    assert.equal(res.data.category, updated.category);
    assert.equal(res.data.difficulty, updated.difficulty);
    assert.equal(res.data.timeLimit, updated.timeLimit);
    assert.equal(res.data.active, updated.active);
  });

  await t.test("admin update missing returns 404", async () => {
    const res = await adminUpdateQuestion(adminClient, "nonexistent-id", validQuestion());
    assertError(res, 404, "NOT_FOUND");
  });

  await t.test("admin delete question succeeds", async () => {
    const question = validQuestion({ question: `To delete? ${requestId("qdel")}` });
    const createRes = await createQuestion(adminClient, question);
    assert.equal(createRes.status, 200, `delete fixture create failed: ${createRes.raw}`);
    const id = createRes.data.id;
    const res = await adminDeleteQuestion(adminClient, id);
    assert.equal(res.status, 200, `delete failed: ${res.raw}`);
    assert.equal(res.data.ok, true);
    const listRes = await adminListQuestions(adminClient);
    assert.equal(listRes.status, 200);
    assert.ok(!listRes.data.questions.some((q) => q.id === id));
  });

  await t.test("admin delete missing returns 404", async () => {
    const res = await adminDeleteQuestion(adminClient, "nonexistent-id");
    assertError(res, 404, "NOT_FOUND");
  });

  await t.test("wrong answer does not unlock dice", async () => {
    const question = validQuestion({
      question: `Game wrong-answer fixture ${requestId("qgame-wrong")}`,
      options: ["Wrong test answer", "Intended correct answer"],
      answer: 0,
    });
    const createRes = await createQuestion(adminClient, question);
    assert.equal(createRes.status, 200, `game question create failed: ${createRes.raw}`);
    await deleteOtherOwnedQuestions(createRes.data.id);

    const gameClient = new Client(API_URL);
    const player = await guestUser(gameClient, "TesterHost", requestId("guest"));
    const room = await createLocalRoom(gameClient, ["TesterLocal"], requestId("room"));
    const game = await startLocalGame(gameClient, room, requestId("start"));

    assert.equal(game.question.question, question.question);
    assert.deepEqual(game.question.options, question.options);
    assert.notEqual(game.question.id, createRes.data.id, "game question ID must be per-turn, not a bank question ID");

    const answerRes = await answerQuestion(gameClient, game, 1, requestId("ans"), player.id);
    assert.equal(answerRes.status, 200, `answer failed: ${answerRes.raw}`);
    assert.equal(answerRes.data.result, "wrong");
    assert.ok(answerRes.data.explanation);
    assert.equal(typeof answerRes.data.correctAnswer, "number");
    assert.equal(answerRes.data.diceUnlocked, false);

    const stateRes = await fetchState(gameClient, game);
    assert.equal(stateRes.status, 200);
    assert.notEqual(stateRes.data.currentPlayerId, player.id);
    const diceRes = await rollDice(gameClient, game, requestId("locked-dice"), player.id);
    assert.notEqual(diceRes.status, 200, `dice unexpectedly unlocked: ${diceRes.raw}`);
  });

  await t.test("correct answer unlocks dice and state hides answer", async () => {
    const question = validQuestion({
      question: `Game correct-answer fixture ${requestId("qgame-correct")}`,
      options: ["Correct test answer", "Distractor"],
      answer: 0,
    });
    const createRes = await createQuestion(adminClient, question);
    assert.equal(createRes.status, 200, `game question create failed: ${createRes.raw}`);
    await deleteOtherOwnedQuestions(createRes.data.id);

    const gameClient = new Client(API_URL);
    const player = await guestUser(gameClient, "TesterHost2", requestId("guest2"));
    const room = await createLocalRoom(gameClient, ["TesterLocal2"], requestId("room2"));
    const game = await startLocalGame(gameClient, room, requestId("start2"));

    assert.equal(game.question.question, question.question);
    assert.deepEqual(game.question.options, question.options);
    assert.notEqual(game.question.id, createRes.data.id, "game question ID must be per-turn, not a bank question ID");

    const answerRes = await answerQuestion(gameClient, game, 0, requestId("ans2"), player.id);
    assert.equal(answerRes.status, 200, `answer failed: ${answerRes.raw}`);
    assert.equal(answerRes.data.result, "correct");
    assert.equal(answerRes.data.diceUnlocked, true);
    assert.ok(answerRes.data.correctAnswer !== undefined);
    assert.ok(answerRes.data.explanation);

    const stateRes = await fetchState(gameClient, game);
    assert.equal(stateRes.status, 200);
    assert.ok(!("answerIndex" in stateRes.data.question));
    assert.ok(!("correctAnswer" in stateRes.data.question));
    const diceRes = await rollDice(gameClient, game, requestId("unlocked-dice"), player.id);
    assert.equal(diceRes.status, 200, `dice did not unlock: ${diceRes.raw}`);
  });

  await t.test("admin logout works and invalidates session", async () => {
    const logout = await adminLogout(adminClient);
    assert.equal(logout.status, 200);
    assert.equal(logout.data.ok, true);
    const list = await adminListQuestions(adminClient);
    assert.ok([401, 404].includes(list.status), `expected 401/404 got ${list.status}: ${list.raw}`);
  });
});
