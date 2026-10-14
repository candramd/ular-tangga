import { api } from "./api.ts";

export type AdminQuestion = {
  id: string;
  question: string;
  options: string[];
  answer: number;
  explanation: string;
  category: string;
  difficulty: "mudah" | "sedang" | "sulit";
  timeLimit: number;
  active: boolean;
  updatedAt: string;
};

export type AdminQuestionsResponse = {
  questions: AdminQuestion[];
};

export type AdminQuestionCreateResponse = AdminQuestion;
export type AdminQuestionUpdateResponse = AdminQuestion;
export type AdminQuestionDeleteResponse = { ok: boolean };

export type AdminErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};

export class AdminApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type AdminRequestMethod = "GET" | "POST" | "DELETE";

type AdminRequestOptions = {
  method?: AdminRequestMethod;
  body?: Record<string, unknown>;
};

async function request<T>(
  path: string,
  options: AdminRequestOptions = {}
): Promise<T> {
  try { return await api<T>(path, options.body, undefined, options.method); }
  catch (error) {
    if (error instanceof AdminApiError) throw error;
    const e = error as { code?: string; message?: string; status?: number };
    throw new AdminApiError(e.code || "SERVER_ERROR", e.message || "Server tidak tersedia. Coba lagi sebentar.", e.status || 0);
  }
}

export async function createTeacherGameSession(): Promise<{ id: string; username: string; xp: number; coins: number; level: number; classroomHost: true; teacherRole: "teacher" }> {
  return request("/teacher/session", { method: "POST", body: {} });
}

export async function logoutTeacherGameSession(): Promise<{ ok: boolean }> {
  return request("/teacher/session/logout", { method: "POST", body: {} });
}

export async function getQuestions(): Promise<AdminQuestionsResponse> {
  return request<AdminQuestionsResponse>("/teacher/questions");
}

export async function createQuestion(
  question: Omit<AdminQuestion, "id" | "updatedAt">
): Promise<AdminQuestionCreateResponse> {
  return request<AdminQuestionCreateResponse>("/teacher/questions", { body: question });
}

export async function updateQuestion(
  id: string,
  question: Omit<AdminQuestion, "id" | "updatedAt">
): Promise<AdminQuestionUpdateResponse> {
  return request<AdminQuestionUpdateResponse>(`/teacher/questions/${encodeURIComponent(id)}`, { body: question });
}

export async function deleteQuestion(
  id: string
): Promise<AdminQuestionDeleteResponse> {
  return request<AdminQuestionDeleteResponse>(`/teacher/questions/${encodeURIComponent(id)}`, { method: "DELETE" });
}
