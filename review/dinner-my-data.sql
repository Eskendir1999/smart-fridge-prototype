-- REVIEW ONLY: bridge for the separately reviewed My Data / owner privacy stage.
-- Not an automatically applied migration. Requires the dinner migration and a
-- confirmed owner column; never infer ownership or enable any release gate here.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ begin
 if not exists(select 1 from pg_catalog.pg_attribute where attrelid='public.family_profiles'::regclass
   and attname='profile_owner_user_id' and not attisdropped) then
  raise exception 'Confirmed owner schema is required';
 end if;
end $$;
alter table sf_private.dinner_operations add column profile_context_erased_at timestamptz;
create index dinner_operations_user_created_idx on sf_private.dinner_operations(user_id,created_at,id);

-- dinner_requirements holds FOR SHARE on each profile until its receipt commits.
-- DELETE waits for that lock, then this AFTER trigger sees and erases its receipt.
-- A later new consume/shopping cannot validate a profile which no longer exists.
-- Keep operation IDs, undo snapshots and shared inventory history: deleting a
-- receipt would allow a lost-response retry to execute the same UUID again.
create function sf_private.dinner_forget_deleted_profile() returns trigger
language plpgsql security definer set search_path='' as $$
declare owner_id uuid := nullif(to_jsonb(old)->>'profile_owner_user_id','')::uuid;
begin
 if owner_id is not null then
  update sf_private.dinner_operations o set payload='{}'::jsonb,profile_context_erased_at=now()
   where o.user_id=owner_id and o.payload @> jsonb_build_object('profiles',jsonb_build_array(jsonb_build_object('id',old.id)));
 end if;
 return old;
end $$;
revoke all on function sf_private.dinner_forget_deleted_profile() from public,anon,authenticated;
create trigger dinner_forget_deleted_profile after delete on public.family_profiles
 for each row execute function sf_private.dinner_forget_deleted_profile();

-- Own action history remains exportable after leaving its former household.
-- Do not export raw stock snapshots: those contain shared rows / other creators.
create function sf_private.dinner_my_data() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid(); output jsonb;
begin
 if actor is null or not exists(select 1 from auth.users u where u.id=actor
   and not coalesce((to_jsonb(u)->>'is_anonymous')::boolean,false)) then
  raise exception 'Permanent account required' using errcode='42501';
 end if;
 select jsonb_build_object('version',1,'exported_at',now(),
  'operations',coalesce((select jsonb_agg(jsonb_build_object(
    'id',o.id,'kind',o.kind,'created_at',o.created_at,'undone',o.undone,
    'profile_context_erased_at',o.profile_context_erased_at,
    'profiles',coalesce(o.payload->'profiles','[]'::jsonb),'meals',coalesce(o.payload->'meals','[]'::jsonb),
    'related_operation_id',o.payload->'operation_id',
    'lot_changes',coalesce((select jsonb_agg(jsonb_build_object('id',lot->'id','quantity',lot->'qty_num','unit',lot->'unit'))
      from jsonb_array_elements(o.after_lots) lot),'[]'::jsonb)) order by o.created_at,o.id)
    from sf_private.dinner_operations o where o.user_id=actor),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'reverses',e.reverses,
    'quantities',e.quantities,'created_at',e.created_at) order by e.created_at,e.id)
    from public.dinner_events e where e.user_id=actor),'[]'::jsonb),
  'limits',jsonb_build_object('scope','own_dinner_actions_only','shared_inventory_removed',false,
    'profile_deletion','private_request_context_erased; operation_ids_and_undo_preserved',
    'backups','unverified','account_retention','unverified')) into output;
 if pg_catalog.octet_length(output::text)>5242880 then raise exception 'export_too_large'; end if;
 return output;
end $$;
revoke all on function sf_private.dinner_my_data() from public,anon;
grant execute on function sf_private.dinner_my_data() to authenticated;
create function public.sf_dinner_my_data() returns jsonb
language sql stable security invoker set search_path='' as $$select sf_private.dinner_my_data()$$;
revoke all on function public.sf_dinner_my_data() from public,anon;
grant execute on function public.sf_dinner_my_data() to authenticated;
notify pgrst,'reload schema';
commit;
