\set ON_ERROR_STOP on
BEGIN;
\ir supabase-teacher-bank-fixture.sql
CREATE TEMP TABLE ux_renew_tokens(token text);
CREATE TEMP TABLE ux_existing_users(token text,user_id text);
GRANT INSERT,SELECT ON ux_renew_tokens TO anon;
GRANT INSERT,SELECT ON ux_existing_users TO anon;
DO $$ DECLARE v_login jsonb; v_id text; BEGIN
  v_login:=public.ular_api('/auth/guest','POST','{"username":"UX Existing Scorer"}'::jsonb,NULL,NULL,'fixture-ux-existing-score-001');
  IF v_login->>'ok' IS DISTINCT FROM 'true' OR v_login->'data'->>'id' IS NULL OR v_login->'meta'->>'sessionToken' IS NULL THEN RAISE EXCEPTION 'could not create legacy scorer fixture'; END IF;
  v_id:=v_login->'data'->>'id';
  UPDATE public.ular_server_state SET state=jsonb_set(state,ARRAY['stats',v_id],'{"gamesPlayed":4,"wins":2,"correctAnswers":7,"wrongAnswers":1,"timeouts":0}'::jsonb,true) WHERE id=1;
  INSERT INTO ux_existing_users VALUES(v_login->'meta'->>'sessionToken',v_id);
END $$;
SET LOCAL ROLE anon;
DO $$
DECLARE
  host_login jsonb; host_token text; host_id text; room_result jsonb; room_id text;
  game_result jsonb; game_id text; game_state jsonb; child_id text; action_result jsonb;
  result jsonb; same_id text; leaderboard jsonb; before_profile jsonb; renew_login jsonb; legacy_login jsonb; legacy_token text; legacy_id text; legacy_room jsonb; legacy_room_id text; legacy_game jsonb; legacy_game_id text; legacy_player_id text;
BEGIN
  host_login:=public.ular_api('/auth/guest','POST','{"username":"UX Fixture Teacher","classroomHost":true}'::jsonb,NULL,NULL,'fixture-ux-host-session-001');
  IF host_login->>'ok' IS DISTINCT FROM 'true' OR host_login->'data'->>'classroomHost' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'classroom host guest session failed'; END IF;
  host_token:=host_login->'meta'->>'sessionToken'; host_id:=host_login->'data'->>'id';
  renew_login:=public.ular_api('/auth/guest','POST','{"username":"UX Renewal Fixture"}'::jsonb,NULL,NULL,'fixture-ux-renew-session-001');
  IF renew_login->>'ok' IS DISTINCT FROM 'true' OR renew_login->'meta'->>'sessionToken' IS NULL THEN RAISE EXCEPTION 'could not create renewal fixture'; END IF;
  INSERT INTO ux_renew_tokens VALUES(renew_login->'meta'->>'sessionToken');

  room_result:=public.ular_api('/rooms/local','POST','{"names":["UX Fixture A","UX Fixture B"],"includeHost":false}'::jsonb,host_token,NULL,'fixture-ux-local-room-001');
  IF room_result->>'ok' IS DISTINCT FROM 'true' OR jsonb_typeof(room_result->'data'->'players') IS DISTINCT FROM 'array' OR jsonb_array_length(room_result->'data'->'players')<>2 THEN RAISE EXCEPTION 'child-only room creation failed'; END IF;
  room_id:=room_result->'data'->>'id';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(room_result->'data'->'players') p WHERE p->>'id'=host_id) THEN RAISE EXCEPTION 'teacher was included as a child player'; END IF;
  IF (public.ular_api('/rooms/local','POST','{"names":["Other A","Other B"],"includeHost":false}'::jsonb,host_token,NULL,'fixture-ux-local-room-conflict')->>'status') IS DISTINCT FROM '409' THEN RAISE EXCEPTION 'host could create a second active room without leaving'; END IF;

  legacy_login:=public.ular_api('/auth/guest','POST','{"username":"UX Legacy Fixture"}'::jsonb,NULL,NULL,'fixture-ux-legacy-session-001');
  legacy_token:=legacy_login->'meta'->>'sessionToken'; legacy_id:=legacy_login->'data'->>'id';
  legacy_room:=public.ular_api('/rooms/local','POST','{"players":["UX Legacy Child"]}'::jsonb,legacy_token,NULL,'fixture-ux-legacy-room-001');
  IF legacy_room->>'ok' IS DISTINCT FROM 'true' OR jsonb_typeof(legacy_room->'data'->'players') IS DISTINCT FROM 'array' OR jsonb_array_length(legacy_room->'data'->'players')<>2 OR legacy_room->'data'->'players'->0->>'id' IS DISTINCT FROM legacy_id THEN RAISE EXCEPTION 'default local-room behavior no longer includes host'; END IF;
  legacy_room_id:=legacy_room->'data'->>'id';
  legacy_game:=public.ular_api('/rooms/'||legacy_room_id||'/start','POST','{}'::jsonb,legacy_token,NULL,'fixture-ux-legacy-start-001');
  legacy_game_id:=legacy_game->'data'->>'id'; legacy_player_id:=legacy_game->'data'->'currentPlayerId'->>0;
  before_profile:=public.ular_api('/profile','GET','{}'::jsonb,legacy_token,NULL,NULL)->'data';
  result:=public.ular_api('/profile','PATCH','{"username":"UX Legacy Renamed"}'::jsonb,legacy_token,NULL,'fixture-ux-legacy-rename-001');
  IF result->>'ok' IS DISTINCT FROM 'true' OR result->'data'->>'id' IS DISTINCT FROM legacy_id THEN RAISE EXCEPTION 'legacy profile rename replaced identity'; END IF;
  result:=public.ular_api('/rooms/'||legacy_room_id,'GET','{}'::jsonb,legacy_token,NULL,NULL);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'data'->'players') p WHERE p->>'id'=legacy_id AND p->>'username'='UX Legacy Renamed') THEN RAISE EXCEPTION 'rename did not update embedded room players'; END IF;
  result:=public.ular_api('/games/'||legacy_game_id||'/state','GET','{}'::jsonb,legacy_token,NULL,NULL);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'data'->'players') p WHERE p->>'id'=legacy_id AND p->>'username'='UX Legacy Renamed') THEN RAISE EXCEPTION 'rename did not update embedded game players'; END IF;
  IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'legacy game view read failed'; END IF;
  result:=public.ular_api('/profile','GET','{}'::jsonb,legacy_token,NULL,NULL);
  IF jsonb_typeof(before_profile->'stats') IS DISTINCT FROM 'object' OR jsonb_typeof(result->'data'->'stats') IS DISTINCT FROM 'object' OR result->'data'->'stats' IS DISTINCT FROM before_profile->'stats' THEN RAISE EXCEPTION 'profile rename changed or omitted existing stats'; END IF;

  result:=public.ular_api('/rooms/current','GET','{}'::jsonb,host_token,NULL,NULL);
  IF result->>'ok' IS DISTINCT FROM 'true' OR result->'data'->>'id' IS DISTINCT FROM room_id THEN RAISE EXCEPTION 'non-playing host could not restore current room'; END IF;
  result:=public.ular_api('/rooms/'||room_id,'GET','{}'::jsonb,host_token,NULL,NULL);
  IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'non-playing host could not read room'; END IF;
  result:=public.ular_api('/rooms/'||room_id||'/sync','POST','{"afterSequence":0}'::jsonb,host_token,NULL,'fixture-ux-sync-001');
  IF result->>'ok' IS DISTINCT FROM 'true' OR result->'data'->>'room' IS NULL THEN RAISE EXCEPTION 'non-playing host could not sync room'; END IF;

  game_result:=public.ular_api('/rooms/'||room_id||'/start','POST','{}'::jsonb,host_token,NULL,'fixture-ux-start-game-001');
  IF game_result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'non-playing host could not start child game: %',game_result->'error'->>'code'; END IF;
  game_id:=game_result->'data'->>'id'; child_id:=game_result->'data'->>'currentPlayerId';
  IF child_id IS NULL OR child_id=host_id OR jsonb_typeof(game_result->'data'->'players') IS DISTINCT FROM 'array' OR jsonb_array_length(game_result->'data'->'players') IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'started game roster contains wrong identities'; END IF;

  result:=public.ular_api('/rooms/'||room_id,'GET','{}'::jsonb,host_token,NULL,NULL);
  IF result->'data'->>'mode' IS DISTINCT FROM 'local' OR result->'data'->>'hostId' IS DISTINCT FROM host_id OR jsonb_typeof(result->'data'->'players') IS DISTINCT FROM 'array' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(result->'data'->'players','[]'::jsonb)) p WHERE p->>'id'=child_id) THEN RAISE EXCEPTION 'room fixture mismatch mode=% hostMatch=% childMatch=% gameChild=% host=%',result->'data'->>'mode',(result->'data'->>'hostId'=host_id),EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(result->'data'->'players','[]'::jsonb)) p WHERE p->>'id'=child_id),child_id,host_id; END IF;
  action_result:=public.ular_api('/games/'||game_id||'/question/answer','POST',jsonb_build_object('questionId',game_result->'data'->'question'->>'id','answer',999,'playerId',host_id),host_token,NULL,'fixture-ux-host-as-child-001');
  IF action_result->>'status' IS DISTINCT FROM '403' THEN RAISE EXCEPTION 'host was permitted to answer as its non-roster identity'; END IF;
  action_result:=public.ular_api('/games/'||game_id||'/question/answer','POST',jsonb_build_object('questionId',game_result->'data'->'question'->>'id','answer',999,'playerId',child_id),host_token,NULL,'fixture-ux-child-action-001');
  IF action_result->>'status' IS DISTINCT FROM '400' THEN RAISE EXCEPTION 'host could not act for roster child, got %/%',action_result->>'status',action_result->'error'->>'code'; END IF;

  before_profile:=public.ular_api('/profile','GET','{}'::jsonb,host_token,NULL,NULL)->'data'; same_id:=before_profile->>'id';
  result:=public.ular_api('/profile','PATCH','{"username":"UX Teacher Renamed"}'::jsonb,host_token,NULL,'fixture-ux-profile-rename-001');
  IF result->>'ok' IS DISTINCT FROM 'true' OR result->'data'->>'id' IS DISTINCT FROM same_id OR result->'data'->>'username' IS DISTINCT FROM 'UX Teacher Renamed' OR result->'data'->>'classroomHost' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'rename changed identity, lost host flag, or failed'; END IF;
  game_state:=public.ular_api('/profile','PATCH','{"username":"UX Teacher Renamed"}'::jsonb,host_token,NULL,'fixture-ux-profile-rename-001');
  IF game_state IS DISTINCT FROM result THEN RAISE EXCEPTION 'profile retry was not idempotent'; END IF;
  game_state:=public.ular_api('/profile','PATCH','{"username":"Different Payload"}'::jsonb,host_token,NULL,'fixture-ux-profile-rename-001');
  IF game_state->>'status' IS DISTINCT FROM '409' THEN RAISE EXCEPTION 'profile requestId payload conflict was not rejected'; END IF;
  result:=public.ular_api('/rooms/'||room_id,'GET','{}'::jsonb,host_token,NULL,NULL);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'data'->'players') p WHERE p->>'id'=child_id) THEN RAISE EXCEPTION 'renaming host damaged the child roster'; END IF;
  leaderboard:=public.ular_api('/leaderboard','GET','{}'::jsonb,host_token,NULL,NULL)->'data';
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(leaderboard) p WHERE p->>'id'=host_id) THEN RAISE EXCEPTION 'classroom-only host appeared in leaderboard'; END IF;
  result:=public.ular_api('/profile','PATCH','{"becomePlayer":true}'::jsonb,host_token,NULL,'fixture-ux-promote-001');
  IF result->>'ok' IS DISTINCT FROM 'true' OR result->'data'->>'id' IS DISTINCT FROM same_id OR result->'data'->>'classroomHost' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'promotion replaced identity or retained classroom-host flag'; END IF;
  leaderboard:=public.ular_api('/leaderboard','GET','{}'::jsonb,host_token,NULL,NULL)->'data';
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(leaderboard) p WHERE p->>'id'=host_id) THEN RAISE EXCEPTION 'promoted user was not restored to leaderboard'; END IF;

  result:=public.ular_api('/leaderboard','GET','{}'::jsonb,(SELECT token FROM ux_existing_users LIMIT 1),NULL,NULL);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'data') p WHERE p->>'id'=(SELECT user_id FROM ux_existing_users LIMIT 1) AND (p->>'correctAnswers')::integer=7) THEN RAISE EXCEPTION 'legacy scorer disappeared or lost score'; END IF;
  room_result:=public.ular_api('/rooms/local','POST','{"names":["UX Existing Child A","UX Existing Child B"],"includeHost":false}'::jsonb,(SELECT token FROM ux_existing_users LIMIT 1),NULL,'fixture-ux-existing-childroom-001');
  IF room_result->>'ok' IS DISTINCT FROM 'true' OR jsonb_typeof(room_result->'data'->'players') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(room_result->'data'->'players','[]'::jsonb)) p WHERE p->>'id'=(SELECT user_id FROM ux_existing_users LIMIT 1)) THEN RAISE EXCEPTION 'existing scorer could not create child-only room'; END IF;
  result:=public.ular_api('/leaderboard','GET','{}'::jsonb,(SELECT token FROM ux_existing_users LIMIT 1),NULL,NULL);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'data') p WHERE p->>'id'=(SELECT user_id FROM ux_existing_users LIMIT 1) AND (p->>'correctAnswers')::integer=7) THEN RAISE EXCEPTION 'child-only room changed an existing score or hid its identity'; END IF;

  result:=public.ular_api('/auth/logout','POST','{}'::jsonb,host_token,NULL,'fixture-ux-logout-001');
  IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'logout failed'; END IF;
  game_state:=public.ular_api('/auth/logout','POST','{}'::jsonb,host_token,NULL,'fixture-ux-logout-001');
  IF game_state IS DISTINCT FROM result THEN RAISE EXCEPTION 'logout retry was not idempotent'; END IF;
  game_state:=public.ular_api('/auth/logout','POST','{"unexpected":true}'::jsonb,host_token,NULL,'fixture-ux-logout-001');
  IF game_state->>'status' IS DISTINCT FROM '409' THEN RAISE EXCEPTION 'logout requestId payload conflict was not rejected'; END IF;
  result:=public.ular_api('/auth/me','GET','{}'::jsonb,host_token,NULL,NULL);
  IF result->>'status' IS DISTINCT FROM '401' THEN RAISE EXCEPTION 'revoked session remains usable'; END IF;
END $$;
RESET ROLE;
DO $$
DECLARE v_token text; v_hash text; v_result jsonb; v_state jsonb; v_exp timestamptz;
BEGIN
  SELECT token INTO v_token FROM ux_renew_tokens LIMIT 1;
  v_hash:=encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex');
  UPDATE public.ular_server_state SET state=jsonb_set(state,ARRAY['sessions',v_hash,'expires'],to_jsonb(clock_timestamp()+interval '13 days'),true) WHERE id=1;
  v_result:=public.ular_api('/auth/me','GET','{}'::jsonb,v_token,NULL,NULL);
  IF v_result->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'valid near-expiry session did not renew'; END IF;
  SELECT (state->'sessions'->v_hash->>'expires')::timestamptz INTO v_exp FROM public.ular_server_state WHERE id=1;
  IF v_exp<=clock_timestamp()+interval '29 days' THEN RAISE EXCEPTION 'near-expiry session was not extended to 30 days'; END IF;
  UPDATE public.ular_server_state SET state=jsonb_set(state,ARRAY['sessions',v_hash,'expires'],to_jsonb(clock_timestamp()-interval '1 day'),true) WHERE id=1;
  v_result:=public.ular_api('/auth/me','GET','{}'::jsonb,v_token,NULL,NULL);
  IF v_result->>'status' IS DISTINCT FROM '401' THEN RAISE EXCEPTION 'expired session was revived'; END IF;
  SELECT (state->'sessions'->v_hash->>'expires')::timestamptz INTO v_exp FROM public.ular_server_state WHERE id=1;
  IF v_exp>=clock_timestamp() THEN RAISE EXCEPTION 'expired session expiry was advanced'; END IF;
END $$;
DO $$
DECLARE v_state jsonb; v_host text;
BEGIN
  SELECT state INTO v_state FROM public.ular_server_state WHERE id=1;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each(v_state->'users') u WHERE u.value->>'username'='UX Teacher Renamed') THEN RAISE EXCEPTION 'logout deleted guest user'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each(v_state->'stats') s WHERE s.key IN (SELECT key FROM jsonb_each(v_state->'users') u WHERE u.value->>'username'='UX Teacher Renamed')) THEN RAISE EXCEPTION 'logout deleted score counters'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each(v_state->'rooms') r WHERE r.value->>'mode'='local' AND r.value->>'hostId' IN (SELECT key FROM jsonb_each(v_state->'users') u WHERE u.value->>'username'='UX Teacher Renamed')) THEN RAISE EXCEPTION 'logout unexpectedly deleted active room'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(v_state->'sessions') s WHERE s.value->>'userId' IN (SELECT key FROM jsonb_each(v_state->'users') u WHERE u.value->>'username'='UX Teacher Renamed')) THEN RAISE EXCEPTION 'logout did not revoke the matching session'; END IF;
END $$;
ROLLBACK;
