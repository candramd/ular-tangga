-- Run only against a disposable PostgreSQL fixture after all migrations.
-- The fixture supplies auth.users/auth.uid(); never use production.
BEGIN;
INSERT INTO auth.users(id,email,email_confirmed_at,raw_app_meta_data,is_anonymous,encrypted_password) VALUES
('10000000-0000-4000-8000-000000000001','teacher-a@accounts.ular-tangga.invalid',clock_timestamp(),'{"provider":"email"}',false,'bcrypt-fixture'),
('10000000-0000-4000-8000-000000000002','teacher-b@accounts.ular-tangga.invalid',clock_timestamp(),'{"provider":"email"}',false,'bcrypt-fixture'),
('10000000-0000-4000-8000-000000000003','student@accounts.ular-tangga.invalid',clock_timestamp(),'{"provider":"email"}',false,'bcrypt-fixture'),
('10000000-0000-4000-8000-000000000004','teacher-c@accounts.ular-tangga.invalid',NULL,'{"provider":"email"}',false,'bcrypt-fixture'),
('10000000-0000-4000-8000-000000000005','outside@example.test',clock_timestamp(),'{"provider":"email"}',false,'bcrypt-fixture'),
('10000000-0000-4000-8000-000000000006','anonymous@accounts.ular-tangga.invalid',clock_timestamp(),'{"provider":"email"}',true,NULL),
('10000000-0000-4000-8000-000000000007','oauth@accounts.ular-tangga.invalid',clock_timestamp(),'{"provider":"google"}',false,NULL),
('10000000-0000-4000-8000-000000000008','no-password@accounts.ular-tangga.invalid',clock_timestamp(),'{"provider":"email"}',false,NULL)
ON CONFLICT(id) DO NOTHING;
INSERT INTO public.ular_teacher_roles(user_id,role,active) VALUES ('10000000-0000-4000-8000-000000000003','student',true)
ON CONFLICT(user_id) DO UPDATE SET role='student',active=true;
UPDATE public.ular_server_state SET state=jsonb_set(state,'{questions}','{"legacy-fixture":{"id":"legacy-fixture","question":"Legacy shared question?","options":["Yes","No"],"answer":0,"explanation":"legacy answer","category":"Legacy","difficulty":"mudah","timeLimit":30,"active":true}}'::jsonb,true) WHERE id=1;
CREATE TEMP TABLE teacher_token_fixture(token text);
CREATE TEMP TABLE guest_fixture(seq integer,id text,token text);
CREATE TEMP TABLE game_fixture(kind text,id text);
CREATE TEMP TABLE cached_start_fixture(room_id text);
GRANT SELECT,INSERT ON teacher_token_fixture,guest_fixture,game_fixture,cached_start_fixture TO anon;
SET LOCAL ROLE anon;
DO $$
DECLARE
  a uuid:='10000000-0000-4000-8000-000000000001'; b uuid:='10000000-0000-4000-8000-000000000002'; s uuid:='10000000-0000-4000-8000-000000000003'; c uuid:='10000000-0000-4000-8000-000000000004'; bad_domain uuid:='10000000-0000-4000-8000-000000000005'; anonymous_user uuid:='10000000-0000-4000-8000-000000000006'; oauth_user uuid:='10000000-0000-4000-8000-000000000007'; no_password uuid:='10000000-0000-4000-8000-000000000008';
  result jsonb; replay jsonb; question_id text; token_a text; token_b text; payload jsonb;
BEGIN
  result:=public.ular_api('/admin/session','POST','{"secret":"legacy-secret"}'::jsonb,NULL,NULL,'fixture-disabled-admin-route-01');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>404 THEN RAISE EXCEPTION 'legacy admin login is still active'; END IF;

  PERFORM set_config('request.jwt.claim.sub',a::text,true);
  result:=public.ular_api('/teacher/session','POST','{"role":"admin"}'::jsonb,NULL,NULL,'fixture-teacher-session-a-001');
  IF result->>'ok'<>'true' OR result->'data'->>'id'<>a::text OR result->'data'->>'teacherRole'<>'teacher' THEN RAISE EXCEPTION 'forged role changed the trusted account identity'; END IF;
  token_a:=result->'meta'->>'sessionToken';
  INSERT INTO teacher_token_fixture VALUES(token_a);
  payload:='{"question":"Owned by A?","options":["Yes","No"],"answer":0,"explanation":"private answer","category":"Fixture","difficulty":"mudah","timeLimit":30,"active":true}'::jsonb;
  result:=public.ular_api('/teacher/questions','POST',payload,token_a,NULL,'fixture-question-create-a-001');
  IF result->>'ok'<>'true' THEN RAISE EXCEPTION 'teacher A question creation failed: %',result->'error'; END IF;
  question_id:=result->'data'->>'id';
  replay:=public.ular_api('/teacher/questions','POST',payload,token_a,NULL,'fixture-question-create-a-001');
  IF replay->'data'->>'id' IS DISTINCT FROM question_id THEN RAISE EXCEPTION 'retried question create was not idempotent'; END IF;
  replay:=public.ular_api('/teacher/questions','POST',payload||'{"question":"Different payload?"}'::jsonb,token_a,NULL,'fixture-question-create-a-001');
  IF replay->>'ok'<>'false' OR (replay->>'status')::integer<>409 THEN RAISE EXCEPTION 'question request id accepted a different payload'; END IF;

  PERFORM set_config('request.jwt.claim.sub',b::text,true);
  result:=public.ular_api('/teacher/session','POST','{}'::jsonb,NULL,NULL,'fixture-teacher-session-b-001');
  IF result->>'ok'<>'true' THEN RAISE EXCEPTION 'teacher B session creation failed'; END IF;
  token_b:=result->'meta'->>'sessionToken';
  result:=public.ular_api('/teacher/questions','GET','{}'::jsonb,token_b,NULL,NULL);
  IF result->>'ok'<>'true' OR jsonb_array_length(result->'data'->'questions')<>0 THEN RAISE EXCEPTION 'teacher B can read teacher A bank'; END IF;
  result:=public.ular_api('/teacher/questions/'||question_id,'DELETE','{}'::jsonb,token_b,NULL,'fixture-cross-tenant-delete-001');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>404 THEN RAISE EXCEPTION 'teacher B can mutate teacher A question'; END IF;
  result:=public.ular_api('/auth/me','GET','{}'::jsonb,token_a,NULL,NULL);
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>401 THEN RAISE EXCEPTION 'teacher B can use teacher A opaque session'; END IF;
  result:=public.ular_api('/auth/logout','POST','{}'::jsonb,token_a,NULL,'fixture-cross-account-logout-001');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>401 THEN RAISE EXCEPTION 'teacher B can revoke teacher A session: %',result; END IF;

  PERFORM set_config('request.jwt.claim.sub',s::text,true);
  result:=public.ular_api('/teacher/session','POST','{}'::jsonb,NULL,NULL,'fixture-student-teacher-denied-1');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>403 THEN RAISE EXCEPTION 'student role received teacher session'; END IF;
  PERFORM set_config('request.jwt.claim.sub',c::text,true);
  result:=public.ular_api('/teacher/session','POST','{}'::jsonb,NULL,NULL,'fixture-autoconfirm-independent-user-01');
  IF result->>'ok'<>'true' THEN RAISE EXCEPTION 'valid password username account was incorrectly gated on email confirmation'; END IF;
  PERFORM set_config('request.jwt.claim.sub',bad_domain::text,true);
  result:=public.ular_api('/teacher/session','POST','{}'::jsonb,NULL,NULL,'fixture-non-username-account-denied1');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>403 THEN RAISE EXCEPTION 'account outside the username adapter namespace received teacher access'; END IF;
  PERFORM set_config('request.jwt.claim.sub',anonymous_user::text,true);
  result:=public.ular_api('/teacher/session','POST','{}'::jsonb,NULL,NULL,'fixture-anonymous-account-denied1');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>403 THEN RAISE EXCEPTION 'anonymous Auth account received teacher access'; END IF;
  PERFORM set_config('request.jwt.claim.sub',oauth_user::text,true);
  result:=public.ular_api('/teacher/session','POST','{}'::jsonb,NULL,NULL,'fixture-oauth-account-denied01');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>403 THEN RAISE EXCEPTION 'non-password Auth provider received teacher access'; END IF;
  PERFORM set_config('request.jwt.claim.sub',no_password::text,true);
  result:=public.ular_api('/teacher/session','POST','{}'::jsonb,NULL,NULL,'fixture-no-password-account-denied1');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>403 THEN RAISE EXCEPTION 'Auth account without password credential received teacher access'; END IF;

  PERFORM set_config('request.jwt.claim.sub',a::text,true);
  result:=public.ular_api('/auth/guest','POST','{"username":"Public Host"}'::jsonb,NULL,NULL,'fixture-public-host-session-001');
  INSERT INTO guest_fixture VALUES(1,result->'data'->>'id',result->'meta'->>'sessionToken');
  result:=public.ular_api('/rooms','POST','{"isPublic":true}'::jsonb,(SELECT token FROM guest_fixture WHERE seq=1),NULL,'fixture-public-room-create-001');
  IF result->>'ok'<>'true' THEN RAISE EXCEPTION 'guest public room creation failed: %',result->'error'; END IF;
  payload:=jsonb_build_object('roomId',result->'data'->>'id','code',result->'data'->>'code');
  result:=public.ular_api('/auth/guest','POST','{"username":"Public Player"}'::jsonb,NULL,NULL,'fixture-public-player-session-001');
  INSERT INTO guest_fixture VALUES(2,result->'data'->>'id',result->'meta'->>'sessionToken');
  result:=public.ular_api('/rooms/'||(payload->>'code')||'/join','POST','{}'::jsonb,(SELECT token FROM guest_fixture WHERE seq=2),NULL,'fixture-public-player-join-001');
  IF result->>'ok'<>'true' OR jsonb_array_length(result->'data'->'players')<>2 THEN RAISE EXCEPTION 'public room roster did not contain exactly its two joined players'; END IF;
  result:=public.ular_api('/rooms/'||(payload->>'roomId')||'/start','POST','{}'::jsonb,(SELECT token FROM guest_fixture WHERE seq=1),NULL,'fixture-public-room-start-001');
  IF result->>'ok'<>'true' OR jsonb_array_length(result->'data'->'players')<>2 THEN RAISE EXCEPTION 'public game snapshot included unrelated or synthetic players'; END IF;
  IF result->'data'->'question' ? 'answer' OR result->'data'->'question' ? 'answerIndex' THEN RAISE EXCEPTION 'public game response exposed an answer'; END IF;
  INSERT INTO game_fixture VALUES('shared',result->'data'->>'id');

  result:=public.ular_api('/rooms','POST','{"isPublic":true}'::jsonb,token_a,NULL,'fixture-teacher-a-room-create-01');
  IF result->>'ok'<>'true' OR result->'data'->>'teacherId'<>a::text THEN RAISE EXCEPTION 'teacher room was not bound to the authenticated account'; END IF;
  payload:=jsonb_build_object('roomId',result->'data'->>'id','code',result->'data'->>'code');
  INSERT INTO cached_start_fixture VALUES(payload->>'roomId');
  result:=public.ular_api('/auth/guest','POST','{"username":"Teacher A Student"}'::jsonb,NULL,NULL,'fixture-teacher-a-student-session-1');
  INSERT INTO guest_fixture VALUES(3,result->'data'->>'id',result->'meta'->>'sessionToken');
  result:=public.ular_api('/rooms/'||(payload->>'code')||'/join','POST','{}'::jsonb,(SELECT token FROM guest_fixture WHERE seq=3),NULL,'fixture-teacher-a-student-join-01');
  IF result->>'ok'<>'true' THEN RAISE EXCEPTION 'student could not join teacher room'; END IF;
  result:=public.ular_api('/rooms/'||(payload->>'roomId')||'/start','POST','{}'::jsonb,token_a,NULL,'fixture-teacher-a-room-start-01');
  IF result->>'ok'<>'true' OR jsonb_array_length(result->'data'->'players')<>2 THEN RAISE EXCEPTION 'teacher room start did not snapshot its two actual participants'; END IF;
  INSERT INTO game_fixture VALUES('owned',result->'data'->>'id');
  replay:=public.ular_api('/rooms/'||(SELECT room_id FROM cached_start_fixture)||'/start','POST','{}'::jsonb,token_a,NULL,'fixture-teacher-a-room-start-01');
  IF replay->>'ok'<>'true' OR replay->'data'->>'id' IS DISTINCT FROM result->'data'->>'id' THEN RAISE EXCEPTION 'valid teacher room-start retry was not idempotent'; END IF;
  PERFORM set_config('request.jwt.claim.sub',b::text,true);
  replay:=public.ular_api('/rooms/'||(SELECT room_id FROM cached_start_fixture)||'/start','POST','{}'::jsonb,token_a,NULL,'fixture-teacher-a-room-start-01');
  IF replay->>'ok'<>'false' OR (replay->>'status')::integer<>401 THEN RAISE EXCEPTION 'teacher B replayed teacher A cached room-start response'; END IF;
  PERFORM set_config('request.jwt.claim.sub','',true);
  replay:=public.ular_api('/rooms/'||(SELECT room_id FROM cached_start_fixture)||'/start','POST','{}'::jsonb,token_a,NULL,'fixture-teacher-a-room-start-01');
  IF replay->>'ok'<>'false' OR (replay->>'status')::integer<>401 THEN RAISE EXCEPTION 'anonymous caller replayed teacher A cached room-start response'; END IF;
  PERFORM set_config('request.jwt.claim.sub',a::text,true);

  PERFORM set_config('request.jwt.claim.sub',b::text,true);
  result:=public.ular_api('/rooms','POST','{"isPublic":true}'::jsonb,token_b,NULL,'fixture-teacher-b-room-create-01');
  IF result->>'ok'<>'true' OR result->'data'->>'teacherId'<>b::text THEN RAISE EXCEPTION 'teacher B room was not bound to their identity'; END IF;
  payload:=jsonb_build_object('roomId',result->'data'->>'id','code',result->'data'->>'code');
  result:=public.ular_api('/auth/guest','POST','{"username":"Teacher B Student"}'::jsonb,NULL,NULL,'fixture-teacher-b-student-session-1');
  INSERT INTO guest_fixture VALUES(4,result->'data'->>'id',result->'meta'->>'sessionToken');
  result:=public.ular_api('/rooms/'||(payload->>'code')||'/join','POST','{}'::jsonb,(SELECT token FROM guest_fixture WHERE seq=4),NULL,'fixture-teacher-b-student-join-01');
  IF result->>'ok'<>'true' THEN RAISE EXCEPTION 'student could not join teacher B room'; END IF;
  result:=public.ular_api('/rooms/'||(payload->>'roomId')||'/start','POST','{}'::jsonb,token_b,NULL,'fixture-teacher-b-room-start-01');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>409 OR result->'error'->>'code'<>'NO_ACTIVE_QUESTIONS' THEN RAISE EXCEPTION 'empty teacher bank should block game start: %',result; END IF;

END $$;
RESET ROLE;
DO $$ BEGIN
END $$;
DO $$ DECLARE game jsonb; bank jsonb; BEGIN
  SELECT state->'games'->(SELECT id FROM game_fixture WHERE kind='shared') INTO game FROM public.ular_server_state WHERE id=1;
  bank:=game->'bank'->'items';
  IF bank @> '[{"id":"legacy-legacy-fixture"}]'::jsonb THEN RAISE EXCEPTION 'legacy question entered shared guest bank'; END IF;
  IF jsonb_array_length(bank)<>1 OR bank->0->>'question'<>'Owned by A?' THEN RAISE EXCEPTION 'shared guest bank must contain only active teacher uploads'; END IF;
  SELECT state->'games'->(SELECT id FROM game_fixture WHERE kind='owned') INTO game FROM public.ular_server_state WHERE id=1;
  bank:=game->'bank'->'items';
  IF jsonb_array_length(bank)<>1 OR bank->0->>'id' IS NULL OR bank->0->>'question'<>'Owned by A?' THEN RAISE EXCEPTION 'teacher-created room did not use only its owner bank'; END IF;
END $$;
RESET ROLE;
UPDATE public.ular_server_state
SET state=jsonb_set(state,ARRAY['sessions',encode(extensions.digest(convert_to((SELECT token FROM teacher_token_fixture LIMIT 1),'UTF8'),'sha256'),'hex'),'expires'],to_jsonb((clock_timestamp()-interval '1 minute')::text),false)
WHERE id=1;
SET LOCAL ROLE anon;
DO $$ DECLARE result jsonb; BEGIN
  PERFORM set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
  result:=public.ular_api('/rooms/'||(SELECT room_id FROM cached_start_fixture)||'/start','POST','{}'::jsonb,(SELECT token FROM teacher_token_fixture LIMIT 1),NULL,'fixture-teacher-a-room-start-01');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>401 THEN RAISE EXCEPTION 'expired teacher session replayed cached room-start success'; END IF;
END $$;
RESET ROLE;
UPDATE public.ular_server_state
SET state=jsonb_set(state,ARRAY['sessions',encode(extensions.digest(convert_to((SELECT token FROM teacher_token_fixture LIMIT 1),'UTF8'),'sha256'),'hex'),'expires'],to_jsonb((clock_timestamp()+interval '30 days')::text),false)
WHERE id=1;
UPDATE public.ular_teacher_roles SET role='student' WHERE user_id='10000000-0000-4000-8000-000000000001';
SET LOCAL ROLE anon;
DO $$ DECLARE result jsonb; BEGIN
  PERFORM set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
  result:=public.ular_api('/rooms/'||(SELECT room_id FROM cached_start_fixture)||'/start','POST','{}'::jsonb,(SELECT token FROM teacher_token_fixture LIMIT 1),NULL,'fixture-teacher-a-room-start-01');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>403 THEN RAISE EXCEPTION 'demoted teacher replayed cached room-start success'; END IF;
  result:=public.ular_api('/profile','GET','{}'::jsonb,(SELECT token FROM teacher_token_fixture LIMIT 1),NULL,NULL);
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>403 THEN RAISE EXCEPTION 'demoted teacher retained opaque session access'; END IF;
END $$;
RESET ROLE;
UPDATE public.ular_teacher_roles SET active=false WHERE user_id='10000000-0000-4000-8000-000000000001';
SET LOCAL ROLE anon;
DO $$ DECLARE result jsonb; BEGIN
  PERFORM set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
  result:=public.ular_api('/teacher/session','POST','{}'::jsonb,NULL,NULL,'fixture-disabled-teacher-denied1');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>403 THEN RAISE EXCEPTION 'disabled teacher regained access'; END IF;
  result:=public.ular_api('/rooms/'||(SELECT room_id FROM cached_start_fixture)||'/start','POST','{}'::jsonb,(SELECT token FROM teacher_token_fixture LIMIT 1),NULL,'fixture-teacher-a-room-start-01');
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>403 THEN RAISE EXCEPTION 'disabled teacher replayed cached room-start success'; END IF;
  result:=public.ular_api('/profile','GET','{}'::jsonb,(SELECT token FROM teacher_token_fixture LIMIT 1),NULL,NULL);
  IF result->>'ok'<>'false' OR (result->>'status')::integer<>403 THEN RAISE EXCEPTION 'disabled teacher opaque session remained usable'; END IF;
END $$;
ROLLBACK;
