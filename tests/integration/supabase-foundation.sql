\set ON_ERROR_STOP on
BEGIN;

DO $$
BEGIN
  IF has_table_privilege('anon', 'public.ular_server_state', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ular_server_state', 'SELECT') THEN
    RAISE EXCEPTION 'browser role can select private server state';
  END IF;
  IF has_table_privilege('anon', 'public.ular_room_events', 'SELECT')
     OR has_table_privilege('authenticated', 'public.ular_room_events', 'SELECT') THEN
    RAISE EXCEPTION 'browser role can select private room events';
  END IF;
  IF NOT has_function_privilege('anon', 'public.ular_api(text,text,jsonb,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon role cannot invoke the public RPC';
  END IF;
  IF has_function_privilege('anon', 'public.ular_append_event(text,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon role can invoke an internal event function';
  END IF;
END $$;

SET LOCAL ROLE anon;
DO $$
DECLARE v_denied boolean := false;
BEGIN
  BEGIN
    PERFORM id FROM public.ular_server_state LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'anon direct snapshot read unexpectedly succeeded'; END IF;
END $$;
DO $$
DECLARE
  v_result jsonb;
  v_token text;
  v_user_id text;
BEGIN
  v_result := public.ular_api('/auth/me', 'GET', '{}'::jsonb, NULL, NULL, 'qa-no-session-read');
  IF v_result->>'ok' <> 'false' OR (v_result->>'status')::integer <> 401 THEN
    RAISE EXCEPTION 'missing session did not fail closed';
  END IF;

  v_result := public.ular_api('/auth/guest', 'POST', '{"username":"QA Fixture"}'::jsonb, NULL, NULL, 'qa-fixture-guest-create-001');
  IF v_result->>'ok' <> 'true' OR (v_result->>'status')::integer <> 200 THEN
    RAISE EXCEPTION 'guest fixture creation failed';
  END IF;
  v_token := v_result->'meta'->>'sessionToken';
  v_user_id := v_result->'data'->>'id';
  IF length(v_token) < 32 OR v_user_id IS NULL OR v_result->'data' ? 'answer' THEN
    RAISE EXCEPTION 'guest payload/token shape is unsafe';
  END IF;

  v_result := public.ular_api('/auth/me', 'GET', '{}'::jsonb, v_token, NULL, 'qa-fixture-me-read-001');
  IF v_result->>'ok' <> 'true' OR v_result->'data'->>'id' <> v_user_id THEN
    RAISE EXCEPTION 'opaque session did not authorize its owner';
  END IF;
  v_result := public.ular_api('/auth/me', 'GET', '{}'::jsonb, repeat('x', 48), NULL, 'qa-fixture-invalid-token');
  IF v_result->>'ok' <> 'false' OR (v_result->>'status')::integer <> 401 THEN
    RAISE EXCEPTION 'invalid session did not fail closed';
  END IF;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
DECLARE v_denied boolean := false;
BEGIN
  BEGIN
    PERFORM id FROM public.ular_server_state LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'authenticated direct snapshot read unexpectedly succeeded'; END IF;
END $$;
RESET ROLE;

DO $$
DECLARE
  v_state jsonb;
BEGIN
  SELECT state INTO v_state FROM public.ular_server_state WHERE id=1;
  IF v_state IS NULL OR v_state->'sessions' IS NULL THEN
    RAISE EXCEPTION 'expected fixture state row was not written';
  END IF;
  IF v_state::text LIKE '%qa-fixture-guest-create-001%' THEN
    RAISE EXCEPTION 'request metadata leaked into persisted state';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(v_state->'sessions') s WHERE s.key !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'session key is not a SHA-256 digest';
  END IF;
END $$;

ROLLBACK;
