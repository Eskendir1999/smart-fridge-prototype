-- Dietitian chat history: owner-only, kept for 14 days. The table stays closed to direct client access;
-- reads and writes go through this function, which also purges anything older than 14 days.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create function sf_private.dietitian_history(action text, msg_role text, msg_content text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid := sf_private.require_personal_actor(); out jsonb;
begin
 if action is null or action <> all(array['list','append','clear']) then raise exception 'invalid_action' using errcode='22023'; end if;
 delete from public.dietitian_messages m where m.user_id=actor and m.created_at < clock_timestamp() - interval '14 days';
 if action='list' then
  select coalesce(jsonb_agg(jsonb_build_object('role',x.role,'content',x.content,'created_at',x.created_at) order by x.created_at),'[]'::jsonb)
    into out from (select role,content,created_at from public.dietitian_messages m where m.user_id=actor order by m.created_at desc limit 200) x;
  return jsonb_build_object('messages',out,'keep_days',14);
 elsif action='append' then
  if msg_role is null or msg_role not in ('user','assistant') or msg_content is null
     or length(btrim(msg_content))=0 or length(msg_content)>4000 then
   raise exception 'invalid_message' using errcode='22023';
  end if;
  insert into public.dietitian_messages(user_id,role,content) values(actor,msg_role,msg_content);
  -- hard cap per user inside the 14-day window
  delete from public.dietitian_messages m where m.user_id=actor and m.id in
    (select id from public.dietitian_messages where user_id=actor order by created_at desc offset 400);
  return jsonb_build_object('status','saved');
 else
  delete from public.dietitian_messages m where m.user_id=actor;
  return jsonb_build_object('status','cleared');
 end if;
end; $$;
revoke all on function sf_private.dietitian_history(text,text,text) from public,anon;
grant execute on function sf_private.dietitian_history(text,text,text) to authenticated;

create function public.sf_dietitian_history(action text, msg_role text default null, msg_content text default null)
returns jsonb language sql security invoker set search_path='' as $$ select sf_private.dietitian_history(action,msg_role,msg_content); $$;
revoke all on function public.sf_dietitian_history(text,text,text) from public,anon;
grant execute on function public.sf_dietitian_history(text,text,text) to authenticated;
commit;
