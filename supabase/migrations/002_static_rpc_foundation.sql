-- Additive foundation for the static Supabase RPC. Existing snapshots are kept
-- byte-for-byte unless a later, reviewed RPC call performs an authorized write.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.ular_server_state (
    id integer PRIMARY KEY CHECK (id = 1),
    version integer NOT NULL,
    state jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ular_server_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.ular_server_state FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.ular_server_state TO postgres;

CREATE TABLE IF NOT EXISTS public.ular_room_counters (
    room_id text PRIMARY KEY,
    sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0)
);
CREATE TABLE IF NOT EXISTS public.ular_room_events (
    room_id text NOT NULL,
    sequence bigint NOT NULL CHECK (sequence > 0),
    game_id text,
    event jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (room_id, sequence)
);
CREATE INDEX IF NOT EXISTS ular_room_events_created_at_idx
    ON public.ular_room_events (created_at);

-- Browser bearer tokens are represented by SHA-256 digests in the existing
-- snapshot. Never store plaintext tokens in either this table or the snapshot.
CREATE TABLE IF NOT EXISTS public.ular_game_config (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    board jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.ular_game_config(singleton, board) VALUES (true,
  '{"totalSteps":100,"snakes":{"17":7,"54":34,"62":19,"87":24,"93":73,"98":79},"ladders":{"3":22,"8":30,"20":41,"28":55,"50":69,"71":92}}'::jsonb)
ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ular_rpc_crypto (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    encryption_key text NOT NULL
);
INSERT INTO public.ular_rpc_crypto(singleton,encryption_key) VALUES (true,encode(extensions.gen_random_bytes(32),'hex'))
ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ular_admin_config (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    secret_hash text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.ular_room_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ular_room_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ular_admin_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ular_rpc_crypto ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ular_game_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ular_room_counters, public.ular_room_events, public.ular_admin_config, public.ular_game_config, public.ular_rpc_crypto FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ular_room_counters, public.ular_room_events, public.ular_admin_config, public.ular_game_config, public.ular_rpc_crypto TO postgres;
REVOKE ALL ON public.ular_server_state FROM PUBLIC, anon, authenticated;

-- The transaction lock is shared with the legacy Go single-writer. RPC callers
-- fail closed while Go holds it, preventing competing snapshot writers.
CREATE OR REPLACE FUNCTION public.ular_writer_available()
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT pg_try_advisory_xact_lock(821471036219) $$;
REVOKE ALL ON FUNCTION public.ular_writer_available() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ular_writer_available() TO postgres;

-- Internal event append helper. The row lock and counter update make sequences
-- durable and monotonic per room, even when actions arrive concurrently.
CREATE OR REPLACE FUNCTION public.ular_append_event(p_room_id text, p_game_id text, p_event jsonb)
RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_seq bigint;
BEGIN
  INSERT INTO public.ular_room_counters(room_id, sequence) VALUES (p_room_id, 1)
  ON CONFLICT (room_id) DO UPDATE SET sequence = public.ular_room_counters.sequence + 1
  RETURNING sequence INTO v_seq;
  INSERT INTO public.ular_room_events(room_id, sequence, game_id, event)
  VALUES (p_room_id, v_seq, p_game_id, p_event);
  DELETE FROM public.ular_room_events WHERE room_id=p_room_id AND sequence<=greatest(0,v_seq-1000);
  RETURN v_seq;
END $$;
REVOKE ALL ON FUNCTION public.ular_append_event(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ular_append_event(text, text, jsonb) TO postgres;

-- p_request_id and bearer tokens are arguments in TLS-protected JSON RPC calls;
-- this starter deliberately does not expose the snapshot through PostgREST.
-- The complete dispatcher is installed in a subsequent migration after the
-- route payload adapters have been reviewed against the existing API contract.
COMMENT ON TABLE public.ular_server_state IS
  'Private authoritative Go-compatible JSON snapshot; browser access is RPC-only.';
COMMENT ON TABLE public.ular_room_events IS
  'Private durable per-room event log for polling synchronization RPC.';
