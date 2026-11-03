-- REVIEW ONLY. Requires profile-privacy.sql and inspected baseline tables.
-- Not a production migration. Execute only in an isolated database until release approval.
begin;
create schema if not exists sf_private;
revoke all on schema sf_private from public, anon;
grant usage on schema sf_private to authenticated;
create table sf_private.data_deletion_receipts (
 actor uuid not null references auth.users(id) on delete cascade,
 request_id uuid not null,
 scope text not null,
 profile_id uuid,
 result jsonb not null,
 created_at timestamptz not null default now(),
 primary key(actor, request_id)
);
alter table sf_private.data_deletion_receipts enable row level security;
revoke all on sf_private.data_deletion_receipts from public, anon, authenticated;

-- Elevated access is deliberately limited to this function: legacy AI tables are
-- denied to clients. No caller-supplied actor, no dynamic SQL, no arbitrary table/column.
create function sf_private.my_data(action text, profile_id uuid, scope text, request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
 v_actor uuid := auth.uid();
 output jsonb;
 receipt sf_private.data_deletion_receipts%rowtype;
 removed bigint := 0;
 removed_summaries bigint := 0;
begin
 if v_actor is null or coalesce((nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'is_anonymous')::boolean,false) then
  raise exception 'authentication_required' using errcode='42501';
 end if;
 if action = 'read' then
  if profile_id is not null or scope is not null or request_id is not null then raise exception 'invalid_read_arguments'; end if;
  select jsonb_build_object(
   'version',1, 'exported_at',now(),
   'profiles',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'sex',p.sex,'age',p.age,'height_cm',p.height_cm,'start_weight_kg',p.start_weight_kg,'target_weight_kg',p.target_weight_kg,'goal',p.goal,'activity_level',p.activity_level,'diet_mode',p.diet_mode,'baby_age_months',p.baby_age_months,'excluded_foods',p.excluded_foods,'meal_choices',p.meal_choices,'created_at',p.created_at) order by p.created_at,p.id) from public.family_profiles p where p.profile_owner_user_id=v_actor),'[]'::jsonb),
   'measurements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'profile_id',m.profile_id,'log_date',m.log_date,'weight',m.weight,'neck',m.neck,'chest',m.chest,'belly',m.belly,'hips',m.hips,'created_at',m.created_at) order by m.log_date,m.id) from public.family_measurements m join public.family_profiles p on p.id=m.profile_id where p.profile_owner_user_id=v_actor),'[]'::jsonb),
   'legacy_messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'role',m.role,'content',m.content,'created_at',m.created_at) order by m.created_at,m.id) from public.dietitian_messages m where m.user_id=v_actor),'[]'::jsonb),
   'legacy_summaries',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'week_start',m.week_start,'summary',m.summary,'created_at',m.created_at) order by m.created_at,m.id) from public.dietitian_summaries m where m.user_id=v_actor),'[]'::jsonb),
   'ai',jsonb_build_object('enabled',false,'memory_enabled',false,'consent_flow_available',false),
   'legacy_scope','account_archive_not_assigned_to_a_profile',
   'deletion_limits',jsonb_build_object('backups','unverified','external_provider','unverified')
  ) into output;
  if pg_catalog.octet_length(output::text)>5242880 then raise exception 'export_too_large'; end if;
  return output;
 end if;
 if action is distinct from 'delete' or request_id is null or scope is null or scope not in ('measurements','profile','legacy_ai') then raise exception 'invalid_action'; end if;
 if (scope='legacy_ai' and profile_id is not null) or (scope<>'legacy_ai' and profile_id is null) then raise exception 'invalid_scope'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_actor::text||request_id::text,0));
 select * into receipt from sf_private.data_deletion_receipts r where r.actor=v_actor and r.request_id=$4;
 if found then
  if receipt.scope is distinct from scope or receipt.profile_id is distinct from profile_id then raise exception 'request_id_reused'; end if;
  return receipt.result;
 end if;
 if scope<>'legacy_ai' then
  perform 1 from public.family_profiles p where p.id=profile_id and p.profile_owner_user_id=v_actor for update;
  if not found then raise exception 'not_available' using errcode='42501'; end if;
 end if;
 if scope='profile' then
  select count(*) into removed_summaries from public.family_measurements m where m.profile_id=$2;
  delete from public.family_profiles p where p.id=profile_id and p.profile_owner_user_id=v_actor;
  get diagnostics removed = row_count;
 elsif scope='measurements' then
  delete from public.family_measurements m where m.profile_id=$2;
  get diagnostics removed = row_count;
 else
  -- Both original messages and derived weekly summaries disappear in one transaction.
  delete from public.dietitian_messages m where m.user_id=v_actor;
  get diagnostics removed = row_count;
  delete from public.dietitian_summaries m where m.user_id=v_actor;
  get diagnostics removed_summaries = row_count;
 end if;
 output=jsonb_build_object('request_id',request_id,'scope',scope,'profile_id',profile_id,'status','active_database_deleted','removed',removed,'related_removed',removed_summaries,'completed_at',now(),'backups','unverified','external_provider','unverified');
 insert into sf_private.data_deletion_receipts(actor,request_id,scope,profile_id,result) values(v_actor,$4,$3,$2,output);
 return output;
end;
$$;
revoke all on function sf_private.my_data(text,uuid,text,uuid) from public,anon;
grant execute on function sf_private.my_data(text,uuid,text,uuid) to authenticated;
-- Public API wrapper is invoker, not an unrestricted definer in an exposed schema.
create function public.sf_my_data(action text default 'read', profile_id uuid default null, scope text default null, request_id uuid default null)
returns jsonb language sql security invoker set search_path='' as $$
 select sf_private.my_data(action,profile_id,scope,request_id);
$$;
revoke all on function public.sf_my_data(text,uuid,text,uuid) from public,anon;
grant execute on function public.sf_my_data(text,uuid,text,uuid) to authenticated;
commit;
