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

export type AdminSessionResponse = {
  ok: boolean;
  persistenceEnabled?: boolean;
};

export type AdminSessionCreateResponse = {
  ok: boolean;
};

export type AdminSessionLogoutResponse = {
  ok: boolean;
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

export async function createSession(
  secret: string
): Promise<AdminSessionCreateResponse> {
  return request<AdminSessionCreateResponse>("/admin/session", { body: { secret } });
}

export async function getSession(): Promise<AdminSessionResponse> {
  return request<AdminSessionResponse>("/admin/session");
}

export async function logoutSession(): Promise<AdminSessionLogoutResponse> {
  return request<AdminSessionLogoutResponse>("/admin/session/logout", { body: {} });
}

export async function getQuestions(): Promise<AdminQuestionsResponse> {
  return request<AdminQuestionsResponse>("/admin/questions");
}

export async function createQuestion(
  question: Omit<AdminQuestion, "id" | "updatedAt">
): Promise<AdminQuestionCreateResponse> {
  return request<AdminQuestionCreateResponse>("/admin/questions", { body: question });
}

export async function updateQuestion(
  id: string,
  question: Omit<AdminQuestion, "id" | "updatedAt">
): Promise<AdminQuestionUpdateResponse> {
  return request<AdminQuestionUpdateResponse>(`/admin/questions/${encodeURIComponent(id)}`, { body: question });
}

export async function deleteQuestion(
  id: string
): Promise<AdminQuestionDeleteResponse> {
  return request<AdminQuestionDeleteResponse>(`/admin/questions/${encodeURIComponent(id)}`, { method: "DELETE" });
}
