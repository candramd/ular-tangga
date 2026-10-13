import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || process.env.TEST_ALLOW_MIGRATION_REAPPLY !== "true") {
  throw new Error("Set TEST_DATABASE_URL and TEST_ALLOW_MIGRATION_REAPPLY=true for an isolated loopback fixture only.");
}
const parsed = new URL(databaseUrl);
if (!/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(parsed.hostname)) {
  throw new Error("Migration reapply check refuses non-loopback database hosts.");
}

const root = process.cwd();
function psql(args) {
  try {
    return execFileSync("psql", ["--dbname", databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error("Isolated migration fixture command failed; psql output was withheld.");
  }
}

const snapshot = () => psql(["-At", "-c", `SELECT concat_ws('|',
  coalesce((SELECT encode(extensions.digest(convert_to(state::text,'UTF8'),'sha256'),'hex') FROM public.ular_server_state WHERE id=1),'no-state'),
  coalesce((SELECT version::text FROM public.ular_server_state WHERE id=1),'no-version'),
  (SELECT count(*) FROM public.ular_room_events),
  (SELECT count(*) FROM public.ular_rpc_requests),
  (SELECT count(*) FROM public.ular_admin_config),
  (SELECT count(*) FROM public.ular_game_config))`]);

const before = snapshot();
const migrations = [
  "supabase/migrations/002_static_rpc_foundation.sql",
  "supabase/migrations/003_ular_api_read_auth.sql",
  "supabase/migrations/004_game_mutations.sql",
  "supabase/migrations/005_admin_rpc.sql",
];
const apply = (files) => psql(files.flatMap((file) => ["-f", resolve(root, file)]));

apply(migrations);
apply(migrations);
apply([migrations[2], migrations[2]]);

const after = snapshot();
if (before !== after) throw new Error("Reapplying migrations changed fixture state; private row contents and hashes are withheld.");
const readAuth = psql(["-At", "-c", `SELECT (public.ular_api('/auth/me','GET','{}'::jsonb,NULL,NULL,NULL)->>'ok'='false')
  AND (public.ular_api('/auth/me','GET','{}'::jsonb,NULL,NULL,NULL)->>'status')::integer=401`]);
if (readAuth !== "t") throw new Error("RPC unauthorized read check failed after migration reapply.");
console.log("Repeated 002–005 twice and 004 twice; fixture state checksum/counts unchanged and unauthorized RPC read still returns 401.");
