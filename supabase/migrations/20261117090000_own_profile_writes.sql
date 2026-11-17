begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Owner-only personal writes. Direct table writes stay closed (restrictive gates from 20261103);
-- the only way to change a profile or its measurements is this audited function, and only for
-- profiles whose profile_owner_user_id is the calling, non-anonymous session.
-- Deletion of a whole profile keeps using the ticketed sf_my_data('prepare_delete'/'delete') path.

create function sf_private.profile_write(action text, target_profile uuid, fields jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 actor uuid:=sf_private.require_personal_actor();
 hh uuid;
 f jsonb:=coalesce(fields,'{}'::jsonb);
 allowed_profile text[]:=array['name','age','sex','height_cm','start_weight_kg','target_weight_kg','goal',
  'activity_level','diet_mode','baby_age_months','excluded_foods','meal_choices'];
 clean_name text;
 log_day date;
 out_id uuid;
 removed bigint:=0;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('my-data:'||actor::text,0));
 if sf_private.personal_actor() is distinct from actor then raise exception 'authentication_required' using errcode='42501'; end if;
 if action is null or action <> all(array['create_profile','update_profile','upsert_measurement','delete_measurement']) then
  raise exception 'invalid_action' using errcode='22023';
 end if;
 if jsonb_typeof(f)<>'object' or pg_catalog.octet_length(f::text)>16384 then raise exception 'invalid_fields' using errcode='22023'; end if;

 if action in ('create_profile','update_profile') then
  if exists(select 1 from jsonb_object_keys(f) k where k <> all(allowed_profile)) then
   raise exception 'invalid_fields' using errcode='22023';
  end if;
  if f ? 'name' then
   clean_name:=btrim(f->>'name');
   if clean_name is null or char_length(clean_name) not between 1 and 60 or clean_name ~ '[[:cntrl:]]' then
    raise exception 'invalid_profile' using errcode='22023';
   end if;
  end if;
  if f ? 'excluded_foods' and (jsonb_typeof(f->'excluded_foods')<>'array'
     or jsonb_array_length(f->'excluded_foods')>5
     or exists(select 1 from jsonb_array_elements(f->'excluded_foods') e
               where jsonb_typeof(e)<>'string' or e#>>'{}' <> all(array['dairy','egg','fish','nuts','gluten']))) then
   raise exception 'invalid_profile' using errcode='22023';
  end if;
  if f ? 'meal_choices' and jsonb_typeof(f->'meal_choices')<>'object' then raise exception 'invalid_profile' using errcode='22023'; end if;
 end if;

 begin
  if action='create_profile' then
   if target_profile is null then raise exception 'invalid_profile' using errcode='22023'; end if;
   -- Idempotent retry: the client generates the id once per form submit.
   if exists(select 1 from public.family_profiles p where p.id=target_profile and p.profile_owner_user_id=actor) then
    return jsonb_build_object('status','created','profile_id',target_profile);
   end if;
   if exists(select 1 from public.family_profiles p where p.id=target_profile) then
    raise exception 'not_available' using errcode='42501';
   end if;
   if clean_name is null then raise exception 'invalid_profile' using errcode='22023'; end if;
   if (select count(*) from public.family_profiles p where p.profile_owner_user_id=actor)>=8 then
    raise exception 'too_many_profiles' using errcode='54000';
   end if;
   select m.household_id into hh from public.household_members m where m.user_id=actor limit 1;
   insert into public.family_profiles(id,profile_owner_user_id,created_by,household_id,name,age,sex,height_cm,
     start_weight_kg,target_weight_kg,goal,activity_level,diet_mode,baby_age_months,excluded_foods,meal_choices)
   values(target_profile,actor,actor,hh,clean_name,(f->>'age')::int,f->>'sex',(f->>'height_cm')::numeric,
     (f->>'start_weight_kg')::numeric,(f->>'target_weight_kg')::numeric,coalesce(f->>'goal','maintain'),
     coalesce(f->>'activity_level','moderate'),coalesce(f->>'diet_mode','standard'),(f->>'baby_age_months')::int,
     coalesce((select array_agg(e#>>'{}') from jsonb_array_elements(f->'excluded_foods') e),'{}'::text[]),
     coalesce(f->'meal_choices','{}'::jsonb));
   return jsonb_build_object('status','created','profile_id',target_profile);
  end if;

  if target_profile is null then raise exception 'invalid_profile' using errcode='22023'; end if;
  perform 1 from public.family_profiles p where p.id=target_profile and p.profile_owner_user_id=actor for update;
  if not found then raise exception 'not_available' using errcode='42501'; end if;

  if action='update_profile' then
   update public.family_profiles p set
    name=case when f ? 'name' then clean_name else p.name end,
    age=case when f ? 'age' then (f->>'age')::int else p.age end,
    sex=case when f ? 'sex' then f->>'sex' else p.sex end,
    height_cm=case when f ? 'height_cm' then (f->>'height_cm')::numeric else p.height_cm end,
    start_weight_kg=case when f ? 'start_weight_kg' then (f->>'start_weight_kg')::numeric else p.start_weight_kg end,
    target_weight_kg=case when f ? 'target_weight_kg' then (f->>'target_weight_kg')::numeric else p.target_weight_kg end,
    goal=case when f ? 'goal' then f->>'goal' else p.goal end,
    activity_level=case when f ? 'activity_level' then f->>'activity_level' else p.activity_level end,
    diet_mode=case when f ? 'diet_mode' then f->>'diet_mode' else p.diet_mode end,
    baby_age_months=case when f ? 'baby_age_months' then (f->>'baby_age_months')::int else p.baby_age_months end,
    excluded_foods=case when f ? 'excluded_foods' then coalesce((select array_agg(e#>>'{}') from jsonb_array_elements(f->'excluded_foods') e),'{}'::text[]) else p.excluded_foods end,
    meal_choices=case when f ? 'meal_choices' then f->'meal_choices' else p.meal_choices end
   where p.id=target_profile and p.profile_owner_user_id=actor;
   return jsonb_build_object('status','updated','profile_id',target_profile);
  end if;

  if action in ('upsert_measurement','delete_measurement') then
   log_day:=(f->>'log_date')::date;
   if log_day is null or log_day<date '2000-01-01' or log_day>(clock_timestamp() at time zone 'Asia/Almaty')::date+1 then
    raise exception 'invalid_measurement' using errcode='22023';
   end if;
   if action='delete_measurement' then
    delete from public.family_measurements m where m.profile_id=target_profile and m.log_date=log_day;
    get diagnostics removed=row_count;
    return jsonb_build_object('status','deleted','profile_id',target_profile,'log_date',log_day,'removed',removed);
   end if;
   if exists(select 1 from jsonb_object_keys(f) k where k <> all(array['log_date','weight','neck','chest','belly','hips'])) then
    raise exception 'invalid_measurement' using errcode='22023';
   end if;
   if (f->>'weight')::numeric not between 2 and 400
      or coalesce((f->>'neck')::numeric,50) not between 10 and 300
      or coalesce((f->>'chest')::numeric,50) not between 10 and 300
      or coalesce((f->>'belly')::numeric,50) not between 10 and 300
      or coalesce((f->>'hips')::numeric,50) not between 10 and 300 then
    raise exception 'invalid_measurement' using errcode='22023';
   end if;
   insert into public.family_measurements(profile_id,log_date,weight,neck,chest,belly,hips)
   values(target_profile,log_day,(f->>'weight')::numeric,(f->>'neck')::numeric,(f->>'chest')::numeric,(f->>'belly')::numeric,(f->>'hips')::numeric)
   on conflict(profile_id,log_date) do update set
    weight=excluded.weight,
    neck=case when f ? 'neck' then excluded.neck else public.family_measurements.neck end,
    chest=case when f ? 'chest' then excluded.chest else public.family_measurements.chest end,
    belly=case when f ? 'belly' then excluded.belly else public.family_measurements.belly end,
    hips=case when f ? 'hips' then excluded.hips else public.family_measurements.hips end
   returning id into out_id;
   return jsonb_build_object('status','saved','profile_id',target_profile,'log_date',log_day,'measurement_id',out_id);
  end if;
 exception
  when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation
       or datetime_field_overflow or invalid_datetime_format then
   raise exception 'invalid_input' using errcode='22023';
 end;
 raise exception 'invalid_action' using errcode='22023';
end;
$$;
revoke all on function sf_private.profile_write(text,uuid,jsonb) from public,anon;
grant execute on function sf_private.profile_write(text,uuid,jsonb) to authenticated;

create function public.sf_profile_write(action text, target_profile uuid default null, fields jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$
 select sf_private.profile_write(action,target_profile,fields)
$$;
revoke all on function public.sf_profile_write(text,uuid,jsonb) from public,anon;
grant execute on function public.sf_profile_write(text,uuid,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
