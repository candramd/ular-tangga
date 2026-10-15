-- Disposable fixture only. Every uploaded question and game is rolled back.
BEGIN;
INSERT INTO auth.users(id,email,raw_app_meta_data,is_anonymous,encrypted_password) VALUES
('20000000-0000-4000-8000-000000000001','question-a@accounts.ular-tangga.invalid','{"provider":"email"}',false,'fixture'),
('20000000-0000-4000-8000-000000000002','question-b@accounts.ular-tangga.invalid','{"provider":"email"}',false,'fixture');
INSERT INTO public.ular_teacher_roles(user_id) VALUES ('20000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000002');
DO $$
DECLARE a text:='20000000-0000-4000-8000-000000000001'; b text:='20000000-0000-4000-8000-000000000002'; bank jsonb; game jsonb; result jsonb; token text; room_id text;
BEGIN
  IF public.ular_teacher_question_bank(a)<>'[]'::jsonb THEN RAISE EXCEPTION 'empty owner bank is not empty'; END IF;
  IF to_regprocedure('public.ular_builtin_question(integer)') IS NOT NULL THEN RAISE EXCEPTION 'builtin question generator still installed'; END IF;
  INSERT INTO public.ular_teacher_questions(id,owner_id,question) VALUES
  ('teacher-a-active',a::uuid,'{"id":"teacher-a-active","question":"A active?","options":["Yes","No"],"answer":0,"explanation":"A only","active":true}'),
  ('teacher-a-inactive',a::uuid,'{"id":"teacher-a-inactive","question":"A inactive?","options":["Yes","No"],"answer":1,"active":false}'),
  ('teacher-b-active',b::uuid,'{"id":"teacher-b-active","question":"B active?","options":["Yes","No"],"answer":1,"active":true}');
  bank:=public.ular_teacher_question_bank(a);
  IF jsonb_array_length(bank)<>1 OR bank->0->>'id'<>'teacher-a-active' THEN RAISE EXCEPTION 'owner bank contains unrelated or inactive questions'; END IF;
  game:=jsonb_build_object('view',jsonb_build_object('id','fixture-game','status','playing','turnNumber',0,'players',jsonb_build_array(jsonb_build_object('id','p1'),jsonb_build_object('id','p2'))),'bank',jsonb_build_object('items',bank));
  FOR turn IN 1..12 LOOP
    game:=public.ular_set_next_question(game,turn%2,clock_timestamp());
    IF game->'view'->'question'->>'question'<>'A active?' OR game->>'answerIndex'<>'0' THEN RAISE EXCEPTION 'teacher-only bank stopped cycling'; END IF;
    IF game->'view'->'question' ? 'answer' OR game->'view'->'question' ? 'explanation' THEN RAISE EXCEPTION 'public question leaks answer'; END IF;
  END LOOP;
  game:=jsonb_set(game,'{bank,items}','[]'::jsonb);
  game:=public.ular_set_next_question(game,0,clock_timestamp());
  IF game->'view'->>'status'<>'finished' OR game->'view'->'question'<>'null'::jsonb THEN RAISE EXCEPTION 'empty legacy game generated a question'; END IF;

  PERFORM set_config('request.jwt.claim.sub',a,true);
  result:=public.ular_api('/teacher/session','POST','{}',NULL,NULL,'fixture-question-session');
  token:=result->'meta'->>'sessionToken';
  result:=public.ular_api('/rooms/local','POST','{"players":["One","Two"]}',token,NULL,'fixture-question-local');
  IF result->>'ok'<>'true' THEN RAISE EXCEPTION 'local fixture failed: %',result; END IF;
  room_id:=result->'data'->>'id';
  UPDATE public.ular_teacher_questions SET question=jsonb_set(question,'{active}','false'::jsonb) WHERE owner_id=a::uuid;
  result:=public.ular_api('/rooms/'||room_id||'/start','POST','{}',token,NULL,'fixture-question-start-empty');
  IF result->'error'->>'code'<>'NO_ACTIVE_QUESTIONS' OR result->>'status'<>'409' THEN RAISE EXCEPTION 'empty local bank did not block start: %',result; END IF;
  IF (SELECT state->'rooms'->room_id->>'status' FROM public.ular_server_state WHERE id=1)<>'waiting' THEN RAISE EXCEPTION 'failed start changed room'; END IF;
  UPDATE public.ular_teacher_questions SET question=jsonb_set(question,'{active}','true'::jsonb) WHERE id='teacher-a-active';
  result:=public.ular_api('/rooms/'||room_id||'/start','POST','{}',token,NULL,'fixture-question-start-ready');
  IF result->>'ok'<>'true' OR result->'data'->'question'->>'question'<>'A active?' THEN RAISE EXCEPTION 'teacher question did not unblock local game: %',result; END IF;
END $$;
ROLLBACK;
