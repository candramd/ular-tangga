-- Keep the JSON snapshot non-null when removing the final player from a room.
-- 006 passed SQL NULL to jsonb subtraction for a waiting room without a game,
-- then passed SQL NULL to jsonb_set when the last game member left.
DO $$
DECLARE
  v_signature regprocedure := 'public.ular_api(text,text,jsonb,text,text,text)'::regprocedure;
  v_definition text;
  v_body text;
  v_body_start integer;
  v_body_end integer;
  v_old_waiting text := $old$IF jsonb_array_length(v_players)=0 THEN v_rooms:=v_rooms-v_room_id;v_games:=v_games-v_game_id;ELSE v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true);END IF;$old$;
  v_new_waiting text := $new$IF jsonb_array_length(v_players)=0 THEN v_rooms:=v_rooms-v_room_id;IF v_game_id IS NOT NULL THEN v_games:=v_games-v_game_id;END IF;ELSE v_rooms:=jsonb_set(v_rooms,ARRAY[v_room_id],v_room,true);END IF;$new$;
  v_old_winner text := $old$'{view,winnerId}',to_jsonb(nullif(v_player_id,'')),true)$old$;
  v_new_winner text := $new$'{view,winnerId}',coalesce(to_jsonb(nullif(v_player_id,'')),'null'::jsonb),true)$new$;
  v_count integer;
BEGIN
  v_definition := pg_get_functiondef(v_signature);
  v_body := substring(v_definition FROM '\$function\$(.*)\$function\$');
  IF v_body IS NULL THEN RAISE EXCEPTION 'could not inspect public.ular_api body'; END IF;

  v_count := length(v_body)-length(replace(v_body,v_old_waiting,''));
  IF v_count=length(v_old_waiting) THEN
    v_body:=replace(v_body,v_old_waiting,v_new_waiting);
  ELSIF length(v_body)-length(replace(v_body,v_new_waiting,''))<>length(v_new_waiting) THEN
    RAISE EXCEPTION 'unexpected leave-room SQL body; refusing partial patch';
  END IF;

  v_count := length(v_body)-length(replace(v_body,v_old_winner,''));
  IF v_count=length(v_old_winner) THEN
    v_body:=replace(v_body,v_old_winner,v_new_winner);
  ELSIF length(v_body)-length(replace(v_body,v_new_winner,''))<>length(v_new_winner) THEN
    RAISE EXCEPTION 'unexpected winner SQL body; refusing partial patch';
  END IF;

  v_body_start:=strpos(v_definition,'$function$')+length('$function$');
  v_body_end:=v_body_start+strpos(substring(v_definition FROM v_body_start),'$function$')-1;
  IF v_body_start<=length('$function$') OR v_body_end<v_body_start THEN RAISE EXCEPTION 'could not reconstruct public.ular_api definition'; END IF;
  v_definition:=left(v_definition,v_body_start-1)||v_body||substring(v_definition FROM v_body_end);
  EXECUTE v_definition;
END $$;
