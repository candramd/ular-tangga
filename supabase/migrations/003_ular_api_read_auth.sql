-- First deployable slice of the static API: guest sessions and authorized reads.
-- Game mutations are deliberately added in later reviewed migrations.
CREATE OR REPLACE FUNCTION public.ular_api_reads(
  p_path text,
  p_method text DEFAULT 'GET',
  p_body jsonb DEFAULT '{}'::jsonb,
  p_session_token text DEFAULT NULL,
  p_admin_token text DEFAULT NULL,
  p_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  v_state jsonb;
  v_data jsonb;
  v_sessions jsonb;
  v_users jsonb;
  v_rooms jsonb;
  v_games jsonb;
  v_stats jsonb;
  v_token text;
  v_token_hash text;
  v_user_id text;
  v_user jsonb;
  v_room jsonb;
  v_game jsonb;
  v_ref text;
  v_game_id text;
  v_now timestamptz := clock_timestamp();
  v_id text;
  v_username text;
  v_result jsonb;
  v_arr jsonb;
  v_seq bigint;
  v_min_seq bigint;
  v_guest_request text;
  v_guest_fingerprint text;
  v_cached_fingerprint text;
  v_cached_response jsonb;
  v_cached_cipher bytea;
  v_crypto_key text;
BEGIN
  IF p_path IS NULL OR p_path !~ '^/(auth/(guest|me)|profile|leaderboard|rooms|rooms/current|rooms/[^/]+|rooms/[^/]+/sync|games/[^/]+/(state|question)|admin/session|admin/questions)(\?.*)?$' THEN
    RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','NOT_FOUND','message','not found'));
  END IF;
  IF coalesce(p_method,'GET') NOT IN ('GET','POST','DELETE') THEN
    RETURN jsonb_build_object('ok',false,'status',405,'error',jsonb_build_object('code','METHOD_NOT_ALLOWED','message','method not allowed'));
  END IF;
  IF p_path='/auth/guest' AND upper(p_method)='POST' AND NOT public.ular_writer_available() THEN
    RETURN jsonb_build_object('ok',false,'status',503,'error',jsonb_build_object('code','SERVICE_UNAVAILABLE','message','legacy server currently owns the writer'));
  END IF;
  SELECT state INTO v_state FROM public.ular_server_state WHERE id=1 FOR UPDATE;
  IF v_state IS NULL THEN
    v_state := jsonb_build_object('users','{}'::jsonb,'sessions','{}'::jsonb,'rooms','{}'::jsonb,'games','{}'::jsonb,'requests','{}'::jsonb,'stats','{}'::jsonb,'questions','{}'::jsonb,'adminSessions','{}'::jsonb,'localStudentOwners','{}'::jsonb,'localStudentRoster','{}'::jsonb);
  END IF;
  v_users := coalesce(v_state->'users','{}'::jsonb);
  v_sessions := coalesce(v_state->'sessions','{}'::jsonb);
  v_rooms := coalesce(v_state->'rooms','{}'::jsonb);
  v_games := coalesce(v_state->'games','{}'::jsonb);
  v_stats := coalesce(v_state->'stats','{}'::jsonb);

  IF p_path='/auth/guest' AND upper(p_method)='POST' THEN
    v_guest_request:=coalesce(p_request_id,p_body->>'requestId');
    IF v_guest_request IS NULL OR length(v_guest_request)<16 OR length(v_guest_request)>128 THEN
      RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','guest requestId must contain 16 to 128 characters'));
    END IF;
    v_username := btrim(p_body->>'username');
    IF v_username IS NULL OR char_length(v_username)<2 OR char_length(v_username)>24 OR v_username ~ '[[:cntrl:]]' THEN
      RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','username must contain 2 to 24 characters without control characters'));
    END IF;
    v_guest_fingerprint:=encode(extensions.digest(convert_to('POST /auth/guest '||jsonb_build_object('requestId',v_guest_request,'username',v_username)::text,'UTF8'),'sha256'),'hex');
    SELECT fingerprint,response,token_cipher INTO v_cached_fingerprint,v_cached_response,v_cached_cipher FROM public.ular_rpc_requests WHERE principal='guest' AND request_id=v_guest_request AND expires_at>v_now FOR UPDATE;
    IF FOUND THEN
      IF v_cached_fingerprint<>v_guest_fingerprint THEN RETURN jsonb_build_object('ok',false,'status',409,'error',jsonb_build_object('code','REQUEST_ID_CONFLICT','message','requestId already used with a different action or payload')); END IF;
      SELECT encryption_key INTO v_crypto_key FROM public.ular_rpc_crypto WHERE singleton=true;
      RETURN v_cached_response||jsonb_build_object('meta',jsonb_build_object('sessionToken',extensions.pgp_sym_decrypt(v_cached_cipher,v_crypto_key)));
    END IF;
    v_token := rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'=');
    v_token_hash := encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex');
    v_id := rtrim(translate(encode(extensions.gen_random_bytes(18),'base64'),'+/','-_'),'=');
    v_user := jsonb_build_object('id',v_id,'username',v_username,'xp',0,'coins',0,'level',1);
    v_state := jsonb_set(v_state,'{users}',v_users || jsonb_build_object(v_id,v_user),true);
    v_state := jsonb_set(v_state,'{stats}',v_stats || jsonb_build_object(v_id,jsonb_build_object('gamesPlayed',0,'wins',0,'correctAnswers',0,'wrongAnswers',0,'timeouts',0)),true);
    v_state := jsonb_set(v_state,'{sessions}',v_sessions || jsonb_build_object(v_token_hash,jsonb_build_object('userId',v_id,'expires',to_jsonb(v_now+interval '30 days'))),true);
    INSERT INTO public.ular_server_state(id,version,state,updated_at) VALUES(1,1,v_state,v_now)
    ON CONFLICT(id) DO UPDATE SET version=public.ular_server_state.version,state=excluded.state,updated_at=excluded.updated_at;
    SELECT encryption_key INTO v_crypto_key FROM public.ular_rpc_crypto WHERE singleton=true;
    v_result:=jsonb_build_object('ok',true,'status',200,'data',v_user);
    INSERT INTO public.ular_rpc_requests(principal,request_id,fingerprint,response,token_cipher,expires_at)
    VALUES('guest',v_guest_request,v_guest_fingerprint,v_result,extensions.pgp_sym_encrypt(v_token,v_crypto_key),v_now+interval '24 hours');
    RETURN v_result||jsonb_build_object('meta',jsonb_build_object('sessionToken',v_token));
  END IF;

  IF p_session_token IS NULL OR length(p_session_token)<32 THEN
    RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','guest session required'));
  END IF;
  v_token_hash := encode(extensions.digest(convert_to(p_session_token,'UTF8'),'sha256'),'hex');
  IF NOT (v_sessions ? v_token_hash) OR coalesce((v_sessions->v_token_hash->>'expires')::timestamptz,'epoch'::timestamptz)<=v_now THEN
    RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','guest session expired or invalid'));
  END IF;
  v_user_id := v_sessions->v_token_hash->>'userId';
  v_user := v_users->v_user_id;
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','guest session invalid'));
  END IF;

  IF p_path IN ('/auth/me','/auth/me?') AND upper(p_method)='GET' THEN
    RETURN jsonb_build_object('ok',true,'status',200,'data',v_user);
  ELSIF p_path='/profile' AND upper(p_method)='GET' THEN
    RETURN jsonb_build_object('ok',true,'status',200,'data',v_user || jsonb_build_object('stats',coalesce(v_stats->v_user_id,jsonb_build_object('gamesPlayed',0,'wins',0,'correctAnswers',0,'wrongAnswers',0,'timeouts',0))));
  ELSIF p_path='/leaderboard' AND upper(p_method)='GET' THEN
    SELECT coalesce(jsonb_agg(row_value ORDER BY correct DESC, lower(username), id),'[]'::jsonb) INTO v_arr
    FROM (
      SELECT jsonb_build_object('id',e.id,'username',e.username,'correctAnswers',e.correct,'rank',e.rank_value) row_value,e.correct,e.username,e.id
      FROM (
        SELECT u.key id,u.value->>'username' username,coalesce((s.value->>'correctAnswers')::integer,0) correct,
          rank() OVER (ORDER BY coalesce((s.value->>'correctAnswers')::integer,0) DESC) rank_value
        FROM jsonb_each(v_users) u LEFT JOIN jsonb_each(v_stats) s ON s.key=u.key
      ) e
    ) ranked;
    RETURN jsonb_build_object('ok',true,'status',200,'data',v_arr);
  ELSIF p_path='/rooms' AND upper(p_method)='GET' THEN
    SELECT coalesce(jsonb_agg(value ORDER BY key),'[]'::jsonb) INTO v_arr FROM jsonb_each(v_rooms)
    WHERE value->>'status'='waiting' AND coalesce((value->>'isPublic')::boolean,false);
    RETURN jsonb_build_object('ok',true,'status',200,'data',v_arr);
  ELSIF p_path='/rooms/current' AND upper(p_method)='GET' THEN
    SELECT value INTO v_room FROM jsonb_each(v_rooms) WHERE value->>'status'<>'finished' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(coalesce(value->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id
    ) LIMIT 1;
    RETURN jsonb_build_object('ok',true,'status',200,'data',v_room);
  ELSIF p_path LIKE '/rooms/%' AND p_path NOT LIKE '%/sync' AND upper(p_method)='GET' THEN
    v_ref := split_part(p_path,'/',3);
    SELECT value INTO v_room FROM jsonb_each(v_rooms) WHERE key=v_ref OR upper(value->>'code')=upper(v_ref) LIMIT 1;
    IF v_room IS NULL THEN RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','ROOM_NOT_FOUND','message','room not found')); END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_room->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id) THEN
      IF v_room->>'status'='waiting' AND coalesce((v_room->>'isPublic')::boolean,false) THEN
        RETURN jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('id',v_room->'id','code',v_room->'code','status',v_room->'status','isPublic',v_room->'isPublic','players',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p->'id','username',p->'username','level',p->'level','position',0,'isConnected',false)),'[]'::jsonb) FROM jsonb_array_elements(coalesce(v_room->'players','[]'::jsonb)) p)));
      END IF;
      RETURN jsonb_build_object('ok',false,'status',403,'error',jsonb_build_object('code','NOT_ROOM_MEMBER','message','room membership required'));
    END IF;
    RETURN jsonb_build_object('ok',true,'status',200,'data',v_room);
  ELSIF p_path LIKE '/games/%/state' AND upper(p_method)='GET' THEN
    v_game_id := split_part(p_path,'/',3);
    v_game := v_games->v_game_id;
    IF v_game IS NULL THEN RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','GAME_NOT_FOUND','message','game not found')); END IF;
    v_room := v_rooms->(v_game->'view'->>'roomId');
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_room->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id) THEN
      RETURN jsonb_build_object('ok',false,'status',403,'error',jsonb_build_object('code','NOT_ROOM_MEMBER','message','room membership required'));
    END IF;
    RETURN jsonb_build_object('ok',true,'status',200,'data',v_game->'view');
  ELSIF p_path LIKE '/games/%/question' AND upper(p_method)='GET' THEN
    v_game_id := split_part(p_path,'/',3);
    v_game := v_games->v_game_id;
    IF v_game IS NULL THEN RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','GAME_NOT_FOUND','message','game not found')); END IF;
    v_room := v_rooms->(v_game->'view'->>'roomId');
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_room->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id) THEN
      RETURN jsonb_build_object('ok',false,'status',403,'error',jsonb_build_object('code','NOT_ROOM_MEMBER','message','room membership required'));
    END IF;
    IF v_game->'view'->'question' IS NULL OR v_game->'view'->'question'='null'::jsonb THEN
      RETURN jsonb_build_object('ok',false,'status',409,'error',jsonb_build_object('code','CONFLICT','message','no active question'));
    END IF;
    RETURN jsonb_build_object('ok',true,'status',200,'data',v_game->'view'->'question');
  ELSIF p_path LIKE '/rooms/%/sync' AND upper(p_method)='GET' THEN
    v_ref := split_part(p_path,'/',3);
    SELECT value INTO v_room FROM jsonb_each(v_rooms) WHERE key=v_ref OR upper(value->>'code')=upper(v_ref) LIMIT 1;
    IF v_room IS NULL THEN RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','ROOM_NOT_FOUND','message','room not found')); END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v_room->'players','[]'::jsonb)) p WHERE p->>'id'=v_user_id) THEN
      RETURN jsonb_build_object('ok',false,'status',403,'error',jsonb_build_object('code','NOT_ROOM_MEMBER','message','room membership required'));
    END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('sequence',sequence) || event ORDER BY sequence),'[]'::jsonb) INTO v_arr FROM public.ular_room_events WHERE room_id=v_room->>'id' AND sequence>coalesce((p_body->>'afterSequence')::bigint,0);
    SELECT coalesce(sequence,0) INTO v_seq FROM public.ular_room_counters WHERE room_id=v_room->>'id';
    SELECT coalesce(min(sequence),coalesce(v_seq,0)+1) INTO v_min_seq FROM public.ular_room_events WHERE room_id=v_room->>'id';
    v_game := v_games->(v_room->>'gameId');
    RETURN jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('room',v_room,'game',v_game->'view','events',coalesce(v_arr,'[]'::jsonb),'sequence',coalesce(v_seq,0),'serverTime',v_now,'resyncRequired',coalesce((p_body->>'afterSequence')::bigint,0)>coalesce(v_seq,0) OR coalesce((p_body->>'afterSequence')::bigint,0)<v_min_seq-1));
  END IF;
  RETURN jsonb_build_object('ok',false,'status',501,'error',jsonb_build_object('code','NOT_IMPLEMENTED','message','API action is not installed yet'));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','invalid request parameters'));
END $$;
REVOKE ALL ON FUNCTION public.ular_api_reads(text,text,jsonb,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ular_api_reads(text,text,jsonb,text,text,text) TO postgres;
