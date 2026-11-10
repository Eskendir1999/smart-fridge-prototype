begin;
set local lock_timeout='5s';
-- Dinner does not use these fields. Existing profile rows and constraints on supplied values stay intact.
alter table public.family_profiles alter column sex drop not null,
 alter column height_cm drop not null, alter column start_weight_kg drop not null;

create table sf_private.own_profile_intent (
 actor uuid primary key references auth.users(id) on delete cascade,
 profile_id uuid not null unique default gen_random_uuid(),
 expires_at timestamptz not null,
 consumed boolean not null default false
);
alter table sf_private.own_profile_intent enable row level security;
revoke all on sf_private.own_profile_intent from public,anon,authenticated;

create function sf_private.create_own_dinner_profile(action text, request_id uuid,
 profile_name text, profile_age integer, exclusions text[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor_id uuid:=sf_private.require_personal_actor();
 intent sf_private.own_profile_intent%rowtype;
 hh uuid;
 clean_name text:=btrim(profile_name);
begin
 perform pg_advisory_xact_lock(hashtextextended('my-data:'||actor_id::text,0));
 if sf_private.personal_actor() is distinct from actor_id then
  raise exception 'authentication_required' using errcode='42501';
 end if;
 select m.household_id into hh from public.household_members m where m.user_id=actor_id for share;
 if hh is null then raise exception 'profile_creation_unavailable' using errcode='55000'; end if;
 perform 1 from sf_private.dinner_release_control c where c.singleton
  and ((c.enabled and c.profile_privacy_accepted) or sf_private.dinner_acceptance(hh)) for share;
 if not found then raise exception 'profile_creation_unavailable' using errcode='55000'; end if;

 if action='prepare' then
  if request_id is not null or profile_name is not null or profile_age is not null or exclusions is not null then
   raise exception 'invalid_prepare_arguments' using errcode='22023';
  end if;
  if exists(select 1 from public.family_profiles p where p.profile_owner_user_id=actor_id) then
   raise exception 'own_profile_already_exists' using errcode='23505';
  end if;
  select * into intent from sf_private.own_profile_intent i where i.actor=actor_id;
  if not found or intent.consumed or intent.expires_at<=clock_timestamp() then
   insert into sf_private.own_profile_intent(actor,expires_at) values(actor_id,clock_timestamp()+interval '10 minutes')
    on conflict(actor) do update set profile_id=gen_random_uuid(),expires_at=excluded.expires_at,consumed=false
    returning * into intent;
  end if;
  return jsonb_build_object('status','ready','request_id',intent.profile_id);
 end if;

 if action is distinct from 'create' or request_id is null then
  raise exception 'invalid_profile_request' using errcode='22023';
 end if;
 select * into intent from sf_private.own_profile_intent i where i.actor=actor_id and i.profile_id=request_id;
 if not found or intent.expires_at<=clock_timestamp() then
  raise exception 'profile_request_expired_or_unknown' using errcode='22023';
 end if;
 if intent.consumed then
  if exists(select 1 from public.family_profiles p where p.id=request_id and p.profile_owner_user_id=actor_id) then
   return jsonb_build_object('status','created','profile_id',request_id);
  end if;
  raise exception 'profile_request_expired_or_unknown' using errcode='22023';
 end if;
 if clean_name is null or char_length(clean_name) not between 1 and 60 or clean_name ~ '[[:cntrl:]]'
   or profile_age is null or profile_age not between 18 and 119
   or exclusions is null or coalesce(array_ndims(exclusions),1)<>1 or cardinality(exclusions)>5
   or array_position(exclusions,null) is not null
   or not (exclusions <@ array['dairy','egg','fish','nuts','gluten']::text[])
   or cardinality(exclusions)<>(select count(distinct x) from unnest(exclusions) x)
 then raise exception 'invalid_own_profile' using errcode='22023'; end if;
 if exists(select 1 from public.family_profiles p where p.profile_owner_user_id=actor_id) then
  raise exception 'own_profile_already_exists' using errcode='23505';
 end if;
 insert into public.family_profiles(id,profile_owner_user_id,created_by,name,age,diet_mode,excluded_foods)
  values(request_id,actor_id,actor_id,clean_name,profile_age,'standard',exclusions);
 update sf_private.own_profile_intent i set consumed=true where i.actor=actor_id;
 return jsonb_build_object('status','created','profile_id',request_id);
end;
$$;
revoke all on function sf_private.create_own_dinner_profile(text,uuid,text,integer,text[]) from public,anon;
grant execute on function sf_private.create_own_dinner_profile(text,uuid,text,integer,text[]) to authenticated;

create function public.sf_create_own_dinner_profile(action text,request_id uuid default null,
 profile_name text default null,profile_age integer default null,exclusions text[] default null)
returns jsonb language sql security invoker set search_path='' as $$
 select sf_private.create_own_dinner_profile(action,request_id,profile_name,profile_age,exclusions)
$$;
revoke all on function public.sf_create_own_dinner_profile(text,uuid,text,integer,text[]) from public,anon;
grant execute on function public.sf_create_own_dinner_profile(text,uuid,text,integer,text[]) to authenticated;
notify pgrst,'reload schema';
commit;
