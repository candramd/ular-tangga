-- Supabase PostgreSQL migration for the backend's single-row JSON snapshot.
-- Safe to re-run. The backend connects as the server-only `postgres` role;
-- browser-facing Supabase roles receive no access to persisted game/session data.
CREATE TABLE IF NOT EXISTS public.ular_server_state (
    id integer PRIMARY KEY CHECK (id = 1),
    version integer NOT NULL,
    state jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ular_server_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.ular_server_state FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.ular_server_state TO postgres;
