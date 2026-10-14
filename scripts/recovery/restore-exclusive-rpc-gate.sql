-- Explicit emergency rollback for migration 008 while retaining the Supabase
-- RPC architecture and all current database data. Run only when the
-- single-lock fallback is required, using:
--   psql --set ON_ERROR_STOP=1 --single-transaction --file this-file.sql
-- Do not add this file to supabase/migrations: normal installs must retain the
-- concurrent shared RPC gate from migration 008.

DO $$
DECLARE
  v_function_oid oid := 'public.ular_writer_available()'::regprocedure;
  v_function_definition text;
  v_state_version text;
  v_state_digest text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(821471036219) THEN
    RAISE EXCEPTION 'cannot restore exclusive RPC gate while another writer holds the advisory lock';
  END IF;

  SELECT pg_get_functiondef(v_function_oid) INTO v_function_definition;
  IF position('pg_try_advisory_xact_lock_shared' IN v_function_definition) = 0 THEN
    RAISE EXCEPTION 'exclusive RPC gate recovery requires the migration 008 shared helper';
  END IF;

  SELECT version::text, md5(state::text)
    INTO v_state_version, v_state_digest
    FROM public.ular_server_state
    WHERE id = 1
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot restore exclusive RPC gate without the current server state row';
  END IF;
  PERFORM set_config('ular.recovery_state_version', v_state_version, true);
  PERFORM set_config('ular.recovery_state_digest', v_state_digest, true);
END
$$;

CREATE OR REPLACE FUNCTION public.ular_writer_available()
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT pg_try_advisory_xact_lock(821471036219) $$;

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

  IF v_state_version IS DISTINCT FROM current_setting('ular.recovery_state_version', true)
     OR v_state_digest IS DISTINCT FROM current_setting('ular.recovery_state_digest', true) THEN
    RAISE EXCEPTION 'server state changed while restoring the exclusive RPC gate';
  END IF;
  IF position('pg_try_advisory_xact_lock_shared' IN pg_get_functiondef(v_function_oid)) > 0 THEN
    RAISE EXCEPTION 'exclusive RPC gate helper was not installed';
  END IF;
  IF NOT has_function_privilege('postgres', v_function_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_function_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'exclusive RPC gate privileges do not match the expected role policy';
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
    RAISE EXCEPTION 'PUBLIC must not have EXECUTE on the exclusive RPC gate';
  END IF;
END
$$;
