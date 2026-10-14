import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";

const databaseUrl = process.env.TEST_WRITER_LOCK_DATABASE_URL || "";
const enabled = process.env.TEST_ALLOW_WRITER_LOCK_REHEARSAL === "true" && !!databaseUrl;
const skipReason = enabled ? false : "Set TEST_WRITER_LOCK_DATABASE_URL and TEST_ALLOW_WRITER_LOCK_REHEARSAL=true for a dedicated local PostgreSQL fixture";
const migrationPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations/008_shared_rpc_writer_gate.sql");
const recoveryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/recovery/restore-exclusive-rpc-gate.sql");

function numericLoopbackAddress(hostname) {
  const address = hostname.replace(/^\[|\]$/g, "");
  const loopback = (isIP(address) === 4 && address.split(".")[0] === "127") || address === "::1";
  if (!loopback) throw new Error("Writer-lock rehearsal refuses non-loopback database hosts");
  return address;
}

test("writer-lock rehearsal accepts only numeric loopback hosts", () => {
  assert.equal(numericLoopbackAddress("127.0.0.1"), "127.0.0.1");
  assert.equal(numericLoopbackAddress("127.0.0.2"), "127.0.0.2");
  assert.equal(numericLoopbackAddress("[::1]"), "::1");
  for (const hostname of ["localhost", "127.0.0.1.nip.io", "192.168.1.2", "example.com"]) {
    assert.throws(() => numericLoopbackAddress(hostname), /non-loopback/);
  }
});

function connectionEnvironment() {
  const parsed = new URL(databaseUrl);
  const address = numericLoopbackAddress(parsed.hostname);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/^(rollback_rehearsal|ular_lock_test)_[a-z0-9_]+$/.test(database)) {
    throw new Error("Writer-lock rehearsal requires a disposable rollback_rehearsal_* or ular_lock_test_* database");
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
  env.PGHOST = address;
  env.PGPORT = parsed.port || "5432";
  env.PGUSER = decodeURIComponent(parsed.username || "postgres");
  env.PGPASSWORD = decodeURIComponent(parsed.password || "");
  env.PGDATABASE = database;
  const allowedOptions = new Set([
    "application_name", "channel_binding", "connect_timeout", "gssencmode",
    "keepalives", "keepalives_count", "keepalives_idle", "keepalives_interval",
    "options", "sslcert", "sslcrl", "sslcrldir", "sslkey", "sslmode",
    "sslrootcert", "target_session_attrs", "tcp_user_timeout",
  ]);
  for (const [key, value] of parsed.searchParams) {
    if (!allowedOptions.has(key)) throw new Error("Unsupported PostgreSQL URL option in writer-lock rehearsal");
    env[`PG${key.toUpperCase()}`] = value;
  }
  return env;
}

function command(sql) {
  const output = execFileSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    env: connectionEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line === "t" || line === "f").at(-1) || "";
}

function applyTransactionalSql(filePath) {
  return execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", filePath], {
    env: connectionEnvironment(), encoding: "utf8", stdio: ["ignore", "ignore", "ignore"],
  });
}

function launch() {
  const child = spawn("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
    env: connectionEnvironment(), stdio: ["pipe", "pipe", "ignore"],
  });
  child.output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { child.output += chunk; });
  return child;
}

function waitForLine(child, expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("PostgreSQL lock probe timed out")), timeoutMs);
    const check = () => {
      if (child.output.split(/\r?\n/).includes(expected)) {
        clearTimeout(timeout);
        child.stdout.off("data", check);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.once("error", () => { clearTimeout(timeout); reject(new Error("psql lock probe failed")); });
    child.once("exit", (code) => {
      if (code !== 0) { clearTimeout(timeout); reject(new Error("psql lock probe exited unsuccessfully")); }
    });
    check();
  });
}

function waitExit(child, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("PostgreSQL lock probe did not finish")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error("psql lock probe exited unsuccessfully"));
    });
    child.once("error", () => { clearTimeout(timeout); reject(new Error("psql lock probe failed")); });
  });
}

test("RPC shared writer gate admits concurrent RPCs while excluding the Go writer", { skip: skipReason }, async () => {
  const active = new Set();
  const start = (sql) => {
    const child = launch();
    active.add(child);
    child.once("exit", () => active.delete(child));
    child.stdin.write(sql + "\n");
    return child;
  };
  try {
    assert.equal(command("SELECT pg_get_functiondef('public.ular_writer_available()'::regprocedure) LIKE '%pg_try_advisory_xact_lock_shared%';"), "t", "migration 008 shared gate must be installed");

    // One RPC holds a transaction-level shared gate while it pauses. A second
    // RPC must enter; a distinct session attempting Go's exclusive lock must not.
    const rpc = start("BEGIN;\nSELECT public.ular_writer_available();");
    await waitForLine(rpc, "t");
    assert.equal(command("SELECT public.ular_writer_available();"), "t");
    assert.equal(command("SELECT pg_try_advisory_lock(821471036219);"), "f", "Go exclusive session lock must conflict with active RPC shared lock");
    rpc.stdin.end("SELECT pg_sleep(0.2);\nCOMMIT;\n");
    await waitExit(rpc);

    // A distinct session now holds the same exclusive session lock as Go.
    const goWriter = start("SELECT pg_try_advisory_lock(821471036219);");
    await waitForLine(goWriter, "t");
    assert.equal(command("SELECT public.ular_writer_available();"), "f", "RPC shared gate must fail closed while Go owns the exclusive lock");

    // Reapplying the migration while Go owns the lock must fail before changing
    // the installed function, then the writer can release it normally.
    assert.throws(() => applyTransactionalSql(migrationPath), "migration 008 must refuse to replace the gate while Go owns its lock");
    assert.equal(command("SELECT pg_get_functiondef('public.ular_writer_available()'::regprocedure) LIKE '%pg_try_advisory_xact_lock_shared%';"), "t", "failed migration must leave the installed gate unchanged");

    goWriter.stdin.end("SELECT pg_sleep(0.2);\nSELECT pg_advisory_unlock(821471036219);\n");
    await waitExit(goWriter);
    assert.equal(command("SELECT public.ular_writer_available();"), "t", "RPC gate should reopen after the Go session releases its lock");

    // Exercise the original contention pattern at the gate layer: 30 distinct
    // transactions should acquire shared access together rather than 503 each other.
    const clients = Array.from({ length: 30 }, () => start("BEGIN;\nSELECT public.ular_writer_available();"));
    await Promise.all(clients.map((child) => waitForLine(child, "t")));
    for (const child of clients) child.stdin.end("SELECT pg_sleep(0.15);\nCOMMIT;\n");
    await Promise.all(clients.map((child) => waitExit(child)));

    // The explicit recovery artifact must refuse an active RPC, preserve its
    // shared gate on failure, then restore the former exclusive helper without
    // changing data. The 008 migration must safely return to current behavior.
    const stateQuery = "SELECT version::text || '|' || md5(state::text) FROM public.ular_server_state WHERE id=1;";
    const beforeRecovery = execFileSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", stateQuery], {
      env: connectionEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const activeRpc = start("BEGIN;\nSELECT public.ular_writer_available();");
    await waitForLine(activeRpc, "t");
    assert.throws(() => applyTransactionalSql(recoveryPath), "exclusive-gate recovery must refuse active shared RPCs");
    assert.equal(command("SELECT pg_get_functiondef('public.ular_writer_available()'::regprocedure) LIKE '%pg_try_advisory_xact_lock_shared%';"), "t", "failed recovery must retain the shared gate");
    activeRpc.stdin.end("COMMIT;\n");
    await waitExit(activeRpc);

    applyTransactionalSql(recoveryPath);
    assert.equal(command("SELECT pg_get_functiondef('public.ular_writer_available()'::regprocedure) LIKE '%pg_try_advisory_xact_lock(821471036219)%';"), "t", "recovery must restore the previous exclusive transaction helper");
    assert.equal(command("SELECT pg_get_functiondef('public.ular_writer_available()'::regprocedure) LIKE '%pg_try_advisory_xact_lock_shared%';"), "f");
    const exclusiveRpc = start("BEGIN;\nSELECT public.ular_writer_available();");
    await waitForLine(exclusiveRpc, "t");
    assert.equal(command("SELECT public.ular_writer_available();"), "f", "exclusive recovery gate serializes RPC transactions");
    assert.equal(command("SELECT pg_try_advisory_lock(821471036219);"), "f", "Go session lock remains excluded during recovery mode");
    exclusiveRpc.stdin.end("COMMIT;\n");
    await waitExit(exclusiveRpc);

    applyTransactionalSql(migrationPath);
    assert.equal(command("SELECT pg_get_functiondef('public.ular_writer_available()'::regprocedure) LIKE '%pg_try_advisory_xact_lock_shared%';"), "t", "migration 008 must restore the current shared gate");
    const afterRecovery = execFileSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", stateQuery], {
      env: connectionEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    assert.equal(afterRecovery, beforeRecovery, "round trip must preserve snapshot version and digest");
  } finally {
    for (const child of active) child.kill("SIGTERM");
  }
});
