-- Smart Fridge — миграция для семейных профилей диеты (несколько членов семьи,
-- у каждого своя формула калорий по полу/возрасту/весу/росту и своя история веса).
-- Выполнить в Supabase Dashboard -> SQL Editor -> New query -> Run

create table if not exists public.family_profiles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  name text not null,
  sex text not null check (sex in ('male','female')),
  age int not null check (age > 0 and age < 120),
  height_cm numeric not null check (height_cm > 0),
  start_weight_kg numeric not null check (start_weight_kg > 0),
  target_weight_kg numeric,
  goal text not null default 'maintain' check (goal in ('lose','maintain')),
  activity_level text not null default 'moderate' check (activity_level in ('low','moderate','high')),
  created_at timestamptz not null default now()
);
alter table public.family_profiles enable row level security;
drop policy if exists "household members manage family profiles" on public.family_profiles;
create policy "household members manage family profiles" on public.family_profiles for all
  using (is_household_member(household_id)) with check (is_household_member(household_id));

create index if not exists family_profiles_household_idx on public.family_profiles(household_id);

-- История веса/замеров каждого профиля отдельно (не путать с общей family_profiles.start_weight_kg,
-- это только точка отсчёта; фактическая динамика — здесь).
create table if not exists public.family_measurements (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.family_profiles(id) on delete cascade,
  log_date date not null,
  weight numeric not null,
  neck numeric,
  chest numeric,
  belly numeric,
  hips numeric,
  created_at timestamptz not null default now(),
  unique(profile_id, log_date)
);
alter table public.family_measurements enable row level security;
drop policy if exists "household members manage family measurements" on public.family_measurements;
create policy "household members manage family measurements" on public.family_measurements for all
  using (exists (select 1 from public.family_profiles fp where fp.id = profile_id and is_household_member(fp.household_id)))
  with check (exists (select 1 from public.family_profiles fp where fp.id = profile_id and is_household_member(fp.household_id)));

create index if not exists family_measurements_profile_date_idx on public.family_measurements(profile_id, log_date);

-- Примечание: старая таблица measurement_logs (один профиль на аккаунт, без пола/
-- возраста/роста) больше не используется веб-приложением — вкладка "Диета" теперь
-- работает через family_profiles/family_measurements. Можно оставить measurement_logs
-- как есть (данные не удаляются) или удалить вручную, если она точно не нужна.
