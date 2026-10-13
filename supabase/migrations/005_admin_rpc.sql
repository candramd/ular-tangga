-- Opaque bearer sessions and question-bank administration for static clients.
-- The secret digest and sessions remain behind this SECURITY DEFINER RPC.
ALTER TABLE public.ular_admin_config
  ADD COLUMN IF NOT EXISTS login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE public.ular_admin_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ular_admin_config FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ular_admin_config TO postgres;

CREATE OR REPLACE FUNCTION public.ular_admin_api(
  p_path text,
  p_method text,
  p_body jsonb,
  p_session_token text,
  p_admin_token text,
  p_request_id text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,extensions
AS $$
DECLARE
  v_method text:=upper(coalesce(p_method,'GET'));
  v_now timestamptz:=clock_timestamp();
  v_state jsonb;
  v_questions jsonb;
  v_sessions jsonb;
  v_admin_hash text;
  v_session_key text;
  v_session jsonb;
  v_secret text;
  v_request text;
  v_new_id text;
  v_question jsonb;
  v_question_text text;
  v_row jsonb;
  v_options jsonb;
  v_option text;
  v_seen text[]:='{}';
  v_answer integer;
  v_time_limit integer;
  v_status integer:=200;
  v_code text;
  v_message text;
  v_data jsonb;
  v_token text;
  v_custom_count integer;
  v_duplicate boolean;
  v_keys text[];
  v_key text;
  v_id text;
  v_fingerprint text;
  v_cached jsonb;
  v_cached_fp text;
  v_principal text;
  v_at timestamptz;
  v_idx integer;
  v_mutation boolean:=false;
BEGIN
  p_body:=coalesce(p_body,'{}'::jsonb);
  IF p_path NOT LIKE '/admin/%' THEN
    RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','NOT_FOUND','message','not found'));
  END IF;
  IF octet_length(coalesce(p_body,'{}'::jsonb)::text)>8192 THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','request body exceeds 8192 bytes'));
  END IF;
  IF NOT public.ular_writer_available() THEN
    RETURN jsonb_build_object('ok',false,'status',503,'error',jsonb_build_object('code','SERVICE_UNAVAILABLE','message','legacy server currently owns the writer'));
  END IF;
  SELECT state INTO v_state FROM public.ular_server_state WHERE id=1 FOR UPDATE;
  IF v_state IS NULL THEN
    v_state:=jsonb_build_object('users','{}'::jsonb,'sessions','{}'::jsonb,'rooms','{}'::jsonb,'games','{}'::jsonb,'requests','{}'::jsonb,'stats','{}'::jsonb,'questions','{}'::jsonb,'adminSessions','{}'::jsonb,'localStudentOwners','{}'::jsonb,'localStudentRoster','{}'::jsonb);
  END IF;
  v_questions:=coalesce(v_state->'questions','{}'::jsonb);
  v_sessions:=coalesce(v_state->'adminSessions','{}'::jsonb);

  IF p_path='/admin/session' AND v_method='POST' THEN
    IF (SELECT count(*) FROM public.ular_admin_config WHERE singleton)>0 THEN
      SELECT secret_hash,login_attempts,locked_until INTO v_admin_hash,v_custom_count,v_at FROM public.ular_admin_config WHERE singleton FOR UPDATE;
      IF v_at IS NOT NULL AND v_at>v_now THEN
        RETURN jsonb_build_object('ok',false,'status',429,'error',jsonb_build_object('code','RATE_LIMITED','message','too many admin login attempts; try again later'));
      END IF;
    ELSE
      RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','NOT_FOUND','message','not found'));
    END IF;
    IF jsonb_typeof(p_body) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','secret is required'));
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(p_body))<>1 OR NOT (p_body ? 'secret') OR jsonb_typeof(p_body->'secret') IS DISTINCT FROM 'string' OR btrim(p_body->>'secret')='' THEN
      RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','secret is required'));
    END IF;
    IF extensions.crypt(p_body->>'secret',v_admin_hash)<>v_admin_hash THEN
      UPDATE public.ular_admin_config SET login_attempts=coalesce(login_attempts,0)+1,
        locked_until=CASE WHEN coalesce(login_attempts,0)+1>=5 THEN v_now+interval '15 minutes' ELSE NULL END,
        updated_at=v_now WHERE singleton;
      RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','invalid admin secret'));
    END IF;
    UPDATE public.ular_admin_config SET login_attempts=0,locked_until=NULL,updated_at=v_now WHERE singleton;
    v_token:=rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'=');
    v_session_key:=encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex');
    v_sessions:=v_sessions||jsonb_build_object(v_session_key,jsonb_build_object('expires',v_now+interval '12 hours','secretDigest',encode(extensions.digest(convert_to(v_admin_hash,'UTF8'),'sha256'),'hex')));
    v_state:=jsonb_set(v_state,'{adminSessions}',v_sessions,true);
    UPDATE public.ular_server_state SET state=v_state,version=version,updated_at=v_now WHERE id=1;
    IF NOT FOUND THEN INSERT INTO public.ular_server_state(id,version,state,updated_at) VALUES(1,1,v_state,v_now);END IF;
    RETURN jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('ok',true),'meta',jsonb_build_object('adminToken',v_token));
  END IF;

  IF p_path='/admin/session/logout' AND v_method='POST' THEN
    IF p_admin_token IS NOT NULL THEN
      v_session_key:=encode(extensions.digest(convert_to(p_admin_token,'UTF8'),'sha256'),'hex');
      IF v_sessions ? v_session_key THEN
        v_sessions:=v_sessions-v_session_key;
        v_state:=jsonb_set(v_state,'{adminSessions}',v_sessions,true);
        UPDATE public.ular_server_state SET state=v_state,version=version,updated_at=v_now WHERE id=1;
        IF NOT FOUND THEN INSERT INTO public.ular_server_state(id,version,state,updated_at) VALUES(1,1,v_state, v_now);END IF;
      END IF;
    END IF;
    RETURN jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('ok',true));
  END IF;

  IF p_admin_token IS NULL OR length(p_admin_token)<32 OR length(p_admin_token)>256 THEN
    RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','admin session required'));
  END IF;
  v_session_key:=encode(extensions.digest(convert_to(p_admin_token,'UTF8'),'sha256'),'hex');
  v_session:=v_sessions->v_session_key;
  SELECT secret_hash INTO v_admin_hash FROM public.ular_admin_config WHERE singleton;
  IF v_session IS NULL OR coalesce((v_session->>'expires')::timestamptz,'epoch'::timestamptz)<=v_now OR v_admin_hash IS NULL OR v_session->>'secretDigest'<>encode(extensions.digest(convert_to(v_admin_hash,'UTF8'),'sha256'),'hex') THEN
    RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','admin session expired or invalid'));
  END IF;

  IF v_method IN ('POST','DELETE') AND p_path<>'/admin/session/logout' THEN
    v_request:=coalesce(p_request_id,p_body->>'requestId');
    IF v_request IS NULL OR length(v_request)<1 OR length(v_request)>128 THEN
      RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','requestId is required and must be at most 128 bytes'));
    END IF;
    v_fingerprint:=encode(extensions.digest(convert_to(v_method||' '||p_path||' '||p_body::text,'UTF8'),'sha256'),'hex');
    v_principal:='admin:'||v_session_key;
    SELECT fingerprint,response INTO v_cached_fp,v_cached FROM public.ular_rpc_requests
      WHERE principal=v_principal AND request_id=v_request AND expires_at>v_now FOR UPDATE;
    IF FOUND THEN
      IF v_cached_fp<>v_fingerprint THEN
        RETURN jsonb_build_object('ok',false,'status',409,'error',jsonb_build_object('code','REQUEST_ID_CONFLICT','message','requestId already used with a different action or payload'));
      END IF;
      RETURN v_cached;
    END IF;
  END IF;

  IF p_path='/admin/session' AND v_method='GET' THEN
    RETURN jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('ok',true,'persistenceEnabled',true));
  ELSIF p_path='/admin/questions' AND v_method='GET' THEN
    SELECT coalesce(jsonb_agg(value ORDER BY key),'[]'::jsonb) INTO v_data FROM jsonb_each(v_questions);
    RETURN jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('questions',v_data));
  ELSIF p_path='/admin/questions' AND v_method='POST' THEN
    v_id:='q-'||rtrim(translate(encode(extensions.gen_random_bytes(9),'base64'),'+/','-_'),'=');
    v_keys:=ARRAY['question','options','answer','explanation','category','difficulty','timeLimit','active'];
    v_mutation:=true;
  ELSIF p_path LIKE '/admin/questions/%' AND v_method IN ('POST','DELETE') THEN
    v_id:=substring(p_path FROM '^/admin/questions/([^/]+)$');
    IF v_id IS NULL OR v_id='' THEN RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','NOT_FOUND','message','question not found')); END IF;
    IF NOT (v_questions ? v_id) THEN RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','NOT_FOUND','message','question not found')); END IF;
    IF v_method='DELETE' THEN
      v_questions:=v_questions-v_id;
      v_state:=jsonb_set(v_state,'{questions}',v_questions,true);
      UPDATE public.ular_server_state SET state=v_state,version=version,updated_at=v_now WHERE id=1;
      IF NOT FOUND THEN INSERT INTO public.ular_server_state(id,version,state,updated_at) VALUES(1,1,v_state,v_now);END IF;
      v_data:=jsonb_build_object('ok',true);v_mutation:=true;
      v_state:=v_state;
      v_cached:=jsonb_build_object('ok',true,'status',200,'data',v_data);
      INSERT INTO public.ular_rpc_requests(principal,request_id,fingerprint,response,expires_at) VALUES(v_principal,v_request,v_fingerprint,v_cached,v_now+interval '24 hours') ON CONFLICT(principal,request_id) DO NOTHING;
      RETURN v_cached;
    END IF;
    v_keys:=ARRAY['question','options','answer','explanation','category','difficulty','timeLimit','active'];
    v_mutation:=true;
  ELSE
    RETURN jsonb_build_object('ok',false,'status',405,'error',jsonb_build_object('code','METHOD_NOT_ALLOWED','message','method not allowed'));
  END IF;

  IF jsonb_typeof(p_body)<>'object' THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','invalid question'));
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_body) LOOP
    IF NOT v_key=ANY(v_keys) THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','unknown question field')); END IF;
  END LOOP;
  IF jsonb_typeof(p_body->'question') IS DISTINCT FROM 'string' THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','question must be a string'));
  END IF;
  v_question_text:=btrim(p_body->>'question');
  IF char_length(v_question_text)<3 OR char_length(v_question_text)>500 OR v_question_text~'[[:cntrl:]]' THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','question must contain 3 to 500 characters without control characters'));
  END IF;
  v_options:=p_body->'options';
  IF jsonb_typeof(v_options) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','options must contain 2 to 6 entries'));
  END IF;
  IF jsonb_array_length(v_options)<2 OR jsonb_array_length(v_options)>6 THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','options must contain 2 to 6 entries'));
  END IF;
  FOR v_idx IN 0..jsonb_array_length(v_options)-1 LOOP
    IF jsonb_typeof(v_options->v_idx) IS DISTINCT FROM 'string' THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','options must be strings')); END IF;
    v_option:=btrim(v_options->>v_idx);
    IF v_option='' OR char_length(v_option)>120 OR v_option~'[[:cntrl:]]' OR lower(v_option)=ANY(v_seen) THEN
      RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','options must be non-empty, unique strings of at most 120 characters'));
    END IF;
    v_seen:=array_append(v_seen,lower(v_option));
    v_options:=jsonb_set(v_options,ARRAY[v_idx::text],to_jsonb(v_option),false);
  END LOOP;
  IF jsonb_typeof(p_body->'answer') IS DISTINCT FROM 'number' OR (p_body->>'answer')!~'^[0-9]+$' THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','answer must be a zero-based option index'));
  END IF;
  v_answer:=(p_body->>'answer')::integer;
  IF v_answer<0 OR v_answer>=jsonb_array_length(v_options) THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','answer must be a zero-based option index')); END IF;
  IF jsonb_typeof(coalesce(p_body->'explanation','""'::jsonb)) NOT IN ('string','null') OR char_length(btrim(coalesce(p_body->>'explanation','')))>500 THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','explanation must contain at most 500 characters'));
  END IF;
  IF jsonb_typeof(coalesce(p_body->'category','""'::jsonb)) NOT IN ('string','null') OR char_length(btrim(coalesce(p_body->>'category','')))>40 THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','category must contain at most 40 characters'));
  END IF;
  IF jsonb_typeof(coalesce(p_body->'difficulty','"mudah"'::jsonb)) NOT IN ('string','null') OR coalesce(nullif(btrim(p_body->>'difficulty'),''),'mudah') NOT IN ('mudah','sedang','sulit') THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','difficulty must be mudah, sedang, or sulit'));
  END IF;
  v_time_limit:=coalesce(nullif(p_body->>'timeLimit','')::integer,30);
  IF jsonb_typeof(coalesce(p_body->'timeLimit','30'::jsonb)) NOT IN ('number','null') THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','timeLimit must be between 10 and 120 seconds'));
  END IF;
  IF v_time_limit<=0 THEN v_time_limit:=30; END IF;
  IF v_time_limit<10 OR v_time_limit>120 THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','timeLimit must be between 10 and 120 seconds'));
  END IF;
  IF p_body ? 'active' AND jsonb_typeof(p_body->'active') NOT IN ('boolean','null') THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','active must be a boolean'));
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(v_questions) q WHERE q.key<>v_id AND lower(btrim(q.value->>'question'))=lower(v_question_text)) THEN
    RETURN jsonb_build_object('ok',false,'status',409,'error',jsonb_build_object('code','CONFLICT','message','an identical question already exists'));
  END IF;
  IF NOT (v_questions ? v_id) AND (SELECT count(*) FROM jsonb_each(v_questions))>=200 THEN
    RETURN jsonb_build_object('ok',false,'status',409,'error',jsonb_build_object('code','CONFLICT','message','question bank is full'));
  END IF;
  v_question:=jsonb_build_object('id',v_id,'question',v_question_text,'options',v_options,'answer',v_answer,
    'explanation',btrim(coalesce(p_body->>'explanation','')),'category',coalesce(nullif(btrim(p_body->>'category'),''),'Umum'),
    'difficulty',coalesce(nullif(btrim(p_body->>'difficulty'),''),'mudah'),'timeLimit',v_time_limit,
    'active',coalesce((p_body->>'active')::boolean,true),'updatedAt',v_now);
  v_questions:=jsonb_set(v_questions,ARRAY[v_id],v_question,true);
  v_state:=jsonb_set(v_state,'{questions}',v_questions,true);
  UPDATE public.ular_server_state SET state=v_state,version=version,updated_at=v_now WHERE id=1;
  IF NOT FOUND THEN INSERT INTO public.ular_server_state(id,version,state,updated_at) VALUES(1,1,v_state,v_now);END IF;
  v_cached:=jsonb_build_object('ok',true,'status',200,'data',v_question);
  IF v_mutation THEN
    INSERT INTO public.ular_rpc_requests(principal,request_id,fingerprint,response,expires_at) VALUES(v_principal,v_request,v_fingerprint,v_cached,v_now+interval '24 hours') ON CONFLICT(principal,request_id) DO NOTHING;
  END IF;
  RETURN v_cached;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR array_subscript_error THEN
  RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','invalid request parameters'));
END;
$$;

REVOKE ALL ON FUNCTION public.ular_admin_api(text,text,jsonb,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_admin_api(text,text,jsonb,text,text,text) TO postgres;
