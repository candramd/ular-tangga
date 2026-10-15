-- Only teacher-authored questions may enter new game snapshots.
DO $$ BEGIN
  IF NOT pg_try_advisory_xact_lock(821471036219) THEN
    RAISE EXCEPTION 'cannot update question rules while another writer is active';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ular_teacher_question_bank(p_teacher_id text)
RETURNS jsonb LANGUAGE sql VOLATILE
SET search_path=pg_catalog,public
AS $$
  SELECT coalesce(jsonb_agg(tq.question ORDER BY random()),'[]'::jsonb)
  FROM public.ular_teacher_questions tq
  JOIN public.ular_teacher_roles tr ON tr.user_id=tq.owner_id AND tr.active AND tr.role='teacher'
  WHERE (p_teacher_id IS NULL OR tq.owner_id::text=p_teacher_id)
    AND public.ular_is_username_auth_user(tq.owner_id)
    AND coalesce((tq.question->>'active')::boolean,false)
$$;
REVOKE ALL ON FUNCTION public.ular_teacher_question_bank(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_teacher_question_bank(text) TO postgres;

DO $$
DECLARE v_def text; v_start integer; v_end integer; v_old text; v_new text;
BEGIN
  v_def:=pg_get_functiondef('public.ular_api(text,text,jsonb,text,text,text)'::regprocedure);
  v_new:=$replacement$v_bank:=public.ular_teacher_question_bank(v_room->>'teacherId');
        IF jsonb_array_length(v_bank)=0 THEN
          RETURN jsonb_build_object('ok',false,'status',409,'error',jsonb_build_object('code','NO_ACTIVE_QUESTIONS','message','Add and activate a teacher question before starting the game'));
        END IF;$replacement$;
  IF position(v_new in v_def)=0 THEN
    v_start:=position('IF v_room->>''teacherId'' IS NOT NULL THEN SELECT' in v_def);
    v_end:=position('SELECT board INTO v_board FROM public.ular_game_config' in v_def);
    IF v_start=0 OR v_end<=v_start THEN RAISE EXCEPTION 'ular_api question bank selection point changed'; END IF;
    v_old:=substring(v_def FROM v_start FOR v_end-v_start);
    v_def:=replace(v_def,v_old,v_new||E'\n        ');
    EXECUTE v_def;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ular_set_next_question(p_game jsonb,p_player_index integer,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE
SET search_path=pg_catalog,public
AS $$
DECLARE v_view jsonb; v_bank jsonb; v_item jsonb; v_turn integer; v_id text; v_limit integer; v_q jsonb;
BEGIN
  v_view:=p_game->'view'; v_bank:=p_game->'bank'->'items';
  IF jsonb_typeof(v_bank) IS DISTINCT FROM 'array' THEN v_bank:='[]'::jsonb; END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO v_bank
    FROM jsonb_array_elements(v_bank) WITH ORDINALITY e(value,ord)
    WHERE coalesce(value->>'id','') NOT LIKE 'legacy-%';
  IF jsonb_array_length(v_bank)=0 THEN
    v_view:=v_view||jsonb_build_object('status','finished','turnState','FINISHED','question',NULL,'winnerId',NULL,'deadline',p_now);
    RETURN p_game||jsonb_build_object('view',v_view,'bank',jsonb_build_object('items','[]'::jsonb),'answerIndex',0,'explanation','');
  END IF;
  v_turn:=coalesce((v_view->>'turnNumber')::integer,0)+1; v_id:=v_view->>'id';
  v_item:=v_bank->((v_turn-1)%jsonb_array_length(v_bank));
  v_limit:=CASE WHEN coalesce((v_item->>'timeLimit')::integer,30)<=0 THEN 30 ELSE least(600,coalesce((v_item->>'timeLimit')::integer,30)) END;
  v_q:=jsonb_build_object('id',v_id||'-q'||v_turn,'question',v_item->'question','options',v_item->'options','category',coalesce(v_item->'category','"Umum"'::jsonb),'difficulty',coalesce(v_item->'difficulty','"mudah"'::jsonb),'timeLimit',v_limit);
  v_view:=v_view||jsonb_build_object('turnNumber',v_turn,'currentPlayerId',(v_view->'players'->p_player_index)->'id','turnState','QUESTION','question',v_q,'deadline',p_now+make_interval(secs=>v_limit));
  RETURN p_game||jsonb_build_object('view',v_view,'bank',jsonb_build_object('items',v_bank),'answerIndex',v_item->'answer','explanation',coalesce(v_item->'explanation','""'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.ular_set_next_question(jsonb,integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_set_next_question(jsonb,integer,timestamptz) TO postgres;
DROP FUNCTION IF EXISTS public.ular_builtin_question(integer);

-- Retire active sessions with no teacher bank, without changing scores or uploads.
DO $$
DECLARE v_state jsonb; v_games jsonb; v_rooms jsonb; v_entry record; v_game jsonb; v_room jsonb; v_bank jsonb; v_room_id text; v_changed boolean:=false; v_now timestamptz:=clock_timestamp();
BEGIN
  SELECT state INTO v_state FROM public.ular_server_state WHERE id=1 FOR UPDATE;
  IF v_state IS NULL THEN RETURN; END IF;
  v_games:=coalesce(v_state->'games','{}'::jsonb); v_rooms:=coalesce(v_state->'rooms','{}'::jsonb);
  FOR v_entry IN SELECT key,value FROM jsonb_each(v_games) LOOP
    v_game:=v_entry.value; v_bank:=v_game->'bank'->'items';
    IF jsonb_typeof(v_bank) IS DISTINCT FROM 'array' THEN v_bank:='[]'::jsonb; END IF;
    IF jsonb_array_length(v_bank)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_bank) q WHERE coalesce(q->>'id','') LIKE 'legacy-%') THEN CONTINUE; END IF;
    IF v_game->'view'->>'status'='finished' AND v_game->'view'->'question'='null'::jsonb AND coalesce(v_game->>'explanation','')='' THEN CONTINUE; END IF;
    v_game:=public.ular_set_next_question(v_game,0,v_now);
    IF v_game->'view'->>'status'='finished' THEN v_game:=jsonb_set(v_game,'{results}','{}'::jsonb,true); END IF;
    v_games:=jsonb_set(v_games,ARRAY[v_entry.key],v_game,true);
    v_room_id:=v_game->'view'->>'roomId'; v_room:=v_rooms->v_room_id;
    IF v_room IS NOT NULL THEN
      IF v_game->'view'->>'status'='finished' THEN
        v_room:=jsonb_set(v_room,'{status}','"finished"'::jsonb,true);
        v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true);
      END IF;
      PERFORM public.ular_append_event(v_room_id,v_entry.key,public.ular_event('game:state',v_entry.key,coalesce((v_game->'view'->>'turnNumber')::integer,0),v_game->'view',v_now));
      PERFORM public.ular_append_event(v_room_id,v_entry.key,public.ular_event('room:state',v_entry.key,0,v_room,v_now));
    END IF;
    v_changed:=true;
  END LOOP;
  IF v_changed THEN
    UPDATE public.ular_server_state SET state=v_state||jsonb_build_object('games',v_games,'rooms',v_rooms),updated_at=v_now WHERE id=1;
  END IF;
END $$;
