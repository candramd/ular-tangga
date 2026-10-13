\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
  one jsonb; two jsonb; three jsonb; local_host jsonb; local_room jsonb; online_room jsonb; started jsonb;
  token_one text; token_two text; token_three text; token_local text; room_id text; room_code text; game_id text;
  r jsonb; state_now jsonb; baseline_games jsonb;
BEGIN
  SELECT state->'games' INTO baseline_games FROM public.ular_server_state WHERE id=1;
  -- An online host can leave a waiting room that has no game_id. This was the
  -- reported 006 bug: jsonb - NULL made the whole state snapshot NULL.
  one:=public.ular_api('/auth/guest','POST','{"username":"QA Leave Solo"}'::jsonb,NULL,NULL,'qa-leave-solo-auth');
  token_one:=one->'meta'->>'sessionToken';
  online_room:=public.ular_api('/rooms','POST','{}'::jsonb,token_one,NULL,'qa-leave-solo-room');
  IF online_room->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'solo online room creation failed'; END IF;
  room_id:=online_room->'data'->>'id';
  r:=public.ular_api('/rooms/'||room_id||'/leave','POST','{}'::jsonb,token_one,NULL,'qa-leave-solo-leave');
  IF r->>'ok' IS DISTINCT FROM 'true' OR r->'data'->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'last waiting host could not leave'; END IF;
  SELECT state INTO state_now FROM public.ular_server_state WHERE id=1;
  IF state_now IS NULL OR state_now->'rooms' ? room_id OR jsonb_typeof(state_now->'games') IS DISTINCT FROM 'object' OR state_now->'games' IS DISTINCT FROM baseline_games THEN RAISE EXCEPTION 'waiting-room leave damaged snapshot or unrelated games'; END IF;

  -- A non-host can leave without disturbing the host. A waiting host leaving a
  -- multiplayer room hands ownership to the remaining player, who can then exit.
  one:=public.ular_api('/auth/guest','POST','{"username":"QA Leave Multi Host"}'::jsonb,NULL,NULL,'qa-leave-multi-host-auth'); token_one:=one->'meta'->>'sessionToken';
  two:=public.ular_api('/auth/guest','POST','{"username":"QA Leave Multi Guest"}'::jsonb,NULL,NULL,'qa-leave-multi-guest-auth'); token_two:=two->'meta'->>'sessionToken';
  three:=public.ular_api('/auth/guest','POST','{"username":"QA Leave Multi Final"}'::jsonb,NULL,NULL,'qa-leave-multi-final-auth'); token_three:=three->'meta'->>'sessionToken';
  online_room:=public.ular_api('/rooms','POST','{}'::jsonb,token_one,NULL,'qa-leave-multi-room'); room_id:=online_room->'data'->>'id'; room_code:=online_room->'data'->>'code';
  r:=public.ular_api('/rooms/'||room_code||'/join','POST','{}'::jsonb,token_two,NULL,'qa-leave-multi-join');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'second online player could not join'; END IF;
  r:=public.ular_api('/rooms/'||room_code||'/join','POST','{}'::jsonb,token_three,NULL,'qa-leave-multi-third-join');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'third online player could not join'; END IF;
  r:=public.ular_api('/rooms/'||room_id||'/leave','POST','{}'::jsonb,token_two,NULL,'qa-leave-multi-nonhost-leave');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'non-host could not leave waiting room'; END IF;
  r:=public.ular_api('/rooms/'||room_id,'GET','{}'::jsonb,token_one,NULL,NULL);
  IF r->>'ok' IS DISTINCT FROM 'true' OR r->'data'->>'hostId' IS DISTINCT FROM one->'data'->>'id' OR jsonb_array_length(r->'data'->'players') IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'non-host waiting leave changed the host or remaining roster'; END IF;
  r:=public.ular_api('/rooms/'||room_id||'/leave','POST','{}'::jsonb,token_one,NULL,'qa-leave-multi-host-leave');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'waiting host could not leave multiplayer room'; END IF;
  r:=public.ular_api('/rooms/'||room_id,'GET','{}'::jsonb,token_three,NULL,NULL);
  IF r->>'ok' IS DISTINCT FROM 'true' OR r->'data'->>'hostId' IS DISTINCT FROM three->'data'->>'id' OR jsonb_array_length(r->'data'->'players') IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'waiting-room ownership handoff failed'; END IF;
  r:=public.ular_api('/rooms/'||room_id||'/leave','POST','{}'::jsonb,token_three,NULL,'qa-leave-multi-final-leave');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'last waiting player could not leave'; END IF;

  -- The last active-game player leaves after a prior player departure. The
  -- finished game gets a JSON null winner internally before the room is removed.
  one:=public.ular_api('/auth/guest','POST','{"username":"QA Leave Active Host"}'::jsonb,NULL,NULL,'qa-leave-active-host-auth'); token_one:=one->'meta'->>'sessionToken';
  two:=public.ular_api('/auth/guest','POST','{"username":"QA Leave Active Guest"}'::jsonb,NULL,NULL,'qa-leave-active-guest-auth'); token_two:=two->'meta'->>'sessionToken';
  online_room:=public.ular_api('/rooms','POST','{}'::jsonb,token_one,NULL,'qa-leave-active-room'); room_id:=online_room->'data'->>'id'; room_code:=online_room->'data'->>'code';
  r:=public.ular_api('/rooms/'||room_code||'/join','POST','{}'::jsonb,token_two,NULL,'qa-leave-active-join');
  started:=public.ular_api('/rooms/'||room_id||'/start','POST','{}'::jsonb,token_one,NULL,'qa-leave-active-start');
  IF started->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'active leave fixture did not start'; END IF;
  game_id:=started->'data'->>'id';
  r:=public.ular_api('/rooms/'||room_id||'/leave','POST','{}'::jsonb,token_two,NULL,'qa-leave-active-first');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'first active-game player could not leave'; END IF;
  r:=public.ular_api('/rooms/'||room_id||'/leave','POST','{}'::jsonb,token_one,NULL,'qa-leave-active-last');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'last active-game player could not leave'; END IF;
  SELECT state INTO state_now FROM public.ular_server_state WHERE id=1;
  IF state_now IS NULL OR state_now->'rooms' ? room_id OR state_now->'games' ? game_id OR state_now->'games' IS DISTINCT FROM baseline_games THEN RAISE EXCEPTION 'active room/game was not removed cleanly or unrelated games changed'; END IF;

  -- Child-only local room owner is allowed to exit; it is not a room player.
  local_host:=public.ular_api('/auth/guest','POST','{"username":"QA Local Controller","classroomHost":true}'::jsonb,NULL,NULL,'qa-leave-local-host-auth'); token_local:=local_host->'meta'->>'sessionToken';
  local_room:=public.ular_api('/rooms/local','POST','{"includeHost":false,"names":["QA Child One","QA Child Two"]}'::jsonb,token_local,NULL,'qa-leave-local-create');
  IF local_room->>'ok' IS DISTINCT FROM 'true' OR jsonb_array_length(local_room->'data'->'players') IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'child-only room setup failed'; END IF;
  room_id:=local_room->'data'->>'id';
  r:=public.ular_api('/rooms/'||room_id||'/leave','POST','{}'::jsonb,token_local,NULL,'qa-leave-local-owner');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'non-roster local controller could not leave'; END IF;
  SELECT state INTO state_now FROM public.ular_server_state WHERE id=1;
  IF state_now IS NULL OR state_now->'rooms' ? room_id THEN RAISE EXCEPTION 'local room remained after controller left'; END IF;

  local_room:=public.ular_api('/rooms/local','POST','{"includeHost":false,"names":["QA Active Child A","QA Active Child B"]}'::jsonb,token_local,NULL,'qa-leave-local-active-create');
  room_id:=local_room->'data'->>'id';
  started:=public.ular_api('/rooms/'||room_id||'/start','POST','{}'::jsonb,token_local,NULL,'qa-leave-local-active-start');
  IF started->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'local active leave fixture did not start'; END IF;
  game_id:=started->'data'->>'id';
  r:=public.ular_api('/rooms/'||room_id||'/leave','POST','{}'::jsonb,token_local,NULL,'qa-leave-local-active-owner');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'local controller could not leave active game'; END IF;
  SELECT state INTO state_now FROM public.ular_server_state WHERE id=1;
  IF state_now IS NULL OR state_now->'rooms' ? room_id OR state_now->'games' ? game_id OR state_now->'games' IS DISTINCT FROM baseline_games THEN RAISE EXCEPTION 'local controller leave did not remove only its game'; END IF;
END $$;
ROLLBACK;
