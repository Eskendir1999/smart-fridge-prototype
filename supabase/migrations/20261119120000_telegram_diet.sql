begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Telegram «Диета»: профили, меню, вес и обхваты, напоминания о замерах, удаление профиля.
-- Вызывает только вебхук и cron с service_role. Пользователь всегда определяется по chat_id
-- привязанного чата; профиль доступен, только если его владелец — этот пользователь.

-- Что бот ждёт от чата: число веса или строку замеров для выбранного профиля.
create table sf_telegram.chat_state (
  chat_id bigint primary key,
  profile_id uuid not null references public.family_profiles(id) on delete cascade,
  awaiting text not null check (awaiting in ('weight', 'measure')),
  expires_at timestamptz not null
);
alter table sf_telegram.chat_state enable row level security;
revoke all on sf_telegram.chat_state from public, anon, authenticated;

create table sf_telegram.measure_reminders (
  profile_id uuid primary key references public.family_profiles(id) on delete cascade,
  enabled boolean not null default true,
  last_sent_on date
);
alter table sf_telegram.measure_reminders enable row level security;
revoke all on sf_telegram.measure_reminders from public, anon, authenticated;

create function sf_telegram.diet(p_chat_id bigint, p_action text, p_profile uuid, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Almaty')::date;
  a jsonb := coalesce(p_args, '{}'::jsonb);
  actor uuid;
  hh uuid;
  prof public.family_profiles%rowtype;
  st sf_telegram.chat_state%rowtype;
  out_id uuid;
  n_added int := 0;
  n_meas int := 0;
  item jsonb;
  clean text;
  on_now boolean;
begin
  if p_chat_id is null or p_chat_id <= 0 or p_action is null or p_action <> all(array[
    'profiles','profile','await','cancel','state','save','reminders','delete','cart_add','cook']) then
    raise exception 'invalid_telegram_diet' using errcode = '22023';
  end if;
  if jsonb_typeof(a) <> 'object' or octet_length(a::text) > 8192 then
    raise exception 'invalid_telegram_diet' using errcode = '22023';
  end if;

  select l.user_id into actor from public.telegram_links l where l.chat_id = p_chat_id;
  if actor is null then return jsonb_build_object('status', 'not_linked'); end if;
  select m.household_id into hh from public.household_members m where m.user_id = actor limit 1;

  if p_action = 'profiles' then
    return jsonb_build_object('status', 'ok', 'profiles', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.created_at, p.id)
      from public.family_profiles p where p.profile_owner_user_id = actor), '[]'::jsonb));
  end if;

  if p_action = 'cook' then
    return jsonb_build_object('status', 'ok', 'inventory', coalesce((
      select jsonb_agg(f.name) from (select name from public.fridge_items
        where household_id = hh and qty_num > 0 order by expires_on nulls last, id limit 300) f), '[]'::jsonb));
  end if;

  if p_action = 'state' then
    select * into st from sf_telegram.chat_state s where s.chat_id = p_chat_id;
    if not found or st.expires_at <= clock_timestamp() then
      delete from sf_telegram.chat_state s where s.chat_id = p_chat_id;
      return jsonb_build_object('status', 'ok', 'awaiting', null);
    end if;
    p_profile := st.profile_id;
  end if;

  if p_action = 'cancel' then
    delete from sf_telegram.chat_state s where s.chat_id = p_chat_id;
    return jsonb_build_object('status', 'ok');
  end if;

  -- Дальше всё — про один профиль этого пользователя.
  select * into prof from public.family_profiles p
  where p.id = p_profile and p.profile_owner_user_id = actor for update;
  if not found then
    delete from sf_telegram.chat_state s where s.chat_id = p_chat_id;
    return jsonb_build_object('status', 'no_profile');
  end if;

  if p_action = 'state' then
    return jsonb_build_object('status', 'ok', 'awaiting', st.awaiting, 'profile_id', prof.id, 'name', prof.name);
  end if;

  if p_action = 'profile' then
    return jsonb_build_object('status', 'ok', 'today', today,
      'profile', to_jsonb(prof) - 'profile_owner_user_id' - 'created_by' - 'household_id',
      'measurements', coalesce((select jsonb_agg(to_jsonb(x) order by x.log_date desc) from (
        select m.log_date, m.weight, m.neck, m.chest, m.belly, m.hips from public.family_measurements m
        where m.profile_id = prof.id order by m.log_date desc limit 60) x), '[]'::jsonb),
      'reminders', coalesce((select r.enabled from sf_telegram.measure_reminders r where r.profile_id = prof.id), true),
      'inventory', coalesce((select jsonb_agg(f.name) from (select name from public.fridge_items
        where household_id = hh and qty_num > 0 order by id limit 300) f), '[]'::jsonb));
  end if;

  if p_action = 'await' then
    if a->>'awaiting' is null or a->>'awaiting' <> all(array['weight','measure']) then
      raise exception 'invalid_telegram_diet' using errcode = '22023';
    end if;
    insert into sf_telegram.chat_state(chat_id, profile_id, awaiting, expires_at)
    values (p_chat_id, prof.id, a->>'awaiting', clock_timestamp() + interval '30 minutes')
    on conflict (chat_id) do update set profile_id = excluded.profile_id, awaiting = excluded.awaiting,
      expires_at = excluded.expires_at;
    return jsonb_build_object('status', 'ok', 'name', prof.name,
      'last', (select to_jsonb(x) from (select m.log_date, m.weight, m.neck, m.chest, m.belly, m.hips
        from public.family_measurements m where m.profile_id = prof.id order by m.log_date desc limit 1) x));
  end if;

  if p_action = 'save' then
    if exists(select 1 from jsonb_object_keys(a) k where k <> all(array['weight','neck','chest','belly','hips'])) then
      raise exception 'invalid_measurement' using errcode = '22023';
    end if;
    begin
      if (a->>'weight')::numeric is null or (a->>'weight')::numeric not between 2 and 400
        or coalesce((a->>'neck')::numeric, 50) not between 10 and 300
        or coalesce((a->>'chest')::numeric, 50) not between 10 and 300
        or coalesce((a->>'belly')::numeric, 50) not between 10 and 300
        or coalesce((a->>'hips')::numeric, 50) not between 10 and 300 then
        return jsonb_build_object('status', 'invalid_measurement');
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      return jsonb_build_object('status', 'invalid_measurement');
    end;
    insert into public.family_measurements(profile_id, log_date, weight, neck, chest, belly, hips)
    values (prof.id, today, (a->>'weight')::numeric, (a->>'neck')::numeric, (a->>'chest')::numeric,
      (a->>'belly')::numeric, (a->>'hips')::numeric)
    on conflict (profile_id, log_date) do update set
      weight = excluded.weight,
      neck = case when a ? 'neck' then excluded.neck else public.family_measurements.neck end,
      chest = case when a ? 'chest' then excluded.chest else public.family_measurements.chest end,
      belly = case when a ? 'belly' then excluded.belly else public.family_measurements.belly end,
      hips = case when a ? 'hips' then excluded.hips else public.family_measurements.hips end
    returning id into out_id;
    delete from sf_telegram.chat_state s where s.chat_id = p_chat_id;
    return jsonb_build_object('status', 'saved', 'name', prof.name, 'today', today,
      'profile', to_jsonb(prof) - 'profile_owner_user_id' - 'created_by' - 'household_id',
      'measurements', coalesce((select jsonb_agg(to_jsonb(x) order by x.log_date desc) from (
        select m.log_date, m.weight, m.neck, m.chest, m.belly, m.hips from public.family_measurements m
        where m.profile_id = prof.id order by m.log_date desc limit 60) x), '[]'::jsonb));
  end if;

  if p_action = 'reminders' then
    select coalesce((select r.enabled from sf_telegram.measure_reminders r where r.profile_id = prof.id), true) into on_now;
    insert into sf_telegram.measure_reminders(profile_id, enabled) values (prof.id, not on_now)
    on conflict (profile_id) do update set enabled = excluded.enabled;
    return jsonb_build_object('status', 'ok', 'name', prof.name, 'reminders', not on_now);
  end if;

  if p_action = 'delete' then
    select count(*) into n_meas from public.family_measurements m where m.profile_id = prof.id;
    delete from public.family_profiles p where p.id = prof.id and p.profile_owner_user_id = actor;
    return jsonb_build_object('status', 'deleted', 'name', prof.name, 'measurements', n_meas);
  end if;

  -- cart_add: недостающее для меню профиля -> общая корзина дома, без дублей по названию.
  if hh is null then return jsonb_build_object('status', 'no_household'); end if;
  if jsonb_typeof(a->'items') <> 'array' or jsonb_array_length(a->'items') > 40 then
    raise exception 'invalid_telegram_diet' using errcode = '22023';
  end if;
  for item in select * from jsonb_array_elements(a->'items') loop
    clean := btrim(item->>'name');
    continue when clean is null or char_length(clean) not between 1 and 80 or clean ~ '[[:cntrl:]]';
    continue when exists(select 1 from public.cart_items c where c.household_id = hh
      and lower(replace(c.name, 'ё', 'е')) = lower(replace(clean, 'ё', 'е')));
    insert into public.cart_items(user_id, household_id, name, emoji, qty_num, unit, note)
    values (actor, hh, clean, '🛒', 1, 'шт', 'Для меню: ' || prof.name);
    n_added := n_added + 1;
  end loop;
  return jsonb_build_object('status', 'ok', 'added', n_added);
end;
$$;
revoke all on function sf_telegram.diet(bigint, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function sf_telegram.diet(bigint, text, uuid, jsonb) to service_role;

create function public.sf_telegram_diet(p_chat_id bigint, p_action text, p_profile uuid default null, p_args jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select sf_telegram.diet(p_chat_id, p_action, p_profile, p_args)
$$;
revoke all on function public.sf_telegram_diet(bigint, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sf_telegram_diet(bigint, text, uuid, jsonb) to service_role;

-- Напоминания: вес раз в 2 дня, обхваты раз в 5 дней — как на экране «Вес и замеры».
-- Не чаще одного сообщения на профиль в 2 дня. Отметка ставится в той же транзакции,
-- поэтому повторный запуск cron не пришлёт напоминание дважды.
create function sf_telegram.claim_reminders()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Almaty')::date;
  due jsonb;
begin
  with c as (
    select p.id, p.name, l.chat_id,
      (select max(m.log_date) from public.family_measurements m where m.profile_id = p.id) last_weight,
      (select max(m.log_date) from public.family_measurements m where m.profile_id = p.id
        and m.neck > 0 and m.chest > 0 and m.belly > 0 and m.hips > 0) last_full
    from public.family_profiles p
    join public.telegram_links l on l.user_id = p.profile_owner_user_id and l.chat_id is not null
    left join sf_telegram.measure_reminders r on r.profile_id = p.id
    where coalesce(r.enabled, true) and (r.last_sent_on is null or r.last_sent_on <= today - 2)
  ), d as (
    select c.*, (c.last_weight is null or c.last_weight <= today - 2) weight_due,
      (c.last_full is null or c.last_full <= today - 5) full_due
    from c
  ), picked as (
    select * from d where weight_due or full_due order by chat_id, id limit 200
  ), marked as (
    insert into sf_telegram.measure_reminders(profile_id, last_sent_on)
    select id, today from picked
    on conflict (profile_id) do update set last_sent_on = excluded.last_sent_on
    returning profile_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('chat_id', p.chat_id, 'profile_id', p.id, 'name', p.name,
    'last_weight', p.last_weight, 'last_full', p.last_full, 'weight_due', p.weight_due, 'full_due', p.full_due,
    'today', today)), '[]'::jsonb)
  into due from picked p where p.id in (select profile_id from marked);
  return due;
end;
$$;
revoke all on function sf_telegram.claim_reminders() from public, anon, authenticated;
grant execute on function sf_telegram.claim_reminders() to service_role;

create function public.sf_telegram_claim_reminders()
returns jsonb language sql security invoker set search_path = '' as $$
  select sf_telegram.claim_reminders()
$$;
revoke all on function public.sf_telegram_claim_reminders() from public, anon, authenticated;
grant execute on function public.sf_telegram_claim_reminders() to service_role;

grant usage on schema sf_telegram to service_role;
notify pgrst, 'reload schema';
commit;
