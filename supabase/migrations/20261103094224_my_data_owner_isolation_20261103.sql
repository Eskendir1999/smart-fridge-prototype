begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Owner privacy. Legacy profiles deliberately remain unassigned.
-- Accepted scope is read/export/controlled deletion; direct personal writes stay closed.
create schema if not exists sf_private;
revoke all on schema sf_private from public, anon;
grant usage on schema sf_private to authenticated;
create function sf_private.personal_actor() returns uuid
language sql stable security definer set search_path='' as $$
 select u.id from auth.users u join auth.sessions s on s.user_id=u.id
 where u.id=auth.uid() and not u.is_anonymous
 and not coalesce((nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'is_anonymous')::boolean,false)
 and s.id=(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')::uuid
 and (s.not_after is null or s.not_after>clock_timestamp())
$$;
revoke all on function sf_private.personal_actor() from public,anon;
grant execute on function sf_private.personal_actor() to authenticated;
-- Serialize sensitive operations with actual account/session removal, in this order.
create function sf_private.require_personal_actor() returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid(); sid uuid;
begin
 sid:=(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'session_id')::uuid;
 perform 1 from auth.users u where u.id=actor and not u.is_anonymous for share;
 if not found or coalesce((nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'is_anonymous')::boolean,false) then
  raise exception 'authentication_required' using errcode='42501';
 end if;
 perform 1 from auth.sessions s where s.id=sid and s.user_id=actor
  and (s.not_after is null or s.not_after>clock_timestamp()) for share;
 if not found then raise exception 'authentication_required' using errcode='42501'; end if;
 return actor;
end;
$$;
revoke all on function sf_private.require_personal_actor() from public,anon,authenticated;
alter table public.family_profiles add column profile_owner_user_id uuid references auth.users(id) on delete cascade;
create index family_profiles_owner_idx on public.family_profiles(profile_owner_user_id);
alter table public.family_profiles alter column household_id drop not null;
alter table public.family_profiles drop constraint family_profiles_household_id_fkey;
alter table public.family_profiles add constraint family_profiles_household_id_fkey foreign key(household_id) references public.households(id) on delete set null;
alter table public.family_profiles alter column created_by drop not null;
alter table public.family_profiles drop constraint family_profiles_created_by_fkey;
alter table public.family_profiles add constraint family_profiles_created_by_fkey foreign key(created_by) references auth.users(id) on delete set null;
alter table public.family_profiles enable row level security;
alter table public.family_measurements enable row level security;
alter table public.measurement_logs enable row level security;
revoke all on public.family_profiles,public.family_measurements,public.measurement_logs,public.dietitian_messages,public.dietitian_summaries from public,anon,authenticated;
grant select on public.family_profiles,public.family_measurements,public.measurement_logs to authenticated;
-- Restrictive policies remain effective alongside historical permissive policies.
create policy sf_private_profile_gate on public.family_profiles as restrictive for all to authenticated
 using(profile_owner_user_id=(select sf_private.personal_actor())) with check(false);
create policy sf_private_profile_owner on public.family_profiles for select to authenticated
 using(profile_owner_user_id=(select sf_private.personal_actor()));
create policy sf_private_measurement_gate on public.family_measurements as restrictive for all to authenticated
 using(exists(select 1 from public.family_profiles p where p.id=profile_id and p.profile_owner_user_id=(select sf_private.personal_actor()))) with check(false);
create policy sf_private_measurement_owner on public.family_measurements for select to authenticated
 using(exists(select 1 from public.family_profiles p where p.id=profile_id and p.profile_owner_user_id=(select sf_private.personal_actor())));
create policy sf_private_legacy_measurement_gate on public.measurement_logs as restrictive for all to authenticated
 using(user_id=(select sf_private.personal_actor())) with check(false);
alter table public.dietitian_messages enable row level security;
alter table public.dietitian_summaries enable row level security;
create policy sf_ai_archive_messages on public.dietitian_messages as restrictive for all to authenticated using(false) with check(false);
create policy sf_ai_archive_summaries on public.dietitian_summaries as restrictive for all to authenticated using(false) with check(false);

-- Server-issued tickets: unknown/expired IDs never authorize a new deletion.
create table sf_private.data_deletion_receipts (
 actor uuid not null references auth.users(id) on delete cascade,
 request_id uuid not null default gen_random_uuid(),
 scope text not null check(scope in ('measurements','profile','legacy_ai','legacy_measurements')),
 profile_id uuid,
 result jsonb,
 created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null,
 primary key(actor,request_id),
 check(expires_at=created_at+interval '90 days'),
 check((scope in ('legacy_ai','legacy_measurements'))=(profile_id is null))
);
create index data_deletion_receipts_expiry_idx on sf_private.data_deletion_receipts(expires_at);
alter table sf_private.data_deletion_receipts enable row level security;
revoke all on sf_private.data_deletion_receipts from public,anon,authenticated;
create function sf_private.my_data(action text,profile_id uuid,scope text,request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_actor uuid:=sf_private.require_personal_actor();
 output jsonb;
 receipt sf_private.data_deletion_receipts%rowtype;
 removed bigint:=0; removed_summaries bigint:=0;
 issued_at timestamptz;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('my-data:'||v_actor::text,0));
 if sf_private.personal_actor() is distinct from v_actor then raise exception 'authentication_required' using errcode='42501'; end if;
 if action = 'read' then
  if profile_id is not null or scope is not null or request_id is not null then raise exception 'invalid_read_arguments'; end if;
  select jsonb_build_object(
   'version',1, 'exported_at',now(),
   'profiles',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'sex',p.sex,'age',p.age,'height_cm',p.height_cm,'start_weight_kg',p.start_weight_kg,'target_weight_kg',p.target_weight_kg,'goal',p.goal,'activity_level',p.activity_level,'diet_mode',p.diet_mode,'baby_age_months',p.baby_age_months,'excluded_foods',p.excluded_foods,'meal_choices',p.meal_choices,'created_at',p.created_at) order by p.created_at,p.id) from public.family_profiles p where p.profile_owner_user_id=v_actor),'[]'::jsonb),
   'measurements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'profile_id',m.profile_id,'log_date',m.log_date,'weight',m.weight,'neck',m.neck,'chest',m.chest,'belly',m.belly,'hips',m.hips,'created_at',m.created_at) order by m.log_date,m.id) from public.family_measurements m join public.family_profiles p on p.id=m.profile_id where p.profile_owner_user_id=v_actor),'[]'::jsonb),
   'legacy_measurements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'log_date',m.log_date,'weight',m.weight,'neck',m.neck,'chest',m.chest,'belly',m.belly,'hips',m.hips,'created_at',m.created_at) order by m.log_date,m.id) from public.measurement_logs m where m.user_id=v_actor),'[]'::jsonb),
   'legacy_messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'role',m.role,'content',m.content,'created_at',m.created_at) order by m.created_at,m.id) from public.dietitian_messages m where m.user_id=v_actor),'[]'::jsonb),
   'legacy_summaries',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'week_start',m.week_start,'summary',m.summary,'created_at',m.created_at) order by m.created_at,m.id) from public.dietitian_summaries m where m.user_id=v_actor),'[]'::jsonb),
   'ai',jsonb_build_object('enabled',false,'memory_enabled',false,'consent_flow_available',false),
   'legacy_scope','account_archive_not_assigned_to_a_profile',
   'deletion_limits',jsonb_build_object('backups','unverified','external_provider','unverified')
  ) into output;
  if pg_catalog.octet_length(output::text)>5242880 then raise exception 'export_too_large'; end if;
  return output;
 end if;

 if action not in ('prepare_delete','delete') or action is null or scope is null
  or scope not in ('measurements','profile','legacy_ai','legacy_measurements') then raise exception 'invalid_action'; end if;
 if (scope in ('legacy_ai','legacy_measurements'))<>(profile_id is null) then raise exception 'invalid_scope'; end if;
 -- One actor lock orders prepare/delete/read and makes duplicate execution atomic.
 if action='prepare_delete' then
  if request_id is not null then raise exception 'server_ticket_required'; end if;
  if profile_id is not null then
   perform 1 from public.family_profiles p where p.id=$2 and p.profile_owner_user_id=v_actor for update;
   if not found then raise exception 'not_available' using errcode='42501'; end if;
  end if;
  if (select count(*) from sf_private.data_deletion_receipts r where r.actor=v_actor and r.result is null and r.expires_at>clock_timestamp())>=100 then
   raise exception 'too_many_pending_requests';
  end if;
  issued_at:=clock_timestamp();
  insert into sf_private.data_deletion_receipts(actor,scope,profile_id,created_at,expires_at)
   values(v_actor,$3,$2,issued_at,issued_at+interval '90 days') returning * into receipt;
  return jsonb_build_object('status','confirmation_required','request_id',receipt.request_id,'scope',receipt.scope,'profile_id',receipt.profile_id,'expires_at',receipt.expires_at);
 end if;
 if request_id is null then raise exception 'server_ticket_required'; end if;
 select * into receipt from sf_private.data_deletion_receipts r where r.actor=v_actor and r.request_id=$4 for update;
 if not found or receipt.expires_at<=clock_timestamp() then raise exception 'request_expired_or_unknown' using errcode='22023'; end if;
 if receipt.scope is distinct from scope or receipt.profile_id is distinct from profile_id then raise exception 'request_id_reused'; end if;
 if receipt.result is not null then return receipt.result; end if;
 if profile_id is not null then
  perform 1 from public.family_profiles p where p.id=$2 and p.profile_owner_user_id=v_actor for update;
  if not found then raise exception 'not_available' using errcode='42501'; end if;
 end if;
 if receipt.expires_at<=clock_timestamp() then raise exception 'request_expired_or_unknown' using errcode='22023'; end if;
 if scope='profile' then
  select count(*) into removed_summaries from public.family_measurements m where m.profile_id=$2;
  delete from public.family_profiles p where p.id=$2 and p.profile_owner_user_id=v_actor;
  get diagnostics removed=row_count;
 elsif scope='measurements' then
  delete from public.family_measurements m where m.profile_id=$2;
  get diagnostics removed=row_count;
 elsif scope='legacy_measurements' then
  delete from public.measurement_logs m where m.user_id=v_actor;
  get diagnostics removed=row_count;
 else
  delete from public.dietitian_messages m where m.user_id=v_actor;
  get diagnostics removed=row_count;
  delete from public.dietitian_summaries m where m.user_id=v_actor;
  get diagnostics removed_summaries=row_count;
 end if;
 output:=jsonb_build_object('request_id',request_id,'scope',scope,'profile_id',profile_id,'status','active_database_deleted','removed',removed,'related_removed',removed_summaries,'completed_at',clock_timestamp(),'expires_at',receipt.expires_at,'backups','unverified','external_provider','unverified');
 update sf_private.data_deletion_receipts r set result=output where r.actor=v_actor and r.request_id=$4;
 return output;
end;
$$;
revoke all on function sf_private.my_data(text,uuid,text,uuid) from public,anon;
grant execute on function sf_private.my_data(text,uuid,text,uuid) to authenticated;
create function public.sf_my_data(action text default 'read',profile_id uuid default null,scope text default null,request_id uuid default null)
returns jsonb language sql security invoker set search_path='' as $$ select sf_private.my_data(action,profile_id,scope,request_id); $$;
revoke all on function public.sf_my_data(text,uuid,text,uuid) from public,anon;
grant execute on function public.sf_my_data(text,uuid,text,uuid) to authenticated;
-- Invoker and no client grants: only the maintenance owner may purge technical tickets.
create function sf_private.purge_expired_deletion_receipts() returns bigint
language plpgsql security invoker set search_path='' as $$
declare removed bigint;
begin
 delete from sf_private.data_deletion_receipts where expires_at<=clock_timestamp();
 get diagnostics removed=row_count; return removed;
end;
$$;
revoke all on function sf_private.purge_expired_deletion_receipts() from public,anon,authenticated;
notify pgrst,'reload schema';

commit;
