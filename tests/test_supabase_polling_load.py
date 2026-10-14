from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import rehearse_supabase_polling_load as harness


class PollingHarnessUnitTests(unittest.TestCase):
    def test_host_must_be_numeric_loopback(self):
        self.assertEqual(harness.numeric_loopback("127.0.0.1"), "127.0.0.1")
        self.assertEqual(harness.numeric_loopback("::1"), "::1")
        for value in ("localhost", "example.com", "192.0.2.1"):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                harness.numeric_loopback(value)

    def test_libpq_environment_discards_ambient_routing_and_password(self):
        with patch.dict(os.environ, {
            "PGHOSTADDR": "203.0.113.9", "PGSERVICE": "untrusted-service",
            "PGSERVICEFILE": "/tmp/untrusted-service.conf", "PGPASSWORD": "ambient-secret",
        }, clear=False):
            env = harness.libpq_env("127.0.0.1", 15432, "postgres", "postgres")
        self.assertEqual(env["PGHOST"], "127.0.0.1")
        self.assertEqual(env["PGPORT"], "15432")
        self.assertEqual(env["PGDATABASE"], "postgres")
        for key in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"):
            self.assertNotIn(key, env)
        self.assertNotIn("PGPASSWORD", env)

    def test_unauthenticated_error_envelope_is_checked(self):
        harness.check_envelope({"ok": False, "status": 401, "error": {"code": "UNAUTHORIZED"}}, "UNAUTHORIZED")
        with self.assertRaises(RuntimeError):
            harness.check_envelope({"ok": True, "status": 200}, "UNAUTHORIZED")

    def test_poll_summary_keeps_error_counts_and_computes_percentile(self):
        result = harness.summarize("active", 6.0, 6.0, 1.2, 30, [10, 20, 30, 40], [10, 20], {"SERVICE_UNAVAILABLE": 3}, [1200], staggered=False)
        self.assertEqual(result["request_attempts"], 4)
        self.assertEqual(result["successful_rpc_calls"], 2)
        self.assertEqual(result["envelope_errors"], 3)
        self.assertEqual(result["envelope_errors_by_code"]["SERVICE_UNAVAILABLE"], 3)
        self.assertEqual(result["attempt_latency_ms_all_responses_and_client_errors"]["p95"], 40)
        self.assertEqual(result["ideal_target_calls_upper_bound"], 150)
        self.assertEqual(result["missed_polls_vs_ideal_upper_bound"], 146)

    def test_staggered_target_uses_configured_window_and_offset(self):
        result = harness.summarize("stagger", 6.1, 6.0, 1.2, 30, [], [], {}, [], staggered=True)
        self.assertEqual(result["ideal_target_calls_upper_bound"], 150)


@unittest.skipUnless(os.environ.get("RUN_LOCAL_POLLING_DB_TESTS") == "1", "requires explicit local PostgreSQL 127.0.0.1:15432")
class PollingHarnessLocalDbTests(unittest.TestCase):
    def db_names(self):
        env = harness.libpq_env("127.0.0.1", 15432, "postgres", "postgres")
        out = harness.psql("postgres", "SELECT datname FROM pg_database WHERE datname LIKE 'ular_polling_%' ORDER BY datname;", env=env, capture=True)
        return set(filter(None, out.splitlines()))

    def test_failure_after_database_create_drops_only_its_disposable_db(self):
        before = self.db_names()
        proc = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "rehearse_supabase_polling_load.py"),
             "--host", "127.0.0.1", "--port", "15432", "--user", "postgres",
             "--maintenance-db", "postgres", "--duration-seconds", "30", "--inject-failure-after-create"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("injected test failure", proc.stderr)
        self.assertEqual(self.db_names(), before)


if __name__ == "__main__":
    unittest.main()
