\set ON_ERROR_STOP on
BEGIN;

-- All writes are synthetic and rolled back. Legacy snapshot questions remain
-- playable in the shared guest pool after migration 009 retires admin login.
UPDATE public.ular_server_state SET state=jsonb_set(state,'{questions}','{"legacy-fixture-question":{"id":"legacy-fixture-question","question":"Isolated fixture question?","options":["Correct","Wrong"],"answer":0,"explanation":"fixture only","category":"QA","difficulty":"mudah","timeLimit":30,"active":true}}'::jsonb,true) WHERE id=1;

SET LOCAL ROLE anon;
DO $$
DECLARE
  v_guest jsonb; v_token text; v_user_id text; v_room jsonb; v_room_id text;
  v_game jsonb; v_game_id text; v_question text; v_student text;
  v_result jsonb; v_replay jsonb; v_conflict jsonb; v_state jsonb; v_sync jsonb; v_leaderboard jsonb;
  v_dice jsonb; v_events jsonb; v_sequence bigint; v_count integer;
BEGIN
  v_guest:=public.ular_api('/auth/guest','POST','{"username":"QA Host"}'::jsonb,NULL,NULL,'fixture-host-session-0001');
  IF v_guest->>'ok'<>'true' THEN RAISE EXCEPTION 'guest session creation failed'; END IF;
  v_token:=v_guest->'meta'->>'sessionToken';v_user_id:=v_guest->'data'->>'id';
  v_room:=public.ular_api('/rooms/local','POST','{"players":["QA Student"]}'::jsonb,v_token,NULL,'fixture-local-room-0001');
  IF v_room->>'ok'<>'true' THEN RAISE EXCEPTION 'local room creation failed: %',v_room->'error'->>'code'; END IF;
  v_room_id:=v_room->'data'->>'id';
  v_replay:=public.ular_api('/rooms/local','POST','{"players":["QA Student"]}'::jsonb,v_token,NULL,'fixture-local-room-0001');
  IF v_replay->'data'->>'id' IS DISTINCT FROM v_room_id THEN RAISE EXCEPTION 'room retry created a second room'; END IF;
  v_conflict:=public.ular_api('/rooms/local','POST','{"players":["Other Student"]}'::jsonb,v_token,NULL,'fixture-local-room-0001');
  IF v_conflict->>'ok'<>'false' OR (v_conflict->>'status')::integer<>409 THEN RAISE EXCEPTION 'room request id payload conflict was not rejected'; END IF;

  v_game:=public.ular_api('/rooms/'||v_room_id||'/start','POST','{}'::jsonb,v_token,NULL,'fixture-start-game-0001');
  IF v_game->>'ok'<>'true' THEN RAISE EXCEPTION 'game start failed: %',v_game->'error'->>'code'; END IF;
  v_game:=v_game->'data';v_game_id:=v_game->>'id';
  IF NOT (v_game->'question' ? 'question') OR v_game->'question' ? 'answer' OR v_game->'question' ? 'answerIndex' THEN RAISE EXCEPTION 'private answer leaked into active question'; END IF;
  v_question:=v_game->'question'->>'id';v_student:=v_game->'players'->1->>'id';

  v_result:=public.ular_api('/games/'||v_game_id||'/question/answer','POST',jsonb_build_object('questionId',v_question,'answer',0,'playerId',v_student),v_token,NULL,'fixture-wrong-turn-0001');
  IF v_result->>'ok'<>'false' OR (v_result->>'status')::integer<>403 OR v_result->'error'->>'code'<>'NOT_PLAYER_TURN' THEN RAISE EXCEPTION 'wrong-turn answer was accepted'; END IF;
  v_result:=public.ular_api('/games/'||v_game_id||'/dice/roll','POST',jsonb_build_object('playerId',v_user_id),v_token,NULL,'fixture-dice-locked-0001');
  IF v_result->>'ok'<>'false' OR (v_result->>'status')::integer<>409 THEN RAISE EXCEPTION 'locked dice was accepted'; END IF;

  v_result:=public.ular_api('/games/'||v_game_id||'/question/answer','POST',jsonb_build_object('questionId',v_question,'answer',1),v_token,NULL,'fixture-wrong-answer-0001');
  IF v_result->>'ok'<>'true' OR v_result->'data'->>'result'<>'wrong' OR v_result->'data'->>'diceUnlocked'<>'false' THEN RAISE EXCEPTION 'wrong answer did not keep dice locked'; END IF;
  v_replay:=public.ular_api('/games/'||v_game_id||'/question/answer','POST',jsonb_build_object('questionId',v_question,'answer',1),v_token,NULL,'fixture-wrong-answer-0001');
  IF v_replay IS DISTINCT FROM v_result THEN RAISE EXCEPTION 'answer retry changed its recorded response'; END IF;
  v_conflict:=public.ular_api('/games/'||v_game_id||'/question/answer','POST',jsonb_build_object('questionId',v_question,'answer',0),v_token,NULL,'fixture-wrong-answer-0001');
  IF v_conflict->>'ok'<>'false' OR (v_conflict->>'status')::integer<>409 THEN RAISE EXCEPTION 'answer request id payload conflict was not rejected'; END IF;

  v_game:=public.ular_api('/games/'||v_game_id||'/state','GET','{}'::jsonb,v_token,NULL,NULL);
  IF v_game->>'ok'<>'true' OR v_game->'data'->'question' ? 'answer' OR v_game->'data'->'question' ? 'answerIndex' THEN RAISE EXCEPTION 'game state exposed the answer'; END IF;
  v_game:=v_game->'data';v_question:=v_game->'question'->>'id';
  v_result:=public.ular_api('/games/'||v_game_id||'/question/answer','POST',jsonb_build_object('questionId',v_question,'answer',0,'playerId',v_student),v_token,NULL,'fixture-correct-answer-0001');
  IF v_result->>'ok'<>'true' OR v_result->'data'->>'result'<>'correct' OR v_result->'data'->>'diceUnlocked'<>'true' OR (v_result->'data'->>'correctAnswer')::integer<>0 THEN RAISE EXCEPTION 'correct answer did not unlock dice'; END IF;
  v_dice:=public.ular_api('/games/'||v_game_id||'/dice/roll','POST',jsonb_build_object('playerId',v_student),v_token,NULL,'fixture-roll-dice-0001');
  IF v_dice->>'ok'<>'true' OR (v_dice->'data'->>'dice')::integer NOT BETWEEN 1 AND 6 THEN RAISE EXCEPTION 'authorized dice roll failed'; END IF;

  v_sync:=public.ular_api('/rooms/'||v_room_id||'/sync','POST','{"afterSequence":0}'::jsonb,v_token,NULL,'fixture-sync-0001');
  IF v_sync->>'ok'<>'true' THEN RAISE EXCEPTION 'room sync failed'; END IF;
  v_events:=v_sync->'data'->'events';
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_events) e WHERE e->>'event'='question:result') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_events) e WHERE e->>'event'='dice:rolled') THEN RAISE EXCEPTION 'sync did not deliver question and dice events'; END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(v_events) WITH ORDINALITY a(value,ord) JOIN jsonb_array_elements(v_events) WITH ORDINALITY b(value,ord) ON a.ord<b.ord WHERE a.value->>'event'='dice:rolled' AND b.value->>'event'='player:step';
  IF v_count=0 THEN RAISE EXCEPTION 'dice animation step events were missing or unordered'; END IF;
  IF EXISTS(SELECT 1 FROM (SELECT (value->>'sequence')::bigint seq,lag((value->>'sequence')::bigint) OVER (ORDER BY ordinality) prev FROM jsonb_array_elements(v_events) WITH ORDINALITY e(value,ordinality)) q WHERE prev IS NOT NULL AND seq<=prev) THEN RAISE EXCEPTION 'sync event sequence is not strictly increasing'; END IF;
  v_sequence:=(v_sync->'data'->>'sequence')::bigint;
  v_sync:=public.ular_api('/rooms/'||v_room_id||'/sync','POST',jsonb_build_object('afterSequence',v_sequence),v_token,NULL,'fixture-sync-next-0001');
  IF jsonb_array_length(v_sync->'data'->'events')<>0 THEN RAISE EXCEPTION 'empty sync poll replayed old events'; END IF;

  v_result:=public.ular_api('/profile','GET','{}'::jsonb,v_token,NULL,NULL);
  IF (v_result->'data'->'stats'->>'correctAnswers')::integer<>0 OR (v_result->'data'->'stats'->>'wrongAnswers')::integer<>1 THEN RAISE EXCEPTION 'host score counters are incorrect'; END IF;
  v_leaderboard:=public.ular_api('/leaderboard','GET','{}'::jsonb,v_token,NULL,NULL)->'data';
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_leaderboard) p WHERE p->>'id'=v_student AND (p->>'correctAnswers')::integer=1) THEN RAISE EXCEPTION 'local student score did not accumulate exactly once'; END IF;

END $$;
ROLLBACK;
