import test from "node:test";
import assert from "node:assert/strict";
import {
  getQuestions,
  createQuestion, updateQuestion, deleteQuestion, AdminApiError,
  createTeacherGameSession, logoutTeacherGameSession,
} from "../src/services/admin.ts";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "public-test-key";

const questionResponse = {
  id: "q-1", question: "Test?", options: ["A", "B", "C", "D"], answer: 0,
  explanation: "because", category: "general", difficulty: "mudah", timeLimit: 30,
  active: true, updatedAt: "2024-01-01T00:00:00.000Z",
};
const questionsResponse = { questions: [questionResponse] };
const okResponse = { ok: true };

function mockFetch(handler) {
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return handler(captured);
  };
  return { get captured() { return captured; }, restore: () => { globalThis.fetch = originalFetch; } };
}

function success(data) { return Response.json({ ok: true, status: 200, data }); }
function input(captured) { return captured.body; }

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
});

test("getQuestions calls the teacher-owned RPC read route", async () => {
  const mock = mockFetch(() => success(questionsResponse));
  try {
    assert.deepEqual(await getQuestions(), questionsResponse);
    assert.equal(mock.captured.url, "https://example.supabase.co/rest/v1/rpc/ular_api");
    assert.equal(mock.captured.init.method, "POST");
    assert.equal(mock.captured.init.cache, "no-store");
    assert.equal(input(mock.captured).p_path, "/teacher/questions");
    assert.equal(input(mock.captured).p_method, "GET");
    assert.deepEqual(input(mock.captured).p_body, {});
  } finally { mock.restore(); }
});

test("teacher session creation is delegated to the database identity", async () => {
  const mock = mockFetch(() => success({ id: "teacher-uuid", username: "Guru", xp: 0, coins: 0, level: 1, classroomHost: true, teacherRole: "teacher" }));
  try {
    await createTeacherGameSession();
    assert.equal(input(mock.captured).p_path, "/teacher/session");
    assert.equal(input(mock.captured).p_method, "POST");
    assert.deepEqual(input(mock.captured).p_body, {});
  } finally { mock.restore(); }
});

test("teacher session logout uses the role-bound RPC path", async () => {
  const mock = mockFetch(() => success(okResponse));
  try {
    await logoutTeacherGameSession();
    assert.equal(input(mock.captured).p_path, "/teacher/session/logout");
    assert.equal(input(mock.captured).p_method, "POST");
  } finally { mock.restore(); }
});

test("createQuestion sends the question object as p_body", async () => {
  const mock = mockFetch(() => success(questionResponse));
  const question = { question: "Q?", options: ["A", "B"], answer: 1, explanation: "exp", category: "cat", difficulty: "sedang", timeLimit: 45, active: true };
  try {
    assert.deepEqual(await createQuestion(question), questionResponse);
    assert.equal(input(mock.captured).p_path, "/teacher/questions");
    assert.equal(input(mock.captured).p_method, "POST");
    assert.deepEqual(input(mock.captured).p_body, question);
  } finally { mock.restore(); }
});

test("updateQuestion encodes the identifier into its RPC path", async () => {
  const mock = mockFetch(() => success(questionResponse));
  const question = { question: "Updated", options: ["X", "Y"], answer: 0, explanation: "e", category: "c", difficulty: "sulit", timeLimit: 60, active: false };
  try {
    await updateQuestion("q id with spaces", question);
    assert.equal(input(mock.captured).p_path, "/teacher/questions/q%20id%20with%20spaces");
    assert.deepEqual(input(mock.captured).p_body, question);
  } finally { mock.restore(); }
});

test("deleteQuestion uses DELETE without smuggling an action into the body", async () => {
  const mock = mockFetch(() => success({ ok: true }));
  try {
    assert.deepEqual(await deleteQuestion("q-1"), { ok: true });
    assert.equal(input(mock.captured).p_path, "/teacher/questions/q-1");
    assert.equal(input(mock.captured).p_method, "DELETE");
    assert.deepEqual(input(mock.captured).p_body, {});
  } finally { mock.restore(); }
});

test("deleteQuestion encodes slashes and query characters in its identifier", async () => {
  const mock = mockFetch(() => success({ ok: true }));
  try {
    await deleteQuestion("special/id?chars");
    assert.equal(input(mock.captured).p_path, "/teacher/questions/special%2Fid%3Fchars");
  } finally { mock.restore(); }
});

test("network error is normalized to AdminApiError", async () => {
  const mock = mockFetch(async () => { throw new Error("network down"); });
  try {
    await assert.rejects(getQuestions(), (error) => error instanceof AdminApiError && error.code === "NETWORK_ERROR" && error.status === 0);
  } finally { mock.restore(); }
});

test("RPC error envelope becomes AdminApiError with server code and message", async () => {
  const mock = mockFetch(() => Response.json({ ok: false, status: 400, error: { code: "VALIDATION_ERROR", message: "question too short" } }));
  try {
    await assert.rejects(createQuestion({ question: "Q", options: ["A", "B"], answer: 0, explanation: "e", category: "c", difficulty: "mudah", timeLimit: 10, active: true }),
      (error) => error instanceof AdminApiError && error.code === "VALIDATION_ERROR" && error.status === 400 && error.message === "question too short");
  } finally { mock.restore(); }
});

test("malformed RPC response receives a safe generic error", async () => {
  const mock = mockFetch(() => Response.json({}, { status: 503 }));
  try {
    await assert.rejects(getQuestions(), (error) => error instanceof AdminApiError && error.code === "SERVER_ERROR" && error.status === 503);
  } finally { mock.restore(); }
});

test("AdminApiError exposes code and status", () => {
  const error = new AdminApiError("TEST_CODE", "test message", 418);
  assert.equal(error.code, "TEST_CODE");
  assert.equal(error.status, 418);
  assert.equal(error.message, "test message");
  assert.ok(error instanceof Error);
});
