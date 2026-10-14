"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ACTOR_KEY = "ular-teacher-actor";
const ACCOUNT_DOMAIN = "accounts.ular-tangga.invalid";
const RESERVED = new Set(["admin", "administrator", "root", "support", "system", "teacher", "student", "siswa", "guru", "help", "moderator"]);

export class TeacherAuthError extends Error {
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.code = code; this.name = "TeacherAuthError"; }
}

export function normalizeTeacherUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,22}[a-z0-9]$/.test(username) || username.includes("..")) {
    throw new TeacherAuthError("Nama pengguna harus 3–24 karakter: huruf a–z, angka, titik, garis bawah, atau tanda hubung.", "INVALID_USERNAME");
  }
  if (RESERVED.has(username)) throw new TeacherAuthError("Nama pengguna tersebut tidak dapat digunakan.", "RESERVED_USERNAME");
  return username;
}

export function usernameAuthEmail(value: string): string {
  return `${normalizeTeacherUsername(value)}@${ACCOUNT_DOMAIN}`;
}

type PasswordAuth = Pick<SupabaseClient["auth"], "signUp" | "signInWithPassword" | "signOut" | "getSession">;

export function createUsernameAuthActions(auth: PasswordAuth) {
  return {
    async signUp(usernameInput: string, password: string) {
      if (password.length < 8) throw new TeacherAuthError("Kata sandi harus berisi minimal 8 karakter.", "PASSWORD_TOO_SHORT");
      const email = usernameAuthEmail(usernameInput);
      const { data, error } = await auth.signUp({ email, password });
      if (error) throw error;
      if (!data.user || !data.session) {
        throw new TeacherAuthError("Pendaftaran instan belum aktif. Periksa konfigurasi autentikasi lalu coba lagi.", "SIGNUP_NOT_INSTANT");
      }
      return { userId: data.user.id };
    },
    async signIn(usernameInput: string, password: string) {
      const email = usernameAuthEmail(usernameInput);
      const { data, error } = await auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (!data.user || !data.session) throw new TeacherAuthError("Sesi masuk tidak tersedia.", "SESSION_MISSING");
      return { userId: data.user.id };
    },
  };
}

let client: SupabaseClient | null = null;

export function supabaseAuth() {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Konfigurasi Supabase belum tersedia.");
  client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "implicit" } });
  return client;
}

export async function getTeacherSession() {
  const { data, error } = await supabaseAuth().auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signUpTeacherWithUsername(username: string, password: string) {
  return createUsernameAuthActions(supabaseAuth().auth).signUp(username, password);
}

export async function signInTeacherWithUsername(username: string, password: string) {
  return createUsernameAuthActions(supabaseAuth().auth).signIn(username, password);
}

export async function signOutTeacher() {
  try {
    const { error } = await supabaseAuth().auth.signOut({ scope: "local" });
    if (error) throw error;
  }
  finally { clearTeacherActorId(); }
}

export function setTeacherActorId(id: string) {
  if (typeof window !== "undefined") window.localStorage.setItem(ACTOR_KEY, id);
}

export function getTeacherActorId() {
  return typeof window === "undefined" ? null : window.localStorage.getItem(ACTOR_KEY);
}

export function clearTeacherActorId() {
  if (typeof window !== "undefined") window.localStorage.removeItem(ACTOR_KEY);
}

export async function accessToken() {
  const { data, error } = await supabaseAuth().auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}
