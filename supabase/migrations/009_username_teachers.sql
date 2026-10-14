-- Username/password teacher identities, stable game sessions, and private question banks.
-- Teacher roles are provisioned from auth.uid(); no browser metadata grants access.
CREATE TABLE IF NOT EXISTS public.ular_teacher_roles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'teacher' CHECK (role IN ('teacher','student')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.ular_teacher_questions (
  id text NOT NULL,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question jsonb NOT NULL CHECK (jsonb_typeof(question) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,id)
);
-- A gameplay-safe projection for the shared question picker. It has no answer
-- index or explanation; access remains RPC-only even though its columns are safe.
CREATE TABLE IF NOT EXISTS public.ular_playable_questions (
  id text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  question text NOT NULL,
  options jsonb NOT NULL,
  category text NOT NULL,
  difficulty text NOT NULL,
  time_limit integer NOT NULL,
  active boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS ular_teacher_questions_owner_question_uq
  ON public.ular_teacher_questions(owner_id,lower(btrim(question->>'question')));
CREATE OR REPLACE FUNCTION public.ular_is_username_auth_user(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id=p_user_id
      AND NOT coalesce(u.is_anonymous,false)
      AND u.raw_app_meta_data->>'provider'='email'
      AND coalesce(u.encrypted_password,'')<>''
      AND u.email ~ '^[a-z0-9][a-z0-9._-]{1,22}[a-z0-9]@accounts\.ular-tangga\.invalid$'
      AND position('..' in split_part(u.email,'@',1))=0
  )
$$;
REVOKE ALL ON FUNCTION public.ular_is_username_auth_user(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_is_username_auth_user(uuid) TO postgres;
ALTER TABLE public.ular_teacher_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ular_teacher_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ular_playable_questions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ular_teacher_roles, public.ular_teacher_questions, public.ular_playable_questions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ular_teacher_roles, public.ular_teacher_questions, public.ular_playable_questions TO postgres;

CREATE OR REPLACE FUNCTION public.ular_sync_playable_question()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN DELETE FROM public.ular_playable_questions WHERE owner_id=OLD.owner_id AND id=OLD.id; RETURN OLD; END IF;
  INSERT INTO public.ular_playable_questions(id,owner_id,question,options,category,difficulty,time_limit,active,updated_at)
  VALUES(NEW.id,NEW.owner_id,NEW.question->>'question',NEW.question->'options',coalesce(NEW.question->>'category','Umum'),coalesce(NEW.question->>'difficulty','mudah'),coalesce((NEW.question->>'timeLimit')::integer,30),coalesce((NEW.question->>'active')::boolean,true),NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,question=excluded.question,options=excluded.options,category=excluded.category,difficulty=excluded.difficulty,time_limit=excluded.time_limit,active=excluded.active,updated_at=excluded.updated_at;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.ular_sync_playable_question() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_sync_playable_question() TO postgres;
DROP TRIGGER IF EXISTS ular_sync_playable_question_trigger ON public.ular_teacher_questions;
CREATE TRIGGER ular_sync_playable_question_trigger AFTER INSERT OR UPDATE OR DELETE ON public.ular_teacher_questions FOR EACH ROW EXECUTE FUNCTION public.ular_sync_playable_question();

CREATE OR REPLACE FUNCTION public.ular_teacher_api(
  p_path text, p_method text, p_body jsonb, p_session_token text, p_request_id text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,extensions,auth
AS $$
DECLARE
  v_uid uuid:=auth.uid(); v_role text; v_active boolean; v_user auth.users%ROWTYPE; v_state jsonb;
  v_users jsonb; v_sessions jsonb; v_stats jsonb; v_token text; v_hash text;
  v_name text; v_question jsonb; v_id text; v_method text:=upper(coalesce(p_method,'GET'));
  v_questions jsonb; v_item jsonb; v_fields text[]:=ARRAY['question','options','answer','explanation','category','difficulty','timeLimit','active'];
  v_key text; v_options jsonb; v_response jsonb; v_request text; v_fingerprint text; v_cached_fp text; v_principal text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','Username and password sign-in required')); END IF;
  SELECT * INTO v_user FROM auth.users WHERE id=v_uid;
  IF v_user.id IS NULL OR NOT public.ular_is_username_auth_user(v_uid) THEN
    RETURN jsonb_build_object('ok',false,'status',403,'error',jsonb_build_object('code','FORBIDDEN','message','authenticated account required'));
  END IF;
  IF NOT ((p_path='/teacher/session' AND v_method IN ('GET','POST'))
      OR (p_path='/teacher/session/logout' AND v_method='POST')
      OR (p_path='/teacher/questions' AND v_method IN ('GET','POST'))
      OR (p_path ~ '^/teacher/questions/[^/]+$' AND v_method IN ('POST','DELETE'))) THEN
    RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','NOT_FOUND','message','not found'));
  END IF;
  INSERT INTO public.ular_teacher_roles(user_id,role) VALUES(v_uid,'teacher') ON CONFLICT(user_id) DO NOTHING;
  SELECT role,active INTO v_role,v_active FROM public.ular_teacher_roles WHERE user_id=v_uid;
  IF NOT coalesce(v_active,false) THEN RETURN jsonb_build_object('ok',false,'status',403,'error',jsonb_build_object('code','FORBIDDEN','message','teacher account is disabled')); END IF;

  IF p_path='/teacher/session' AND v_method='POST' THEN
    IF v_role IS DISTINCT FROM 'teacher' THEN RETURN jsonb_build_object('ok',false,'status',403,'error',jsonb_build_object('code','FORBIDDEN','message','teacher role required')); END IF;
    IF NOT public.ular_writer_available() THEN RETURN jsonb_build_object('ok',false,'status',503,'error',jsonb_build_object('code','SERVICE_UNAVAILABLE','message','game state writer unavailable')); END IF;
    SELECT state INTO v_state FROM public.ular_server_state WHERE id=1 FOR UPDATE;
    IF v_state IS NULL THEN v_state:=jsonb_build_object('users','{}'::jsonb,'sessions','{}'::jsonb,'stats','{}'::jsonb); END IF;
    v_users:=coalesce(v_state->'users','{}'::jsonb); v_sessions:=coalesce(v_state->'sessions','{}'::jsonb); v_stats:=coalesce(v_state->'stats','{}'::jsonb);
    v_name:=coalesce(nullif(v_users->v_uid::text->>'username',''),nullif(btrim(v_user.raw_user_meta_data->>'full_name'),''),nullif(btrim(v_user.raw_user_meta_data->>'name'),''),split_part(v_user.email,'@',1),'Pengajar');
    v_name:=left(v_name,24);
    v_users:=jsonb_set(v_users,ARRAY[v_uid::text],jsonb_build_object('id',v_uid::text,'username',v_name,'xp',coalesce((v_users->v_uid::text->>'xp')::integer,0),'coins',coalesce((v_users->v_uid::text->>'coins')::integer,0),'level',coalesce((v_users->v_uid::text->>'level')::integer,1),'classroomHost',true,'teacherRole',v_role),true);
    IF v_stats->v_uid::text IS NULL THEN v_stats:=jsonb_set(v_stats,ARRAY[v_uid::text],jsonb_build_object('gamesPlayed',0,'wins',0,'correctAnswers',0,'wrongAnswers',0,'timeouts',0),true); END IF;
    v_token:=NULL;
    IF p_session_token IS NOT NULL AND length(p_session_token)>=32 THEN
      v_hash:=encode(extensions.digest(convert_to(p_session_token,'UTF8'),'sha256'),'hex');
      IF v_sessions->v_hash->>'teacherId'=v_uid::text AND coalesce((v_sessions->v_hash->>'expires')::timestamptz,'epoch')>clock_timestamp() THEN v_token:=p_session_token; END IF;
    END IF;
    IF v_token IS NULL THEN
      v_token:=rtrim(translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),'=');
      v_hash:=encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex');
      v_sessions:=v_sessions||jsonb_build_object(v_hash,jsonb_build_object('userId',v_uid::text,'teacherId',v_uid::text,'expires',clock_timestamp()+interval '30 days'));
    END IF;
    v_state:=jsonb_set(jsonb_set(jsonb_set(v_state,'{users}',v_users,true),'{sessions}',v_sessions,true),'{stats}',v_stats,true);
    UPDATE public.ular_server_state SET state=v_state,version=version,updated_at=clock_timestamp() WHERE id=1;
    IF NOT FOUND THEN INSERT INTO public.ular_server_state(id,version,state,updated_at) VALUES(1,1,v_state,clock_timestamp()); END IF;
    RETURN jsonb_build_object('ok',true,'status',200,'data',v_users->v_uid::text,'meta',jsonb_build_object('sessionToken',v_token,'teacherRole',v_role));
  ELSIF p_path='/teacher/session' AND v_method='GET' THEN
    IF v_role IS DISTINCT FROM 'teacher' THEN RETURN jsonb_build_object('ok',false,'status',403,'error',jsonb_build_object('code','FORBIDDEN','message','teacher role required')); END IF;
    IF p_session_token IS NULL OR length(p_session_token)<32 THEN RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','teacher session required')); END IF;
    v_hash:=encode(extensions.digest(convert_to(p_session_token,'UTF8'),'sha256'),'hex');
    SELECT state INTO v_state FROM public.ular_server_state WHERE id=1;
    IF coalesce(v_state->'sessions'->v_hash->>'teacherId','')<>v_uid::text OR coalesce((v_state->'sessions'->v_hash->>'expires')::timestamptz,'epoch')<=clock_timestamp() THEN RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','teacher session expired or invalid')); END IF;
    RETURN jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('ok',true,'role',v_role,'userId',v_uid::text));
  ELSIF p_path='/teacher/session/logout' AND v_method='POST' THEN
    IF p_session_token IS NOT NULL AND length(p_session_token)>=32 THEN
      IF NOT public.ular_writer_available() THEN RETURN jsonb_build_object('ok',false,'status',503,'error',jsonb_build_object('code','SERVICE_UNAVAILABLE','message','game state writer unavailable')); END IF;
      v_hash:=encode(extensions.digest(convert_to(p_session_token,'UTF8'),'sha256'),'hex');
      SELECT state INTO v_state FROM public.ular_server_state WHERE id=1 FOR UPDATE;
      IF v_state->'sessions'->v_hash->>'teacherId'=v_uid::text THEN
        UPDATE public.ular_server_state SET state=jsonb_set(v_state,'{sessions}',coalesce(v_state->'sessions','{}'::jsonb)-v_hash,true),updated_at=clock_timestamp() WHERE id=1;
      END IF;
    END IF;
    RETURN jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('ok',true));
  END IF;

  IF v_role IS DISTINCT FROM 'teacher' THEN RETURN jsonb_build_object('ok',false,'status',403,'error',jsonb_build_object('code','FORBIDDEN','message','teacher access required')); END IF;
  IF p_session_token IS NULL OR length(p_session_token)<32 THEN RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','teacher session required')); END IF;
  v_hash:=encode(extensions.digest(convert_to(p_session_token,'UTF8'),'sha256'),'hex');
  SELECT state INTO v_state FROM public.ular_server_state WHERE id=1;
  IF coalesce(v_state->'sessions'->v_hash->>'teacherId','')<>v_uid::text OR coalesce((v_state->'sessions'->v_hash->>'expires')::timestamptz,'epoch')<=clock_timestamp() THEN RETURN jsonb_build_object('ok',false,'status',401,'error',jsonb_build_object('code','UNAUTHORIZED','message','teacher session expired or invalid')); END IF;
  IF v_method IN ('POST','DELETE') THEN
    IF NOT public.ular_writer_available() THEN RETURN jsonb_build_object('ok',false,'status',503,'error',jsonb_build_object('code','SERVICE_UNAVAILABLE','message','game state writer unavailable')); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('ular-teacher-bank:'||v_uid::text,0));
    v_request:=p_request_id;
    IF v_request IS NULL OR length(v_request)<1 OR length(v_request)>128 THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','requestId is required')); END IF;
    v_fingerprint:=encode(extensions.digest(convert_to(v_method||' '||p_path||' '||coalesce(p_body,'{}'::jsonb)::text,'UTF8'),'sha256'),'hex');
    v_principal:='teacher:'||v_uid::text;
    SELECT fingerprint,response INTO v_cached_fp,v_response FROM public.ular_rpc_requests WHERE principal=v_principal AND request_id=v_request AND expires_at>clock_timestamp() FOR UPDATE;
    IF FOUND THEN
      IF v_cached_fp<>v_fingerprint THEN RETURN jsonb_build_object('ok',false,'status',409,'error',jsonb_build_object('code','REQUEST_ID_CONFLICT','message','requestId already used for another action')); END IF;
      RETURN v_response;
    END IF;
  END IF;
  IF p_path='/teacher/questions' AND v_method='GET' THEN
    SELECT coalesce(jsonb_agg(question ORDER BY id),'[]'::jsonb) INTO v_questions FROM public.ular_teacher_questions WHERE owner_id=v_uid;
    RETURN jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('questions',v_questions));
  ELSIF p_path='/teacher/questions' AND v_method='POST' THEN
    v_id:='q-'||rtrim(translate(encode(extensions.gen_random_bytes(9),'base64'),'+/','-_'),'='); v_item:=p_body;
  ELSIF p_path ~ '^/teacher/questions/[^/]+$' AND v_method IN ('POST','DELETE') THEN
    v_id:=substring(p_path from '^/teacher/questions/([^/]+)$');
    IF v_method='DELETE' THEN
      DELETE FROM public.ular_teacher_questions WHERE owner_id=v_uid AND id=v_id;
      IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','NOT_FOUND','message','question not found')); END IF;
      v_response:=jsonb_build_object('ok',true,'status',200,'data',jsonb_build_object('ok',true));
      INSERT INTO public.ular_rpc_requests(principal,request_id,fingerprint,response,expires_at) VALUES(v_principal,v_request,v_fingerprint,v_response,clock_timestamp()+interval '24 hours') ON CONFLICT(principal,request_id) DO NOTHING;
      RETURN v_response;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.ular_teacher_questions WHERE owner_id=v_uid AND id=v_id) THEN RETURN jsonb_build_object('ok',false,'status',404,'error',jsonb_build_object('code','NOT_FOUND','message','question not found')); END IF;
    v_item:=p_body;
  ELSE RETURN jsonb_build_object('ok',false,'status',405,'error',jsonb_build_object('code','METHOD_NOT_ALLOWED','message','method not allowed'));
  END IF;
  IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','question payload is invalid'));
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_item) k WHERE NOT k=ANY(v_fields)) OR jsonb_typeof(v_item->'question') IS DISTINCT FROM 'string' THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','question payload is invalid')); END IF;
  v_name:=btrim(v_item->>'question');
  IF char_length(v_name) NOT BETWEEN 3 AND 500 OR v_name~'[[:cntrl:]]' THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','question must contain 3 to 500 characters')); END IF;
  IF jsonb_typeof(v_item->'options') IS DISTINCT FROM 'array' THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','options must contain 2 to 6 entries')); END IF;
  IF jsonb_array_length(v_item->'options') NOT BETWEEN 2 AND 6 THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','options must contain 2 to 6 entries')); END IF;
  IF jsonb_typeof(v_item->'answer') IS DISTINCT FROM 'number' OR coalesce(v_item->>'answer','') !~ '^[0-9]+$' OR (v_item->>'answer')::integer>=jsonb_array_length(v_item->'options') THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','answer must be a valid option index')); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_item->'options') o WHERE jsonb_typeof(o) IS DISTINCT FROM 'string' OR char_length(btrim(o#>>'{}')) NOT BETWEEN 1 AND 120 OR (o#>>'{}')~'[[:cntrl:]]') THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','answer options are invalid')); END IF;
  IF (SELECT count(DISTINCT lower(btrim(value#>>'{}'))) FROM jsonb_array_elements(v_item->'options'))<>jsonb_array_length(v_item->'options') THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','answer options must be unique')); END IF;
  IF jsonb_typeof(coalesce(v_item->'explanation','""'::jsonb)) NOT IN ('string','null') OR char_length(coalesce(v_item->>'explanation',''))>500 OR coalesce(v_item->>'explanation','')~'[[:cntrl:]]' THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','explanation must contain at most 500 characters')); END IF;
  IF jsonb_typeof(coalesce(v_item->'category','""'::jsonb)) NOT IN ('string','null') OR char_length(coalesce(v_item->>'category',''))>40 OR coalesce(v_item->>'category','')~'[[:cntrl:]]' THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','category must contain at most 40 characters')); END IF;
  IF coalesce(nullif(btrim(v_item->>'difficulty'),''),'mudah') NOT IN ('mudah','sedang','sulit') THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','difficulty must be mudah, sedang, or sulit')); END IF;
  IF jsonb_typeof(coalesce(v_item->'timeLimit','30'::jsonb)) NOT IN ('number','null') OR coalesce((v_item->>'timeLimit')::integer,30) NOT BETWEEN 10 AND 120 THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','timeLimit must be between 10 and 120 seconds')); END IF;
  IF v_item ? 'active' AND jsonb_typeof(v_item->'active') IS DISTINCT FROM 'boolean' THEN RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','active must be a boolean')); END IF;
  IF (SELECT count(*) FROM public.ular_teacher_questions WHERE owner_id=v_uid)>=200 AND NOT EXISTS(SELECT 1 FROM public.ular_teacher_questions WHERE owner_id=v_uid AND id=v_id) THEN RETURN jsonb_build_object('ok',false,'status',409,'error',jsonb_build_object('code','CONFLICT','message','question bank is full')); END IF;
  v_question:=jsonb_build_object('id',v_id,'question',v_name,'options',v_item->'options','answer',(v_item->>'answer')::integer,'explanation',btrim(coalesce(v_item->>'explanation','')),'category',coalesce(nullif(btrim(v_item->>'category'),''),'Umum'),'difficulty',coalesce(nullif(v_item->>'difficulty',''),'mudah'),'timeLimit',coalesce((v_item->>'timeLimit')::integer,30),'active',coalesce((v_item->>'active')::boolean,true),'updatedAt',clock_timestamp());
  INSERT INTO public.ular_teacher_questions(id,owner_id,question,updated_at) VALUES(v_id,v_uid,v_question,clock_timestamp()) ON CONFLICT(owner_id,id) DO UPDATE SET question=excluded.question,updated_at=excluded.updated_at;
  v_response:=jsonb_build_object('ok',true,'status',200,'data',v_question);
  INSERT INTO public.ular_rpc_requests(principal,request_id,fingerprint,response,expires_at) VALUES(v_principal,v_request,v_fingerprint,v_response,clock_timestamp()+interval '24 hours') ON CONFLICT(principal,request_id) DO NOTHING;
  RETURN v_response;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR array_subscript_error THEN
  RETURN jsonb_build_object('ok',false,'status',400,'error',jsonb_build_object('code','INVALID_REQUEST','message','question payload is invalid'));
WHEN unique_violation THEN
  RETURN jsonb_build_object('ok',false,'status',409,'error',jsonb_build_object('code','CONFLICT','message','an identical question already exists'));
END $$;
REVOKE ALL ON FUNCTION public.ular_teacher_api(text,text,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_teacher_api(text,text,jsonb,text,text) TO postgres;
REVOKE ALL ON FUNCTION public.ular_admin_api(text,text,jsonb,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ular_admin_api(text,text,jsonb,text,text,text) TO postgres;

-- Patch the already-installed JSON dispatcher atomically and fail closed if its shape changed.
DO $$
DECLARE v_def text; v_old text; v_new text; v_oid oid:='public.ular_api(text,text,jsonb,text,text,text)'::regprocedure;
BEGIN
  v_def:=pg_get_functiondef(v_oid);
  v_old:='  IF p_path LIKE ''/admin/%'' THEN' || E'\n    RETURN public.ular_admin_api(p_path,v_method,p_body,p_session_token,p_admin_token,p_request_id);' || E'\n  END IF;';
  v_new:='  IF p_path LIKE ''/teacher/%'' THEN RETURN public.ular_teacher_api(p_path,v_method,p_body,p_session_token,p_request_id); END IF;' || E'\n  IF p_path LIKE ''/admin/%'' THEN RETURN jsonb_build_object(''ok'',false,''status'',404,''error'',jsonb_build_object(''code'',''NOT_FOUND'',''message'',''not found'')); END IF;';
  IF position(v_new in v_def)=0 THEN
    IF (length(v_def)-length(replace(v_def,v_old,''))) / length(v_old) <> 1 THEN RAISE EXCEPTION 'ular_api admin route block changed'; END IF;
    v_def:=replace(v_def,v_old,v_new);
  END IF;
  EXECUTE v_def;
END $$;

-- The legacy read dispatcher handles logout before ordinary session resolution;
-- require the matching authenticated user before it can revoke a teacher-bound bearer.
DO $$
DECLARE v_def text; v_old text; v_new text; v_oid oid:='public.ular_api_reads(text,text,jsonb,text,text,text)'::regprocedure;
BEGIN
  v_def:=pg_get_functiondef(v_oid);
  v_old:='IF v_token_hash IS NOT NULL AND v_sessions ? v_token_hash THEN';
  v_new:=v_old || E'\n      IF v_sessions->v_token_hash ? ''teacherId'' AND (auth.uid() IS NULL OR v_sessions->v_token_hash->>''teacherId''<>auth.uid()::text) THEN RETURN jsonb_build_object(''ok'',false,''status'',401,''error'',jsonb_build_object(''code'',''UNAUTHORIZED'',''message'',''teacher identity/session mismatch'')); END IF;' || E'\n      IF v_sessions->v_token_hash ? ''teacherId'' AND (NOT EXISTS(SELECT 1 FROM public.ular_teacher_roles WHERE user_id=(v_sessions->v_token_hash->>''teacherId'')::uuid AND active AND role=''teacher'') OR NOT public.ular_is_username_auth_user((v_sessions->v_token_hash->>''teacherId'')::uuid)) THEN RETURN jsonb_build_object(''ok'',false,''status'',403,''error'',jsonb_build_object(''code'',''FORBIDDEN'',''message'',''teacher account is disabled or demoted'')); END IF;';
  IF position(v_new in v_def)=0 THEN
    IF (length(v_def)-length(replace(v_def,v_old,''))) / length(v_old)<>1 THEN RAISE EXCEPTION 'ular_api teacher logout guard point changed'; END IF;
    v_def:=replace(v_def,v_old,v_new);
  END IF;
  EXECUTE v_def;
END $$;

-- The authenticated teacher identity is tied to the opaque game bearer for every game route.
DO $$
DECLARE v_def text; v_old text; v_new text; v_oid oid:='public.ular_api(text,text,jsonb,text,text,text)'::regprocedure;
BEGIN
  v_def:=pg_get_functiondef(v_oid);
  v_old:='v_user_id:=v_sessions->v_token_hash->>''userId'';';
  v_new:=v_old || E'\n  IF v_sessions->v_token_hash ? ''teacherId'' AND (auth.uid() IS NULL OR v_sessions->v_token_hash->>''teacherId''<>auth.uid()::text) THEN RETURN jsonb_build_object(''ok'',false,''status'',401,''error'',jsonb_build_object(''code'',''UNAUTHORIZED'',''message'',''teacher identity/session mismatch'')); END IF;' || E'\n  IF v_sessions->v_token_hash ? ''teacherId'' AND (NOT EXISTS(SELECT 1 FROM public.ular_teacher_roles WHERE user_id=(v_sessions->v_token_hash->>''teacherId'')::uuid AND active AND role=''teacher'') OR NOT public.ular_is_username_auth_user((v_sessions->v_token_hash->>''teacherId'')::uuid)) THEN RETURN jsonb_build_object(''ok'',false,''status'',403,''error'',jsonb_build_object(''code'',''FORBIDDEN'',''message'',''teacher account is disabled or demoted'')); END IF;';
  IF position(v_new in v_def)=0 THEN
    IF position(v_old in v_def)=0 THEN RAISE EXCEPTION 'ular_api teacher session binding point changed'; END IF;
    v_def:=replace(v_def,v_old,v_new);
  END IF;
  -- Authenticate and validate the opaque game session before consulting the
  -- idempotency cache. A cache hit must never bypass expiry, user existence,
  -- or the authenticated account identity and active teacher-role binding.
  v_old:='  v_principal:=coalesce(v_state->''sessions''->v_token_hash->>''userId'',''guest'');';
  v_new:='  v_sessions:=coalesce(v_state->''sessions'',''{}''::jsonb);' || E'\n' ||
    '  IF NOT (v_sessions?v_token_hash) OR coalesce((v_sessions->v_token_hash->>''expires'')::timestamptz,''epoch''::timestamptz)<=v_now THEN RETURN jsonb_build_object(''ok'',false,''status'',401,''error'',jsonb_build_object(''code'',''UNAUTHORIZED'',''message'',''guest session expired or invalid'')); END IF;' || E'\n' ||
    '  v_user_id:=v_sessions->v_token_hash->>''userId'';' || E'\n' ||
    '  v_users:=coalesce(v_state->''users'',''{}''::jsonb);' || E'\n' ||
    '  IF v_users->v_user_id IS NULL THEN RETURN jsonb_build_object(''ok'',false,''status'',401,''error'',jsonb_build_object(''code'',''UNAUTHORIZED'',''message'',''guest session invalid'')); END IF;' || E'\n' ||
    '  IF v_sessions->v_token_hash ? ''teacherId'' AND (auth.uid() IS NULL OR v_sessions->v_token_hash->>''teacherId''<>auth.uid()::text) THEN RETURN jsonb_build_object(''ok'',false,''status'',401,''error'',jsonb_build_object(''code'',''UNAUTHORIZED'',''message'',''teacher identity/session mismatch'')); END IF;' || E'\n' ||
    '  IF v_sessions->v_token_hash ? ''teacherId'' AND (NOT EXISTS(SELECT 1 FROM public.ular_teacher_roles WHERE user_id=(v_sessions->v_token_hash->>''teacherId'')::uuid AND active AND role=''teacher'') OR NOT public.ular_is_username_auth_user((v_sessions->v_token_hash->>''teacherId'')::uuid)) THEN RETURN jsonb_build_object(''ok'',false,''status'',403,''error'',jsonb_build_object(''code'',''FORBIDDEN'',''message'',''teacher account is disabled or demoted'')); END IF;' || E'\n' ||
    '  v_principal:=coalesce(v_sessions->v_token_hash->>''userId'',''guest'');';
  IF position(v_new in v_def)=0 THEN
    IF position(v_old in v_def)=0 THEN RAISE EXCEPTION 'ular_api idempotency cache validation point changed'; END IF;
    v_def:=replace(v_def,v_old,v_new);
  END IF;
  v_old:='jsonb_build_object(''id'',v_room_id,''code'',v_code,''hostId'',v_user_id,''status'',''waiting'',''isPublic'',coalesce((p_body->>''isPublic'')::boolean,false),''players'',';
  v_new:='jsonb_build_object(''id'',v_room_id,''code'',v_code,''hostId'',v_user_id,''teacherId'',CASE WHEN v_sessions->v_token_hash->>''teacherId''=auth.uid()::text AND EXISTS(SELECT 1 FROM public.ular_teacher_roles WHERE user_id=auth.uid() AND active AND role=''teacher'') THEN auth.uid() END,''status'',''waiting'',''isPublic'',coalesce((p_body->>''isPublic'')::boolean,false),''players'',';
  IF position(v_new in v_def)=0 THEN
    IF position(v_old in v_def)=0 THEN RAISE EXCEPTION 'ular_api standard room ownership point changed'; END IF;
    v_def:=replace(v_def,v_old,v_new);
  END IF;
  v_old:='jsonb_build_object(''id'',v_room_id,''code'',v_code,''hostId'',v_user_id,''status'',''waiting'',''isPublic'',true,''players'',';
  v_new:='jsonb_build_object(''id'',v_room_id,''code'',v_code,''hostId'',v_user_id,''teacherId'',CASE WHEN v_sessions->v_token_hash->>''teacherId''=auth.uid()::text AND EXISTS(SELECT 1 FROM public.ular_teacher_roles WHERE user_id=auth.uid() AND active AND role=''teacher'') THEN auth.uid() END,''status'',''waiting'',''isPublic'',true,''players'',';
  IF position(v_new in v_def)=0 THEN IF position(v_old in v_def)=0 THEN RAISE EXCEPTION 'ular_api quick room ownership point changed'; END IF; v_def:=replace(v_def,v_old,v_new); END IF;
  v_old:='jsonb_build_object(''id'',v_room_id,''code'',v_code,''hostId'',v_user_id,''status'',''waiting'',''mode'',''local'',''isPublic'',false,';
  v_new:='jsonb_build_object(''id'',v_room_id,''code'',v_code,''hostId'',v_user_id,''teacherId'',CASE WHEN v_sessions->v_token_hash->>''teacherId''=auth.uid()::text AND EXISTS(SELECT 1 FROM public.ular_teacher_roles WHERE user_id=auth.uid() AND active AND role=''teacher'') THEN auth.uid() END,''status'',''waiting'',''mode'',''local'',''isPublic'',false,';
  IF position(v_new in v_def)=0 THEN IF position(v_old in v_def)=0 THEN RAISE EXCEPTION 'ular_api local room ownership point changed'; END IF; v_def:=replace(v_def,v_old,v_new); END IF;
  v_old:='SELECT coalesce(jsonb_agg(value ORDER BY key),''[]''::jsonb) INTO v_bank FROM jsonb_each(v_questions) WHERE coalesce((value->>''active'')::boolean,false);';
  v_new:='IF v_room->>''teacherId'' IS NOT NULL THEN SELECT coalesce(jsonb_agg(tq.question ORDER BY random()),''[]''::jsonb) INTO v_bank FROM public.ular_teacher_questions tq JOIN public.ular_teacher_roles tr ON tr.user_id=tq.owner_id AND tr.active AND tr.role=''teacher'' WHERE tq.owner_id=(v_room->>''teacherId'')::uuid AND coalesce((tq.question->>''active'')::boolean,false); ELSE SELECT coalesce(jsonb_agg(shared.item ORDER BY random()),''[]''::jsonb) INTO v_bank FROM (SELECT tq.question item FROM public.ular_teacher_questions tq JOIN public.ular_teacher_roles tr ON tr.user_id=tq.owner_id AND tr.active AND tr.role=''teacher'' WHERE coalesce((tq.question->>''active'')::boolean,false) UNION ALL SELECT jsonb_set(q.value,''{id}'',to_jsonb(''legacy-''||coalesce(q.value->>''id'',q.key)),true) FROM jsonb_each(v_questions) q WHERE coalesce((q.value->>''active'')::boolean,false)) shared; END IF;';
  IF position(v_new in v_def)=0 THEN IF position(v_old in v_def)=0 THEN RAISE EXCEPTION 'ular_api question bank selection point changed'; END IF; v_def:=replace(v_def,v_old,v_new); END IF;
  EXECUTE v_def;
END $$;

GRANT EXECUTE ON FUNCTION public.ular_api(text,text,jsonb,text,text,text) TO anon,authenticated;

-- The active games choose from each stored question bank's existing random
-- order. Do not sort by question ID, which would erase the random pool order.
DO $$
DECLARE v_def text; v_old text; v_new text; v_oid oid:='public.ular_set_next_question(jsonb,integer,timestamptz)'::regprocedure;
BEGIN
  v_def:=pg_get_functiondef(v_oid);
  v_old:='ORDER BY CASE WHEN value->>''id'' IS NOT NULL THEN value->>''id'' END, ord';
  v_new:='ORDER BY ord';
  IF position(v_new in v_def)=0 THEN
    IF position(v_old in v_def)=0 THEN RAISE EXCEPTION 'question bank ordering point changed'; END IF;
    v_def:=replace(v_def,v_old,v_new);
  END IF;
  EXECUTE v_def;
END $$;

-- Read RPCs must enforce the same JWT-to-session binding as mutations.
DO $$
DECLARE v_def text; v_old text; v_new text; v_start integer; v_end integer; v_oid oid:='public.ular_api_reads(text,text,jsonb,text,text,text)'::regprocedure;
BEGIN
  v_def:=pg_get_functiondef(v_oid);
  v_old:='v_user_id := v_sessions->v_token_hash->>''userId'';';
  v_new:=v_old || E'\n  IF v_sessions->v_token_hash ? ''teacherId'' AND (auth.uid() IS NULL OR v_sessions->v_token_hash->>''teacherId''<>auth.uid()::text) THEN RETURN jsonb_build_object(''ok'',false,''status'',401,''error'',jsonb_build_object(''code'',''UNAUTHORIZED'',''message'',''teacher identity/session mismatch'')); END IF;' || E'\n  IF v_sessions->v_token_hash ? ''teacherId'' AND (NOT EXISTS(SELECT 1 FROM public.ular_teacher_roles WHERE user_id=(v_sessions->v_token_hash->>''teacherId'')::uuid AND active AND role=''teacher'') OR NOT public.ular_is_username_auth_user((v_sessions->v_token_hash->>''teacherId'')::uuid)) THEN RETURN jsonb_build_object(''ok'',false,''status'',403,''error'',jsonb_build_object(''code'',''FORBIDDEN'',''message'',''teacher account is disabled or demoted'')); END IF;';
  IF position(v_new in v_def)=0 THEN
    IF position(v_old in v_def)=0 THEN RAISE EXCEPTION 'ular_api_reads teacher session binding point changed'; END IF;
    v_def:=replace(v_def,v_old,v_new);
  END IF;
  v_start:=position('ELSIF p_path=''/leaderboard'' AND upper(p_method)=''GET'' THEN' in v_def);
  v_end:=position('ELSIF p_path=''/rooms'' AND upper(p_method)=''GET'' THEN' in v_def);
  IF v_start=0 OR v_end<=v_start THEN RAISE EXCEPTION 'ular_api_reads leaderboard branch changed'; END IF;
  v_old:=substring(v_def FROM v_start FOR v_end-v_start);
  v_new:=E'ELSIF p_path=''/leaderboard'' AND upper(p_method)=''GET'' THEN\n    SELECT coalesce(jsonb_agg(row_value ORDER BY correct DESC, lower(username), id),''[]''::jsonb) INTO v_arr\n    FROM (\n      SELECT jsonb_build_object(''id'',e.id,''username'',e.username,''correctAnswers'',e.correct,''rank'',e.rank_value) row_value,e.correct,e.username,e.id\n      FROM (\n        SELECT u.key id,u.value->>''username'' username,coalesce((s.value->>''correctAnswers'')::integer,0) correct,\n          rank() OVER (ORDER BY coalesce((s.value->>''correctAnswers'')::integer,0) DESC) rank_value\n        FROM jsonb_each(v_users) u LEFT JOIN jsonb_each(v_stats) s ON s.key=u.key\n        WHERE coalesce((u.value->>''classroomHost'')::boolean,false)=false AND (u.key=v_user_id OR coalesce(v_state->''localStudentOwners''->>u.key,'''')=v_user_id OR EXISTS(SELECT 1 FROM jsonb_each(v_rooms) rr WHERE rr.value->>''status''<>''finished'' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(rr.value->''players'',''[]''::jsonb)) member(value) WHERE member.value->>''id''=v_user_id) AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(rr.value->''players'',''[]''::jsonb)) player(value) WHERE player.value->>''id''=u.key)))\n      ) e\n    ) ranked;\n    RETURN jsonb_build_object(''ok'',true,''status'',200,''data'',v_arr);\n  ';
  v_def:=replace(v_def,v_old,v_new);
  v_old:='SELECT coalesce(jsonb_agg(value ORDER BY key),''[]''::jsonb) INTO v_arr FROM jsonb_each(v_rooms)
    WHERE value->>''status''=''waiting'' AND coalesce((value->>''isPublic'')::boolean,false);';
  v_new:='SELECT coalesce(jsonb_agg(jsonb_build_object(''id'',value->''id'',''code'',value->''code'',''status'',value->''status'',''isPublic'',value->''isPublic'',''players'',(SELECT coalesce(jsonb_agg(jsonb_build_object(''id'',p->''id'',''username'',p->''username'',''level'',p->''level'',''position'',0,''isConnected'',false) ORDER BY ordinality),''[]''::jsonb) FROM jsonb_array_elements(coalesce(value->''players'',''[]''::jsonb)) WITH ORDINALITY member(p,ordinality))) ORDER BY key),''[]''::jsonb) INTO v_arr FROM jsonb_each(v_rooms) WHERE value->>''status''=''waiting'' AND coalesce((value->>''isPublic'')::boolean,false);';
  IF position(v_new in v_def)=0 THEN
    IF position(v_old in v_def)=0 THEN RAISE EXCEPTION 'ular_api_reads public room summary point changed'; END IF;
    v_def:=replace(v_def,v_old,v_new);
  END IF;
  EXECUTE v_def;
END $$;
