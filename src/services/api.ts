export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; }
}

const messages: Record<string, string> = {
  UNAUTHORIZED: "Sesi berakhir. Masuk kembali untuk melanjutkan.", ROOM_NOT_FOUND: "Ruang tidak ditemukan. Periksa kembali kode ruangnya.", ROOM_FULL: "Ruang sudah penuh. Coba ruang lain atau buat ruang baru.", NOT_PLAYER_TURN: "Tunggu sebentar, ini belum giliranmu.", DICE_NOT_UNLOCKED: "Jawab pertanyaan dengan benar untuk membuka dadu.", FORBIDDEN: "Kamu tidak memiliki akses untuk aksi ini.", ROOM_IS_LOCAL: "Ruang ini hanya untuk pemain di satu perangkat yang sama.", DUPLICATE_PLAYER_NAME: "Nama pemain tidak boleh sama. Gunakan nama yang berbeda.", PLAYER_ID_NOT_ALLOWED: "Aksi atas nama pemain lain hanya untuk mode satu perangkat.",
};
const SESSION_KEY = "ular-session-token";
const ADMIN_KEY = "ular-admin-token";
const localHost = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
export function requestId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
export const getSessionToken = () => { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } };
export const getAdminToken = () => { try { return localStorage.getItem(ADMIN_KEY); } catch { return null; } };
export const setSessionToken = (token: string) => { try { localStorage.setItem(SESSION_KEY, token); } catch {} };
export function clearSessionTokens() { try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(ADMIN_KEY); } catch {} }

// During local cutover only, exchange the browser's existing Go session cookie
// for its opaque bearer token. Published origins never contact the legacy host.
export async function claimLocalMigrationSession(): Promise<boolean> {
  if (typeof window === "undefined" || !localHost(window.location.hostname) || getSessionToken()) return false;
  const configured = process.env.NEXT_PUBLIC_LEGACY_API_URL;
  if (!configured) return false;
  let legacy: URL;
  try { legacy = new URL(configured); } catch { return false; }
  if (legacy.protocol !== "http:" || !localHost(legacy.hostname)) return false;
  try {
    const response = await fetch(`${legacy.origin}/api/migration/session`, { method: "GET", credentials: "include", cache: "no-store" });
    if (!response.ok) return false;
    const result = await response.json();
    if (typeof result?.sessionToken !== "string" || !result.sessionToken || !result.user?.id) return false;
    setSessionToken(result.sessionToken);
    return true;
  } catch { return false; }
}

export async function api<T>(path: string, body?: Record<string, unknown>, clientRequestId?: string, method?: "GET" | "POST" | "DELETE"): Promise<T> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !key) throw new ApiError("CONFIG_MISSING", "Layanan Supabase belum dikonfigurasi. Hubungi pengelola aplikasi.", 0);
  const request = clientRequestId || requestId();
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, "")}/rest/v1/rpc/ular_api`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` }, body: JSON.stringify({ p_path: path, p_method: method || (body === undefined ? "GET" : "POST"), p_body: body ?? {}, p_session_token: getSessionToken(), p_admin_token: getAdminToken(), p_request_id: request }) });
  } catch { throw new ApiError("NETWORK_ERROR", "Server belum terhubung. Periksa koneksi internet lalu coba lagi.", 0); }
  const envelope = await response.json().catch(() => null);
  if (!response.ok || !envelope?.ok) {
    const failure = envelope?.error;
    const code = failure?.code || "SERVER_ERROR";
    throw new ApiError(code, messages[code] || failure?.message || "Server belum tersedia. Coba lagi sebentar.", envelope?.status || response.status);
  }
  if (envelope.meta?.sessionToken) { try { localStorage.setItem(SESSION_KEY, envelope.meta.sessionToken); } catch {} }
  if (envelope.meta?.adminToken) { try { localStorage.setItem(ADMIN_KEY, envelope.meta.adminToken); } catch {} }
  if (path === "/admin/session/logout" || path === "/auth/logout") { try { localStorage.removeItem(ADMIN_KEY); if (path === "/auth/logout") localStorage.removeItem(SESSION_KEY); } catch {} }
  return envelope.data as T;
}
