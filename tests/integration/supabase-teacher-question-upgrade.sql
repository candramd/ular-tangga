-- Disposable fixture only: verify cleanup and repeat application of migration 010.
BEGIN;
UPDATE public.ular_server_state SET state='{
  "users":{"p1":{"id":"p1","xp":30}},
  "stats":{"p1":{"correctAnswers":3}},
  "rooms":{"r1":{"id":"r1","status":"playing","gameId":"g1"}},
  "games":{"g1":{"view":{"id":"g1","roomId":"r1","status":"playing","turnNumber":2,"question":{"question":"Old system question"}},"answerIndex":1,"explanation":"Old system answer","bank":{"items":[]}}}
}'::jsonb WHERE id=1;
\ir ../../supabase/migrations/010_teacher_questions_only.sql
DO $$ DECLARE state jsonb; BEGIN
  SELECT s.state INTO state FROM public.ular_server_state s WHERE id=1;
  IF state->'games'->'g1'->'view'->>'status'<>'finished' OR state->'games'->'g1'->'view'->'question'<>'null'::jsonb THEN RAISE EXCEPTION 'system question was not retired'; END IF;
  IF state->'users'->'p1'->>'xp'<>'30' OR state->'stats'->'p1'->>'correctAnswers'<>'3' THEN RAISE EXCEPTION 'retiring questions changed scores'; END IF;
  IF state->'rooms'->'r1'->>'status'<>'finished' THEN RAISE EXCEPTION 'old room remains active'; END IF;
END $$;
CREATE TEMP TABLE question_upgrade_before AS SELECT state, (SELECT count(*) FROM public.ular_room_events) events FROM public.ular_server_state WHERE id=1;
\ir ../../supabase/migrations/010_teacher_questions_only.sql
DO $$ BEGIN
  IF (SELECT s.state IS DISTINCT FROM b.state OR (SELECT count(*) FROM public.ular_room_events)<>b.events FROM public.ular_server_state s CROSS JOIN question_upgrade_before b WHERE s.id=1) THEN RAISE EXCEPTION 'reapplying migration changed games or events'; END IF;
END $$;
ROLLBACK;
