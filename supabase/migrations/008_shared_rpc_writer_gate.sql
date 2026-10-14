-- Allow independent RPC transactions to enter together, then let the existing
-- ular_server_state row lock serialize snapshot reads and writes. The shared
-- advisory lock still conflicts with the legacy Go server's exclusive,
-- session-level pg_try_advisory_lock on the same key, so the writers remain
-- mutually exclusive.
-- Run this migration in the transaction supplied by the Supabase migration
-- runner. The lock remains held through the function replacement and commit.

DO $$
DECLARE
  v_state_version text;
  v_state_digest text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(821471036219) THEN
    RAISE EXCEPTION 'cannot install shared RPC writer gate while the Go writer holds its exclusive lock';
  END IF;

  SELECT version::text, md5(state::text)
    INTO v_state_version, v_state_digest
    FROM public.ular_server_state
    WHERE id = 1
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot install shared RPC writer gate without the current server state row';
  END IF;
  PERFORM set_config('ular.migration008_state_version', v_state_version, true);
  PERFORM set_config('ular.migration008_state_digest', v_state_digest, true);
END
$$;

CREATE OR REPLACE FUNCTION public.ular_writer_available()
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT pg_try_advisory_xact_lock_shared(821471036219) $$;

REVOKE ALL ON FUNCTION public.ular_writer_available() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ular_writer_available() TO postgres;

DO $$
DECLARE
  v_state_version text;
  v_state_digest text;
  v_function_oid oid := 'public.ular_writer_available()'::regprocedure;
  v_public_execute boolean;
BEGIN
  SELECT version::text, md5(state::text)
    INTO v_state_version, v_state_digest
    FROM public.ular_server_state
    WHERE id = 1;

  IF v_state_version IS DISTINCT FROM current_setting('ular.migration008_state_version', true)
     OR v_state_digest IS DISTINCT FROM current_setting('ular.migration008_state_digest', true) THEN
    RAISE EXCEPTION 'server state changed while installing the shared RPC writer gate';
  END IF;
  IF NOT has_function_privilege('postgres', v_function_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_function_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'shared RPC writer gate privileges do not match the expected role policy';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_proc AS p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
      WHERE p.oid = v_function_oid
        AND acl.grantee = 0
        AND acl.privilege_type = 'EXECUTE'
  ) INTO v_public_execute;
  IF v_public_execute THEN
    RAISE EXCEPTION 'PUBLIC must not have EXECUTE on the shared RPC writer gate';
  END IF;
END
$$;
