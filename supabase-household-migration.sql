-- Smart Fridge — миграция на "семейный" общий холодильник (household)
-- Выполнить в Supabase Dashboard -> SQL Editor -> New query -> Run
-- ПОСЛЕ основной схемы (smart-fridge-supabase-schema.sql), один раз.

-- 1. Таблица "домохозяйств" и код приглашения
create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  invite_code text not null unique,
  created_at timestamptz not null default now()
);
alter table public.households enable row level security;
drop policy if exists "any authenticated user can read households" on public.households;
create policy "any authenticated user can read households" on public.households
  for select using (auth.role() = 'authenticated');
drop policy if exists "any authenticated user can create household" on public.households;
create policy "any authenticated user can create household" on public.households
  for insert with check (auth.uid() is not null);

-- 2. Членство: один пользователь состоит ровно в одном домохозяйстве
create table if not exists public.household_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  joined_at timestamptz not null default now()
);
alter table public.household_members enable row level security;

-- security definer функция, чтобы избежать рекурсии RLS-политики самой на себя
create or replace function public.is_household_member(target_household uuid)
returns boolean language sql security definer stable as $$
  select exists(
    select 1 from public.household_members
    where household_id = target_household and user_id = auth.uid()
  );
$$;

drop policy if exists "view own or same household membership" on public.household_members;
create policy "view own or same household membership" on public.household_members
  for select using (user_id = auth.uid() or is_household_member(household_id));
drop policy if exists "user creates own membership" on public.household_members;
create policy "user creates own membership" on public.household_members
  for insert with check (user_id = auth.uid());
drop policy if exists "user updates own membership" on public.household_members;
create policy "user updates own membership" on public.household_members
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 3. household_id на общих таблицах (fridge/cart остаются общими; замеры/диета — личные, не трогаем)
alter table public.fridge_items add column if not exists household_id uuid references public.households(id) on delete cascade;
alter table public.cart_items add column if not exists household_id uuid references public.households(id) on delete cascade;

-- 4. Бэкфилл: каждому существующему пользователю — своё домохозяйство, если ещё не создано
do $$
declare r record;
declare hh_id uuid;
begin
  for r in select id from auth.users u where not exists (select 1 from public.household_members hm where hm.user_id = u.id)
  loop
    insert into public.households (invite_code) values (upper(substr(md5(random()::text), 1, 6))) returning id into hh_id;
    insert into public.household_members(household_id, user_id) values (hh_id, r.id);
  end loop;
end $$;

update public.fridge_items fi set household_id = hm.household_id
  from public.household_members hm where fi.user_id = hm.user_id and fi.household_id is null;
update public.cart_items ci set household_id = hm.household_id
  from public.household_members hm where ci.user_id = hm.user_id and ci.household_id is null;

alter table public.fridge_items alter column household_id set not null;
alter table public.cart_items alter column household_id set not null;

-- 5. Переключаем RLS с "свой user_id" на "своё домохозяйство"
drop policy if exists "own fridge items" on public.fridge_items;
create policy "household fridge items" on public.fridge_items for all
  using (is_household_member(household_id)) with check (is_household_member(household_id));

drop policy if exists "own cart items" on public.cart_items;
create policy "household cart items" on public.cart_items for all
  using (is_household_member(household_id)) with check (is_household_member(household_id));
