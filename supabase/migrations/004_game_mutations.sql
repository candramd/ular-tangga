-- Transactional room/game mutation layer. All writes update the established
-- Go-compatible JSON snapshot and append ordered room events in one transaction.
CREATE TABLE IF NOT EXISTS public.ular_rpc_requests (
  principal text NOT NULL,
  request_id text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  token_cipher bytea,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (principal, request_id)
);
ALTER TABLE public.ular_rpc_requests ADD COLUMN IF NOT EXISTS token_cipher bytea;
ALTER TABLE public.ular_rpc_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ular_rpc_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ular_rpc_requests TO postgres;

CREATE OR REPLACE FUNCTION public.ular_event(p_name text,p_game_id text,p_turn integer,p_payload jsonb,p_now timestamptz)
RETURNS jsonb LANGUAGE sql IMMUTABLE
SET search_path=pg_catalog
AS $$ SELECT jsonb_strip_nulls(jsonb_build_object('event',p_name,'gameId',p_game_id,'turnNumber',p_turn,'timestamp',p_now,'payload',p_payload)) $$;
REVOKE ALL ON FUNCTION public.ular_event(text,text,integer,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_event(text,text,integer,jsonb,timestamptz) TO postgres;

CREATE OR REPLACE FUNCTION public.ular_builtin_question(p_turn integer)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path=pg_catalog
AS $$
DECLARE v_bank jsonb; v_item jsonb; v_a integer; v_b integer; v_answer integer; v_options jsonb;
BEGIN
  IF p_turn % 3 = 0 THEN
    v_a := 2+(p_turn*7)%23; v_b := 2+(p_turn*11)%19; v_answer := p_turn%4;
    v_options := jsonb_build_array(v_a+v_b+2,v_a+v_b-1,v_a+v_b+1,v_a+v_b-2);
    v_options := jsonb_set(v_options,ARRAY[v_answer::text],to_jsonb(v_a+v_b),false);
    RETURN jsonb_build_object('question',format('Berapakah hasil %s + %s?',v_a,v_b),'options',v_options,'category','Matematika','difficulty','mudah','timeLimit',30,'answer',v_answer,'explanation',format('%s + %s = %s.',v_a,v_b,v_a+v_b));
  END IF;
  v_bank := jsonb_build_array(
    jsonb_build_object('question','Planet terdekat dengan Matahari adalah ...','options',jsonb_build_array('Venus','Merkurius','Bumi','Mars'),'category','Sains','answer',1,'explanation','Merkurius merupakan planet yang paling dekat dengan Matahari.'),
    jsonb_build_object('question','Proses tumbuhan membuat makanan dengan bantuan cahaya disebut ...','options',jsonb_build_array('Respirasi','Evaporasi','Fotosintesis','Fermentasi'),'category','Sains','answer',2,'explanation','Fotosintesis mengubah air dan karbon dioksida menjadi makanan menggunakan energi cahaya.'),
    jsonb_build_object('question','Sila pertama Pancasila berbunyi ...','options',jsonb_build_array('Ketuhanan Yang Maha Esa','Persatuan Indonesia','Keadilan sosial','Kemanusiaan yang adil dan beradab'),'category','Kewarganegaraan','answer',0,'explanation','Ketuhanan Yang Maha Esa adalah sila pertama Pancasila.'),
    jsonb_build_object('question','Antonim kata ''besar'' adalah ...','options',jsonb_build_array('Luas','Tinggi','Panjang','Kecil'),'category','Bahasa Indonesia','answer',3,'explanation','Antonim adalah kata yang berlawanan makna. Lawan kata besar adalah kecil.'),
    jsonb_build_object('question','Satu jam sama dengan berapa menit?','options',jsonb_build_array('30','60','90','100'),'category','Matematika','answer',1,'explanation','Satu jam terdiri dari 60 menit.'),
    jsonb_build_object('question','Hewan pemakan tumbuhan disebut ...','options',jsonb_build_array('Karnivora','Omnivora','Herbivora','Insektivora'),'category','Sains','answer',2,'explanation','Herbivora adalah hewan yang memakan tumbuhan.'),
    jsonb_build_object('question','Indonesia memproklamasikan kemerdekaan pada tanggal ...','options',jsonb_build_array('17 Agustus 1945','1 Juni 1945','28 Oktober 1928','10 November 1945'),'category','Sejarah','answer',0,'explanation','Proklamasi Kemerdekaan Indonesia dibacakan pada 17 Agustus 1945.'),
    jsonb_build_object('question','Benda yang dapat menghantarkan listrik dengan baik adalah ...','options',jsonb_build_array('Karet','Kayu','Plastik','Tembaga'),'category','Sains','answer',3,'explanation','Tembaga adalah logam konduktor yang sering digunakan sebagai kabel listrik.')
  );
  v_item := v_bank->((p_turn-1)%8);
  RETURN v_item || jsonb_build_object('difficulty','mudah','timeLimit',30);
END $$;
REVOKE ALL ON FUNCTION public.ular_builtin_question(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_builtin_question(integer) TO postgres;

CREATE OR REPLACE FUNCTION public.ular_set_next_question(p_game jsonb,p_player_index integer,p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE
SET search_path=pg_catalog,public
AS $$
DECLARE v_view jsonb; v_bank jsonb; v_item jsonb; v_turn integer; v_id text; v_limit integer; v_q jsonb;
BEGIN
  v_view:=p_game->'view'; v_turn:=coalesce((v_view->>'turnNumber')::integer,0)+1;
  v_id:=v_view->>'id'; v_bank:=p_game->'bank'->'items';
  IF jsonb_typeof(v_bank)='array' AND jsonb_array_length(v_bank)>0 THEN
    SELECT value INTO v_item FROM jsonb_array_elements(v_bank) WITH ORDINALITY e(value,ord)
      ORDER BY CASE WHEN value->>'id' IS NOT NULL THEN value->>'id' END, ord
      OFFSET ((v_turn-1)%jsonb_array_length(v_bank)) LIMIT 1;
    v_item:=jsonb_build_object('question',v_item->'question','options',v_item->'options','category',coalesce(v_item->'category','"Umum"'::jsonb),'difficulty',coalesce(v_item->'difficulty','"mudah"'::jsonb),'timeLimit',coalesce(v_item->'timeLimit','30'::jsonb),'answer',v_item->'answer','explanation',coalesce(v_item->'explanation','""'::jsonb));
  ELSE
    v_item:=public.ular_builtin_question(v_turn);
  END IF;
  v_limit:=CASE WHEN coalesce((v_item->>'timeLimit')::integer,30)<=0 THEN 30 ELSE least(600,(v_item->>'timeLimit')::integer) END;
  v_q:=jsonb_build_object('id',v_id||'-q'||v_turn,'question',v_item->'question','options',v_item->'options','category',coalesce(v_item->'category','"Umum"'::jsonb),'difficulty',coalesce(v_item->'difficulty','"mudah"'::jsonb),'timeLimit',v_limit);
  v_view:=jsonb_set(v_view,'{turnNumber}',to_jsonb(v_turn),true);
  v_view:=jsonb_set(v_view,'{currentPlayerId}',(v_view->'players'->p_player_index)->'id',true);
  v_view:=jsonb_set(v_view,'{turnState}','"QUESTION"'::jsonb,true);
  v_view:=jsonb_set(v_view,'{question}',v_q,true);
  v_view:=jsonb_set(v_view,'{deadline}',to_jsonb(p_now+make_interval(secs=>v_limit)),true);
  RETURN jsonb_set(jsonb_set(jsonb_set(p_game,'{view}',v_view,true),'{answerIndex}',coalesce(v_item->'answer','0'::jsonb),true),'{explanation}',coalesce(v_item->'explanation','""'::jsonb),true);
END $$;
REVOKE ALL ON FUNCTION public.ular_set_next_question(jsonb,integer,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_set_next_question(jsonb,integer,timestamptz) TO postgres;

CREATE OR REPLACE FUNCTION public.ular_resolve_question(p_game jsonb,p_actor text,p_question_id text,p_answer integer,p_now timestamptz,p_force_timeout boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql VOLATILE
SET search_path=pg_catalog,public
AS $$
DECLARE v_game jsonb:=p_game;v_view jsonb;v_players jsonb;v_player jsonb;v_idx integer;v_n integer;v_q jsonb;v_result text;v_correct integer;v_answer_result jsonb;v_events jsonb:='[]'::jsonb;v_turn integer;v_old jsonb;
BEGIN
  v_view:=v_game->'view';v_q:=v_view->'question';
  v_old:=v_game->'results'->p_question_id;
  IF v_old IS NOT NULL THEN
    IF v_old->>'playerId'<>p_actor THEN RETURN jsonb_build_object('error','NOT_PLAYER_TURN');END IF;
    RETURN jsonb_build_object('game',v_game,'result',v_old,'events','[]'::jsonb);
  END IF;
  IF v_view->>'status'<>'playing' OR v_view->>'turnState'<>'QUESTION' THEN RETURN jsonb_build_object('error','INVALID_TURN_STATE');END IF;
  IF v_view->>'currentPlayerId'<>p_actor THEN RETURN jsonb_build_object('error','NOT_PLAYER_TURN');END IF;
  IF v_q->>'id' IS DISTINCT FROM p_question_id THEN RETURN jsonb_build_object('error','QUESTION_MISMATCH');END IF;
  IF NOT p_force_timeout AND (p_answer IS NULL OR p_answer<0 OR p_answer>=jsonb_array_length(v_q->'options')) THEN RETURN jsonb_build_object('error','INVALID_ANSWER');END IF;
  v_players:=v_view->'players';v_n:=jsonb_array_length(v_players);
  SELECT ordinality-1,value INTO v_idx,v_player FROM jsonb_array_elements(v_players) WITH ORDINALITY e(value,ordinality) WHERE value->>'id'=p_actor;
  IF v_idx IS NULL THEN RETURN jsonb_build_object('error','NOT_ROOM_MEMBER');END IF;
  v_correct:=(v_game->>'answerIndex')::integer;
  IF p_force_timeout OR (v_view->>'deadline')::timestamptz<=p_now THEN v_result:='timeout';
  ELSIF p_answer=v_correct THEN v_result:='correct';ELSE v_result:='wrong';END IF;
  IF v_result='correct' THEN
    v_player:=jsonb_set(jsonb_set(jsonb_set(v_player,'{xp}',to_jsonb(coalesce((v_player->>'xp')::integer,0)+10),true),'{coins}',to_jsonb(coalesce((v_player->>'coins')::integer,0)+5),true),'{level}',to_jsonb(1+(coalesce((v_player->>'xp')::integer,0)+10)/100),true);
    v_players:=jsonb_set(v_players,ARRAY[v_idx::text],v_player,true);
    v_view:=jsonb_set(v_view,'{players}',v_players,true);v_view:=jsonb_set(v_view,'{turnState}','"DICE_UNLOCKED"'::jsonb,true);
  END IF;
  v_answer_result:=jsonb_build_object('playerId',p_actor,'result',v_result,'correctAnswer',v_correct,'explanation',coalesce(v_game->>'explanation',''),'position',coalesce((v_player->>'position')::integer,0),'xp',coalesce((v_player->>'xp')::integer,0),'coins',coalesce((v_player->>'coins')::integer,0),'diceUnlocked',v_result='correct');
  v_game:=jsonb_set(v_game,'{results}',coalesce(v_game->'results','{}'::jsonb)||jsonb_build_object(p_question_id,v_answer_result),true);
  v_events:=v_events||jsonb_build_array(public.ular_event('question:result',v_view->>'id',coalesce((v_view->>'turnNumber')::integer,0),v_answer_result,p_now));
  IF v_result<>'correct' THEN
    v_game:=jsonb_set(v_game,'{view}',v_view,true);
    v_game:=public.ular_set_next_question(v_game,(v_idx+1)%v_n,p_now);v_view:=v_game->'view';
    v_events:=v_events||jsonb_build_array(public.ular_event('turn:changed',v_view->>'id',(v_view->>'turnNumber')::integer,jsonb_build_object('turnNumber',(v_view->>'turnNumber')::integer,'playerId',v_view->>'currentPlayerId'),p_now));
  ELSE v_game:=jsonb_set(v_game,'{view}',v_view,true);END IF;
  v_view:=v_game->'view';v_events:=v_events||jsonb_build_array(public.ular_event('game:state',v_view->>'id',(v_view->>'turnNumber')::integer,v_view,p_now));
  RETURN jsonb_build_object('game',v_game,'result',v_answer_result,'events',v_events);
END $$;
REVOKE ALL ON FUNCTION public.ular_resolve_question(jsonb,text,text,integer,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_resolve_question(jsonb,text,text,integer,timestamptz,boolean) TO postgres;

CREATE OR REPLACE FUNCTION public.ular_api(
  p_path text,p_method text DEFAULT 'GET',p_body jsonb DEFAULT '{}'::jsonb,
  p_session_token text DEFAULT NULL,p_admin_token text DEFAULT NULL,p_request_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,extensions
AS $$
DECLARE
  v_method text:=upper(coalesce(p_method,'GET')); v_now timestamptz:=clock_timestamp();
  v_state jsonb; v_users jsonb; v_sessions jsonb; v_rooms jsonb; v_games jsonb; v_stats jsonb; v_questions jsonb;
  v_user_id text; v_token_hash text; v_key text; v_ref text; v_room_id text; v_room jsonb; v_game_id text; v_game jsonb;
  v_actor text; v_player_id text; v_player jsonb; v_players jsonb; v_host text; v_code text; v_newid text;
  v_data jsonb; v_result jsonb; v_events jsonb:='[]'::jsonb; v_event jsonb; v_seq bigint;
  v_request text; v_fingerprint text; v_cached jsonb; v_cached_fp text; v_principal text;
  v_idx integer; v_count integer; v_turn integer; v_answer integer; v_is_correct boolean; v_result_name text;
  v_correct integer; v_xp integer; v_coins integer; v_pos integer; v_dice integer; v_target integer; v_dest integer;
  v_names jsonb; v_name text; v_seen text[]:='{}'; v_roster jsonb; v_owners jsonb; v_student_id text; v_stat jsonb;
  v_bank jsonb; v_board jsonb; v_board_snakes jsonb; v_board_ladders jsonb; v_deadline timestamptz; v_view jsonb; v_random_bytes bytea; v_sync_events jsonb; v_maxseq bigint; v_minseq bigint; v_resync boolean:=false;
  v_error_code text; v_error_message text; v_status integer:=200; v_changed boolean:=false; v_sync boolean:=false; v_after bigint:=0; v_random bigint;
BEGIN
  IF p_path LIKE '/admin/%' THEN
    RETURN public.ular_admin_api(p_path,v_method,p_body,p_session_token,p_admin_token,p_request_id);
  END IF;
  IF v_method='GET' OR (p_path='/auth/guest' AND v_method='POST') THEN
    RETURN public.ular_api_reads(p_path,v_method,p_body,p_session_token,p_admin_token,p_request_id);
  END IF;
  IF v_method<>'POST' THEN
    RETURN jsonb_build_object('ok',false,'status',405,'error',jsonb_build_object('code','METHOD_NOT_ALLOWED','message','method not allowed'));
  END IF;
  IF octet_length(coalesce(p_body,'{}'::jsonb)::text)>4096 THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','request body exceeds 4096 bytes')); END IF;
  IF p_session_token IS NULL OR length(p_session_token)<32 THEN
    RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','guest session required'));
  END IF;
  v_token_hash:=encode(extensions.digest(convert_to(p_session_token,'UTF8'),'sha256'),'hex');
  v_request:=coalesce(p_request_id,p_body->>'requestId');
  IF v_request IS NULL OR length(v_request)<1 OR length(v_request)>128 THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','requestId is required and must be at most 128 bytes'));
  END IF;
  v_fingerprint:=encode(extensions.digest(convert_to(v_method||' '||p_path||' '||coalesce(p_body,'{}'::jsonb)::text,'UTF8'),'sha256'),'hex');
  IF NOT public.ular_writer_available() THEN
    RETURN jsonb_build_object('ok',false,'status',503,'error',jsonb_build_object('code','SERVICE_UNAVAILABLE','message','legacy server currently owns the writer'));
  END IF;
  SELECT state INTO v_state FROM public.ular_server_state WHERE id=1 FOR UPDATE;
  v_principal:=coalesce(v_state->'sessions'->v_token_hash->>'userId','guest');
  SELECT fingerprint,response INTO v_cached_fp,v_cached FROM public.ular_rpc_requests
    WHERE principal=v_principal AND request_id=v_request AND expires_at>v_now FOR UPDATE;
  IF FOUND THEN
    IF v_cached_fp<>v_fingerprint THEN RETURN jsonb_build_object('ok',false,'status',409,'error',jsonb_build_object('code','REQUEST_ID_CONFLICT','message','requestId already used with a different action or payload')); END IF;
    RETURN v_cached;
  END IF;
  IF v_state IS NULL THEN
    v_state:=jsonb_build_object('users','{}'::jsonb,'sessions','{}'::jsonb,'rooms','{}'::jsonb,'games','{}'::jsonb,'requests','{}'::jsonb,'stats','{}'::jsonb,'questions','{}'::jsonb,'adminSessions','{}'::jsonb,'localStudentOwners','{}'::jsonb,'localStudentRoster','{}'::jsonb);
  END IF;
  v_users:=coalesce(v_state->'users','{}'::jsonb); v_sessions:=coalesce(v_state->'sessions','{}'::jsonb);
  v_rooms:=coalesce(v_state->'rooms','{}'::jsonb); v_games:=coalesce(v_state->'games','{}'::jsonb);
  v_stats:=coalesce(v_state->'stats','{}'::jsonb); v_questions:=coalesce(v_state->'questions','{}'::jsonb);
  IF NOT (v_sessions?v_token_hash) OR coalesce((v_sessions->v_token_hash->>'expires')::timestamptz,'epoch'::timestamptz)<=v_now THEN
    RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','guest session expired or invalid'));
  END IF;
  v_user_id:=v_sessions->v_token_hash->>'userId';
  IF v_users->v_user_id IS NULL THEN RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','guest session invalid')); END IF;
  v_principal:=v_user_id;

  -- Rooms: create, quick-match, and local pass-and-play.
  IF p_path IN ('/rooms','/rooms/quick','/rooms/local') THEN
    IF EXISTS(SELECT 1 FROM jsonb_each(v_rooms) r WHERE r.value->>'status'<>'finished' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r.value->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id)) THEN
      SELECT key,value INTO v_room_id,v_room FROM jsonb_each(v_rooms) r WHERE r.value->>'status'<>'finished' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r.value->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id) LIMIT 1;
      IF p_path='/rooms/quick' THEN v_data:=v_room; ELSE v_status:=409; v_error_code:='CONFLICT'; v_error_message:='leave your current room before creating another'; END IF;
    ELSIF p_path='/rooms' THEN
      v_room_id:=rtrim(translate(encode(extensions.gen_random_bytes(18),'base64'),'+/','-_'),'=');v_code:=upper(encode(extensions.gen_random_bytes(4),'hex'));
      WHILE EXISTS(SELECT 1 FROM jsonb_each(v_rooms) r WHERE r.value->>'code'=v_code) LOOP v_code:=upper(encode(extensions.gen_random_bytes(4),'hex'));END LOOP;
      v_room:=jsonb_build_object('id',v_room_id,'code',v_code,'hostId',v_user_id,'status','waiting','isPublic',coalesce((p_body->>'isPublic')::boolean,false),'players',jsonb_build_array(v_users->v_user_id||jsonb_build_object('position',0,'isConnected',false)));
      v_rooms:=v_rooms||jsonb_build_object(v_room_id,v_room);v_data:=v_room;v_events:=jsonb_build_array(public.ular_event('room:state',NULL,0,v_room,v_now));v_changed:=true;
    ELSIF p_path='/rooms/quick' THEN
      SELECT key,value INTO v_room_id,v_room FROM jsonb_each(v_rooms) r WHERE r.value->>'status'='waiting' AND coalesce((r.value->>'isPublic')::boolean,false) AND jsonb_array_length(coalesce(r.value->'players','[]'::jsonb))<4 ORDER BY key LIMIT 1;
      IF v_room IS NOT NULL THEN
        v_players:=v_room->'players';
        v_player:=v_users->v_user_id || jsonb_build_object('position',0,'isConnected',false);
        v_players:=v_players||jsonb_build_array(v_player); v_room:=jsonb_set(v_room,'{players}',v_players,true);
        v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true); v_data:=v_room;
        v_events:=jsonb_build_array(public.ular_event('room:state',v_room->>'gameId',0,v_room,v_now)); v_changed:=true;
      ELSE
        v_room_id:=rtrim(translate(encode(extensions.gen_random_bytes(18),'base64'),'+/','-_'),'=');
        v_code:=upper(encode(extensions.gen_random_bytes(4),'hex'));
        WHILE EXISTS(SELECT 1 FROM jsonb_each(v_rooms) r WHERE r.value->>'code'=v_code) LOOP v_code:=upper(encode(extensions.gen_random_bytes(4),'hex')); END LOOP;
        v_room:=jsonb_build_object('id',v_room_id,'code',v_code,'hostId',v_user_id,'status','waiting','isPublic',true,'players',jsonb_build_array(v_users->v_user_id||jsonb_build_object('position',0,'isConnected',false)));
        v_rooms:=v_rooms||jsonb_build_object(v_room_id,v_room); v_data:=v_room;
        v_events:=jsonb_build_array(public.ular_event('room:state',NULL,0,v_room,v_now)); v_changed:=true;
      END IF;
    ELSE
      v_players:=coalesce(p_body->'players','[]'::jsonb);
      IF jsonb_typeof(v_players)<>'array' OR jsonb_array_length(v_players)<1 OR jsonb_array_length(v_players)>3 THEN
        v_status:=400;v_error_code:='INVALID_REQUEST';v_error_message:='single-device rooms need 1 to 3 additional players';
      ELSE
        v_seen:=ARRAY[lower(v_users->v_user_id->>'username')]; v_roster:=coalesce(v_state->'localStudentRoster','{}'::jsonb);v_owners:=coalesce(v_state->'localStudentOwners','{}'::jsonb);
        FOR v_name IN SELECT btrim(value#>>'{}') FROM jsonb_array_elements(v_players) LOOP
          IF v_name IS NULL OR char_length(v_name)<2 OR char_length(v_name)>24 OR v_name ~ '[[:cntrl:]]' THEN v_status:=400;v_error_code:='INVALID_REQUEST';v_error_message:='player names must contain 2 to 24 characters without control characters';EXIT;END IF;
          IF lower(v_name)=ANY(v_seen) THEN v_status:=409;v_error_code:='DUPLICATE_PLAYER_NAME';v_error_message:='player names must be unique';EXIT;END IF;
          v_seen:=array_append(v_seen,lower(v_name));
        END LOOP;
        IF v_status=200 THEN
          v_room_id:=rtrim(translate(encode(extensions.gen_random_bytes(18),'base64'),'+/','-_'),'=');v_code:=upper(encode(extensions.gen_random_bytes(4),'hex'));
          WHILE EXISTS(SELECT 1 FROM jsonb_each(v_rooms) r WHERE r.value->>'code'=v_code) LOOP v_code:=upper(encode(extensions.gen_random_bytes(4),'hex'));END LOOP;
          v_room:=jsonb_build_object('id',v_room_id,'code',v_code,'hostId',v_user_id,'status','waiting','mode','local','isPublic',false,'players',jsonb_build_array(v_users->v_user_id||jsonb_build_object('position',0,'isConnected',true)));
          FOR v_name IN SELECT btrim(value#>>'{}') FROM jsonb_array_elements(v_players) LOOP
            v_student_id:=v_roster->>(v_user_id||'::'||lower(v_name));
            IF v_student_id IS NULL THEN v_student_id:='local-'||encode(extensions.digest(convert_to(v_user_id,'UTF8')||decode('00','hex')||convert_to(lower(v_name),'UTF8'),'sha256'),'hex'); END IF;
            v_newid:=v_student_id;v_idx:=0;
            WHILE v_users?v_newid AND (coalesce((v_users->v_newid->>'synthetic')::boolean,false)=false OR v_owners->>v_newid<>v_user_id) LOOP v_idx:=v_idx+1;v_newid:=v_student_id||'-'||v_idx;END LOOP;
            v_player:=coalesce(v_users->v_newid,jsonb_build_object('id',v_newid,'username',v_name,'xp',0,'coins',0,'level',1,'synthetic',true))||jsonb_build_object('username',v_name);
            v_users:=jsonb_set(v_users,ARRAY[v_newid],v_player,true);v_owners:=jsonb_set(v_owners,ARRAY[v_newid],to_jsonb(v_user_id),true);v_roster:=jsonb_set(v_roster,ARRAY[v_user_id||'::'||lower(v_name)],to_jsonb(v_newid),true);
            IF v_stats->v_newid IS NULL THEN v_stats:=jsonb_set(v_stats,ARRAY[v_newid],jsonb_build_object('gamesPlayed',0,'wins',0,'correctAnswers',0,'wrongAnswers',0,'timeouts',0),true);END IF;
            v_room:=jsonb_set(v_room,'{players}',(v_room->'players')||jsonb_build_array(v_player||jsonb_build_object('position',0,'isConnected',true)),true);
          END LOOP;
          v_rooms:=v_rooms||jsonb_build_object(v_room_id,v_room);v_data:=v_room;v_events:=jsonb_build_array(public.ular_event('room:state',NULL,0,v_room,v_now));v_changed:=true;
          v_state:=jsonb_set(jsonb_set(v_state,'{localStudentOwners}',v_owners,true),'{localStudentRoster}',v_roster,true);
        END IF;
      END IF;
    END IF;

  ELSIF p_path LIKE '/rooms/%/join' OR p_path LIKE '/rooms/%/start' OR p_path LIKE '/rooms/%/leave' THEN
    v_ref:=split_part(p_path,'/',3);
    SELECT key,value INTO v_room_id,v_room FROM jsonb_each(v_rooms) WHERE key=v_ref OR upper(value->>'code')=upper(v_ref) LIMIT 1;
    IF v_room IS NULL THEN v_status:=404;v_error_code:='ROOM_NOT_FOUND';v_error_message:='room not found';
    ELSIF p_path LIKE '%/join' THEN
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_room->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id) THEN v_data:=v_room;
      ELSIF v_room->>'status'<>'waiting' THEN v_status:=409;v_error_code:='ROOM_ALREADY_STARTED';v_error_message:='room already started';
      ELSIF v_room->>'mode'='local' THEN v_status:=409;v_error_code:='ROOM_IS_LOCAL';v_error_message:='this room plays on a single device';
      ELSIF jsonb_array_length(v_room->'players')>=4 THEN v_status:=409;v_error_code:='ROOM_FULL';v_error_message:='room is full';
      ELSIF EXISTS(SELECT 1 FROM jsonb_each(v_rooms) r WHERE r.key<>v_room_id AND r.value->>'status'<>'finished' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r.value->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id)) THEN v_status:=409;v_error_code:='CONFLICT';v_error_message:='leave your current room before joining another';
      ELSE
        v_room:=jsonb_set(v_room,'{players}',(v_room->'players')||jsonb_build_array(v_users->v_user_id||jsonb_build_object('position',0,'isConnected',false)),true);v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true);v_data:=v_room;v_events:=jsonb_build_array(public.ular_event('room:state',v_room->>'gameId',0,v_room,v_now));v_changed:=true;
      END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_room->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id) THEN v_status:=403;v_error_code:='NOT_ROOM_MEMBER';v_error_message:='room membership required';
    ELSIF p_path LIKE '%/start' THEN
      IF v_room->>'hostId'<>v_user_id THEN v_status:=403;v_error_code:='NOT_ROOM_HOST';v_error_message:='only the host can start';
      ELSIF v_room->>'status'<>'waiting' THEN v_status:=409;v_error_code:='ROOM_ALREADY_STARTED';v_error_message:='room already started';
      ELSIF jsonb_array_length(v_room->'players')<2 OR jsonb_array_length(v_room->'players')>4 THEN v_status:=409;v_error_code:='NOT_ENOUGH_PLAYERS';v_error_message:='a game requires 2 to 4 players';
      ELSE
        v_game_id:=rtrim(translate(encode(extensions.gen_random_bytes(18),'base64'),'+/','-_'),'=');
        SELECT coalesce(jsonb_agg(value ORDER BY key),'[]'::jsonb) INTO v_bank FROM jsonb_each(v_questions) WHERE coalesce((value->>'active')::boolean,false);
        SELECT board INTO v_board FROM public.ular_game_config WHERE singleton=true;v_board:=coalesce(v_board,'{"totalSteps":100,"snakes":{"17":7,"54":34,"62":19,"87":24,"93":73,"98":79},"ladders":{"3":22,"8":30,"20":41,"28":55,"50":69,"71":92}}'::jsonb);v_board_snakes:=v_board->'snakes';v_board_ladders:=v_board->'ladders';
        v_game:=jsonb_build_object('view',jsonb_build_object('id',v_game_id,'roomId',v_room_id,'status','playing','turnNumber',0,'currentPlayerId',NULL,'turnState','QUESTION','players',v_room->'players','deadline',v_now,'diceResult',0,'totalSteps',coalesce((v_board->>'totalSteps')::integer,100),'snakes',v_board_snakes,'ladders',v_board_ladders),'answerIndex',0,'explanation','','results','{}'::jsonb,'bank',jsonb_build_object('items',v_bank));
        v_game:=public.ular_set_next_question(v_game,0,v_now);v_games:=v_games||jsonb_build_object(v_game_id,v_game);
        v_room:=jsonb_set(jsonb_set(v_room,'{status}','"playing"'::jsonb,true),'{gameId}',to_jsonb(v_game_id),true);v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true);
        FOR v_player IN SELECT value FROM jsonb_array_elements(v_room->'players') LOOP
          v_stat:=coalesce(v_stats->(v_player->>'id'),jsonb_build_object('gamesPlayed',0,'wins',0,'correctAnswers',0,'wrongAnswers',0,'timeouts',0));
          v_stats:=jsonb_set(v_stats,ARRAY[v_player->>'id'],jsonb_set(v_stat,'{gamesPlayed}',to_jsonb(coalesce((v_stat->>'gamesPlayed')::integer,0)+1),true),true);
        END LOOP;
        v_data:=v_game->'view';v_events:=jsonb_build_array(public.ular_event('room:state',v_game_id,0,v_room,v_now),public.ular_event('game:state',v_game_id,1,v_game->'view',v_now));v_changed:=true;
      END IF;
    ELSE
      IF v_room->>'mode'='local' AND v_room->>'hostId'=v_user_id THEN
        IF v_room->>'gameId' IS NOT NULL THEN v_games:=v_games-(v_room->>'gameId');END IF;
        v_rooms:=v_rooms-v_room_id;v_data:=jsonb_build_object('ok',true);v_events:=jsonb_build_array(public.ular_event('room:state',v_room->>'gameId',0,v_room,v_now));v_changed:=true;
      ELSE
        v_game_id:=v_room->>'gameId';v_game:=v_games->v_game_id;
        IF v_game IS NOT NULL THEN
          v_players:=v_game->'view'->'players';
          SELECT ordinality-1 INTO v_idx FROM jsonb_array_elements(v_players) WITH ORDINALITY q(value,ordinality) WHERE value->>'id'=v_user_id;
          IF v_idx IS NOT NULL THEN
            SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO v_players FROM jsonb_array_elements(v_players) WITH ORDINALITY q(value,ordinality) WHERE ordinality-1<>v_idx;
            v_game:=jsonb_set(v_game,'{view,players}',coalesce(v_players,'[]'::jsonb),true);
            IF jsonb_array_length(v_players)<=1 THEN
              v_player_id:=coalesce(v_players->0->>'id','');
              v_data:=jsonb_set(jsonb_set(jsonb_set(v_game,'{view,status}','"finished"'::jsonb,true),'{view,turnState}','"FINISHED"'::jsonb,true),'{view,winnerId}',to_jsonb(nullif(v_player_id,'')),true);
              v_game:=jsonb_set(v_data,'{view,question}','null'::jsonb,true);
            ELSIF v_game->'view'->>'currentPlayerId'=v_user_id THEN
              v_game:=public.ular_set_next_question(v_game,least(v_idx,jsonb_array_length(v_players)-1),v_now);
            END IF;
          END IF;
          v_games:=jsonb_set(v_games,ARRAY[v_game_id],v_game,true);v_events:=jsonb_build_array(public.ular_event('game:state',v_game_id,coalesce((v_game->'view'->>'turnNumber')::integer,0),v_game->'view',v_now));
        ELSE
          v_players:=v_room->'players';SELECT ordinality-1 INTO v_idx FROM jsonb_array_elements(v_players) WITH ORDINALITY q(value,ordinality) WHERE value->>'id'=v_user_id;
          SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO v_players FROM jsonb_array_elements(v_players) WITH ORDINALITY q(value,ordinality) WHERE ordinality-1<>v_idx;
          v_room:=jsonb_set(v_room,'{players}',v_players,true);
        END IF;
        v_players:=coalesce(v_game->'view'->'players',v_room->'players');
        IF v_room->>'hostId'=v_user_id AND jsonb_array_length(v_players)>0 THEN v_room:=jsonb_set(v_room,'{hostId}',v_players->0->'id',true);END IF;
        v_room:=jsonb_set(v_room,'{players}',v_players,true);
        IF jsonb_array_length(v_players)=0 THEN v_rooms:=v_rooms-v_room_id;v_games:=v_games-v_game_id;ELSE v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true);END IF;
        IF v_events='[]'::jsonb THEN v_events:=jsonb_build_array(public.ular_event('room:state',v_game_id,0,v_room,v_now));ELSE v_events:=v_events||jsonb_build_array(public.ular_event('room:state',v_game_id,coalesce((v_game->'view'->>'turnNumber')::integer,0),v_room,v_now));END IF;
        v_data:=jsonb_build_object('ok',true);v_changed:=true;
      END IF;
    END IF;
  ELSIF p_path LIKE '/games/%/question/answer' OR p_path LIKE '/games/%/dice/roll' OR (p_path LIKE '/rooms/%/sync' AND v_method='POST') THEN
    IF p_path LIKE '/rooms/%/sync' THEN
      v_sync:=true;v_ref:=split_part(p_path,'/',3);v_after:=greatest(0,coalesce((p_body->>'afterSequence')::bigint,0));
      SELECT key,value INTO v_room_id,v_room FROM jsonb_each(v_rooms) WHERE key=v_ref OR upper(value->>'code')=upper(v_ref) LIMIT 1;
    ELSE
      v_game_id:=split_part(p_path,'/',3);v_game:=v_games->v_game_id;
      IF v_game IS NULL THEN v_status:=404;v_error_code:='GAME_NOT_FOUND';v_error_message:='game not found';
      ELSE v_room_id:=v_game->'view'->>'roomId';v_room:=v_rooms->v_room_id;END IF;
    END IF;
    IF v_status=200 AND v_room IS NULL THEN v_status:=404;v_error_code:='ROOM_NOT_FOUND';v_error_message:='room not found';END IF;
    IF v_status=200 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_room->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id) THEN v_status:=403;v_error_code:='NOT_ROOM_MEMBER';v_error_message:='room membership required';END IF;
    IF v_status=200 AND v_sync THEN
      v_game_id:=coalesce(p_body->>'gameId',v_room->>'gameId');v_game:=v_games->v_game_id;
      IF v_game IS NOT NULL AND v_game->'view'->>'roomId'<>v_room_id THEN v_game:=NULL;v_status:=404;v_error_code:='GAME_NOT_FOUND';v_error_message:='game not found';END IF;
      IF v_game IS NOT NULL AND v_game->'view'->>'turnState'='QUESTION' AND (v_game->'view'->>'deadline')::timestamptz<=v_now THEN
        v_player_id:=v_game->'view'->>'currentPlayerId';
        v_result:=public.ular_resolve_question(v_game,v_player_id,v_game->'view'->'question'->>'id',NULL,v_now,true);
        IF v_result ? 'error' THEN v_status:=409;v_error_code:='INVALID_TURN_STATE';v_error_message:='expired question could not be resolved';
        ELSE
          v_game:=v_result->'game';v_games:=jsonb_set(v_games,ARRAY[v_game_id],v_game,true);v_events:=v_events||(v_result->'events');v_changed:=true;
          v_player:=v_game->'view'->'players'->((SELECT ordinality-1 FROM jsonb_array_elements(v_game->'view'->'players') WITH ORDINALITY q(value,ordinality) WHERE value->>'id'=v_player_id)::integer);
          v_users:=jsonb_set(v_users,ARRAY[v_player_id],v_player - 'position' - 'isConnected',true);
          v_stat:=coalesce(v_stats->v_player_id,jsonb_build_object('gamesPlayed',0,'wins',0,'correctAnswers',0,'wrongAnswers',0,'timeouts',0));
          v_stats:=jsonb_set(v_stats,ARRAY[v_player_id],jsonb_set(v_stat,'{timeouts}',to_jsonb(coalesce((v_stat->>'timeouts')::integer,0)+1),true),true);
          v_room:=jsonb_set(jsonb_set(v_room,'{status}',to_jsonb(v_game->'view'->>'status'),true),'{players}',v_game->'view'->'players',true);v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true);
        END IF;
      END IF;
      v_data:=jsonb_build_object('room',v_room,'game',v_game->'view','events','[]'::jsonb,'sequence',v_after,'serverTime',v_now);
    ELSIF v_status=200 THEN
      v_game:=v_games->v_game_id;
      IF v_game IS NULL THEN v_status:=404;v_error_code:='GAME_NOT_FOUND';v_error_message:='game not found';
      ELSE
        v_actor:=coalesce(nullif(p_body->>'playerId',''),v_user_id);
        IF v_actor<>v_user_id AND (v_room->>'mode'<>'local' OR v_room->>'hostId'<>v_user_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_room->'players') p WHERE p->>'id'=v_actor)) THEN
          v_status:=403;v_error_code:=CASE WHEN v_room->>'mode'='local' THEN 'NOT_ROOM_HOST' ELSE 'PLAYER_ID_NOT_ALLOWED' END;v_error_message:='only the host device can act for local players';
        ELSE
          -- Every game action advances an expired server deadline before validation.
          IF v_game->'view'->>'status'='playing' AND v_game->'view'->>'turnState'='QUESTION' AND (v_game->'view'->>'deadline')::timestamptz<=v_now THEN
            v_player_id:=v_game->'view'->>'currentPlayerId';
            v_result:=public.ular_resolve_question(v_game,v_player_id,v_game->'view'->'question'->>'id',NULL,v_now,true);
            v_game:=v_result->'game';v_events:=v_events||(v_result->'events');v_changed:=true;
            v_player:=v_game->'view'->'players'->((SELECT ordinality-1 FROM jsonb_array_elements(v_game->'view'->'players') WITH ORDINALITY q(value,ordinality) WHERE value->>'id'=v_player_id)::integer);
            v_users:=jsonb_set(v_users,ARRAY[v_player_id],v_player - 'position' - 'isConnected',true);
            v_stat:=coalesce(v_stats->v_player_id,jsonb_build_object('gamesPlayed',0,'wins',0,'correctAnswers',0,'wrongAnswers',0,'timeouts',0));
            v_stats:=jsonb_set(v_stats,ARRAY[v_player_id],jsonb_set(v_stat,'{timeouts}',to_jsonb(coalesce((v_stat->>'timeouts')::integer,0)+1),true),true);
            v_room:=jsonb_set(jsonb_set(v_room,'{status}',to_jsonb(v_game->'view'->>'status'),true),'{players}',v_game->'view'->'players',true);v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true);
          END IF;
          IF p_path LIKE '%/question/answer' THEN
            v_result:=public.ular_resolve_question(v_game,v_actor,p_body->>'questionId',nullif(p_body->>'answer','')::integer,v_now,false);
            IF v_result ? 'error' THEN
              v_error_code:=v_result->>'error';v_error_message:=CASE v_error_code WHEN 'NOT_PLAYER_TURN' THEN 'not your turn' WHEN 'QUESTION_MISMATCH' THEN 'question does not match the current turn' WHEN 'INVALID_TURN_STATE' THEN 'action is not available in the current turn state' WHEN 'INVALID_ANSWER' THEN 'answer must be a zero-based option index' ELSE 'player is not a member of this room' END;
              v_status:=CASE v_error_code WHEN 'NOT_PLAYER_TURN' THEN 403 WHEN 'INVALID_TURN_STATE' THEN 409 WHEN 'QUESTION_MISMATCH' THEN 409 WHEN 'INVALID_ANSWER' THEN 400 ELSE 403 END;
            ELSE
              v_game:=v_result->'game';v_data:=v_result->'result';v_events:=v_events||(v_result->'events');v_changed:=true;
              v_player_id:=v_data->>'playerId';v_player:=v_game->'view'->'players'->((SELECT ordinality-1 FROM jsonb_array_elements(v_game->'view'->'players') WITH ORDINALITY q(value,ordinality) WHERE value->>'id'=v_player_id)::integer);
              v_users:=jsonb_set(v_users,ARRAY[v_player_id],v_player-'position'-'isConnected',true);
              v_stat:=coalesce(v_stats->v_player_id,jsonb_build_object('gamesPlayed',0,'wins',0,'correctAnswers',0,'wrongAnswers',0,'timeouts',0));
              v_key:=CASE v_data->>'result' WHEN 'correct' THEN 'correctAnswers' WHEN 'wrong' THEN 'wrongAnswers' ELSE 'timeouts' END;
              v_stats:=jsonb_set(v_stats,ARRAY[v_player_id],jsonb_set(v_stat,ARRAY[v_key],to_jsonb(coalesce((v_stat->>v_key)::integer,0)+1),true),true);
              v_room:=jsonb_set(jsonb_set(v_room,'{status}',to_jsonb(v_game->'view'->>'status'),true),'{players}',v_game->'view'->'players',true);v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true);
            END IF;
          ELSE
            v_view:=v_game->'view';
            IF v_view->>'status'<>'playing' OR v_view->>'turnState'<>'DICE_UNLOCKED' THEN v_status:=409;v_error_code:='DICE_NOT_UNLOCKED';v_error_message:='dice is not unlocked';
            ELSIF v_view->>'currentPlayerId'<>v_actor THEN v_status:=403;v_error_code:='NOT_PLAYER_TURN';v_error_message:='not your turn';
            ELSE
              LOOP
                v_random_bytes:=extensions.gen_random_bytes(4);v_random:=(get_byte(v_random_bytes,0)::bigint<<24)+(get_byte(v_random_bytes,1)::bigint<<16)+(get_byte(v_random_bytes,2)::bigint<<8)+get_byte(v_random_bytes,3)::bigint;
                EXIT WHEN v_random<4294967292;
              END LOOP;
              v_dice:=(v_random%6)::integer+1;v_turn:=(v_view->>'turnNumber')::integer;
              v_view:=jsonb_set(jsonb_set(v_view,'{diceResult}',to_jsonb(v_dice),true),'{turnState}','"MOVING"'::jsonb,true);v_game:=jsonb_set(v_game,'{view}',v_view,true);
              v_events:=v_events||jsonb_build_array(public.ular_event('dice:rolled',v_game_id,v_turn,jsonb_build_object('playerId',v_actor,'value',v_dice),v_now),public.ular_event('game:state',v_game_id,v_turn,v_view,v_now),public.ular_event('player:move_started',v_game_id,v_turn,jsonb_build_object('playerId',v_actor),v_now));
              v_players:=v_view->'players';SELECT ordinality-1,value INTO v_idx,v_player FROM jsonb_array_elements(v_players) WITH ORDINALITY q(value,ordinality) WHERE value->>'id'=v_actor;
              v_pos:=coalesce((v_player->>'position')::integer,0);v_target:=v_pos+v_dice;
              IF v_target<=(v_view->>'totalSteps')::integer THEN
                WHILE v_pos<v_target LOOP
                  v_pos:=v_pos+1;v_player:=jsonb_set(v_player,'{position}',to_jsonb(v_pos),true);v_players:=jsonb_set(v_players,ARRAY[v_idx::text],v_player,true);v_events:=v_events||jsonb_build_array(public.ular_event('player:step',v_game_id,v_turn,jsonb_build_object('playerId',v_actor,'position',v_pos),v_now));
                END LOOP;
                v_dest:=coalesce((v_view->'snakes'->>v_pos::text)::integer,(v_view->'ladders'->>v_pos::text)::integer);
                IF v_dest IS NOT NULL THEN
                  IF (v_view->'snakes') ? v_pos::text THEN v_events:=v_events||jsonb_build_array(public.ular_event('snake:triggered',v_game_id,v_turn,jsonb_build_object('playerId',v_actor,'from',v_pos,'to',v_dest),v_now));
                  ELSE v_events:=v_events||jsonb_build_array(public.ular_event('ladder:triggered',v_game_id,v_turn,jsonb_build_object('playerId',v_actor,'from',v_pos,'to',v_dest),v_now));END IF;
                  v_pos:=v_dest;v_player:=jsonb_set(v_player,'{position}',to_jsonb(v_pos),true);v_players:=jsonb_set(v_players,ARRAY[v_idx::text],v_player,true);v_events:=v_events||jsonb_build_array(public.ular_event('player:step',v_game_id,v_turn,jsonb_build_object('playerId',v_actor,'position',v_pos),v_now));
                END IF;
              END IF;
              v_events:=v_events||jsonb_build_array(public.ular_event('player:moved',v_game_id,v_turn,jsonb_build_object('playerId',v_actor,'position',v_pos),v_now));v_view:=jsonb_set(v_view,'{players}',v_players,true);
              IF v_pos=(v_view->>'totalSteps')::integer THEN
                v_view:=jsonb_set(jsonb_set(jsonb_set(v_view,'{status}','"finished"'::jsonb,true),'{turnState}','"FINISHED"'::jsonb,true),'{winnerId}',to_jsonb(v_actor),true);v_view:=jsonb_set(v_view,'{question}','null'::jsonb,true);
                v_stat:=coalesce(v_stats->v_actor,jsonb_build_object('gamesPlayed',0,'wins',0,'correctAnswers',0,'wrongAnswers',0,'timeouts',0));v_stats:=jsonb_set(v_stats,ARRAY[v_actor],jsonb_set(v_stat,'{wins}',to_jsonb(coalesce((v_stat->>'wins')::integer,0)+1),true),true);
              ELSE
                v_game:=jsonb_set(v_game,'{view}',v_view,true);v_game:=public.ular_set_next_question(v_game,(v_idx+1)%jsonb_array_length(v_players),v_now);v_view:=v_game->'view';
                v_events:=v_events||jsonb_build_array(public.ular_event('turn:changed',v_game_id,(v_view->>'turnNumber')::integer,jsonb_build_object('turnNumber',(v_view->>'turnNumber')::integer,'playerId',v_view->>'currentPlayerId'),v_now));
              END IF;
              v_game:=jsonb_set(v_game,'{view}',v_view,true);v_events:=v_events||jsonb_build_array(public.ular_event('game:state',v_game_id,(v_view->>'turnNumber')::integer,v_view,v_now));
              v_room:=jsonb_set(jsonb_set(v_room,'{status}',to_jsonb(v_view->>'status'),true),'{players}',v_view->'players',true);v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true);
              v_events:=v_events||jsonb_build_array(public.ular_event('room:state',v_game_id,(v_view->>'turnNumber')::integer,v_room,v_now));v_data:=jsonb_build_object('dice',v_dice);v_changed:=true;
            END IF;
          END IF;
          IF v_game IS NOT NULL THEN v_games:=jsonb_set(v_games,ARRAY[v_game_id],v_game,true);END IF;
        END IF;
      END IF;
    END IF;
  ELSE
    v_status:=501;v_error_code:='NOT_IMPLEMENTED';v_error_message:='API action is not installed yet';
  END IF;

  IF v_status<>200 THEN
    v_result:=jsonb_build_object('ok',false,'status',v_status,'error',jsonb_build_object('code',v_error_code,'message',v_error_message));
  ELSE
    v_result:=jsonb_build_object('ok',true,'status',200,'data',v_data);
  END IF;
  IF v_changed THEN
    v_state:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_state,'{users}',v_users,true),'{rooms}',v_rooms,true),'{games}',v_games,true),'{stats}',v_stats,true);
    UPDATE public.ular_server_state SET state=v_state,version=version,updated_at=v_now WHERE id=1;
    IF NOT FOUND THEN INSERT INTO public.ular_server_state(id,version,state,updated_at) VALUES(1,1,v_state,v_now);END IF;
    FOR v_event IN SELECT value FROM jsonb_array_elements(v_events) LOOP
      v_seq:=public.ular_append_event(v_room_id, v_event->>'gameId',v_event);
    END LOOP;
    DELETE FROM public.ular_room_events WHERE room_id=v_room_id AND sequence <= greatest(0,coalesce((SELECT sequence FROM public.ular_room_counters WHERE room_id=v_room_id),0)-1000);
  END IF;
  IF v_sync AND v_status=200 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('sequence',sequence)||event ORDER BY sequence),'[]'::jsonb) INTO v_sync_events FROM public.ular_room_events WHERE room_id=v_room_id AND sequence>v_after;
    SELECT coalesce(sequence,0) INTO v_maxseq FROM public.ular_room_counters WHERE room_id=v_room_id;
    v_sync_events:=coalesce(v_sync_events,'[]'::jsonb);
    v_result:=jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('room',v_room,'game',v_games->v_game_id->'view','events',v_sync_events,'sequence',v_maxseq,'serverTime',v_now,'resyncRequired',v_resync));
  END IF;
  INSERT INTO public.ular_rpc_requests(principal,request_id,fingerprint,response,expires_at)
  VALUES(v_principal,v_request,v_fingerprint,v_result,v_now+interval '24 hours')
  ON CONFLICT(principal,request_id) DO NOTHING;
  RETURN v_result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR array_subscript_error THEN
  RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','invalid request parameters'));
END $$;
REVOKE ALL ON FUNCTION public.ular_api(text,text,jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ular_api(text,text,jsonb,text,text,text) TO anon,authenticated;
