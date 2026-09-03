-- Smart Fridge — миграция для журнала "использовано/выброшено"
-- Выполнить в Supabase Dashboard -> SQL Editor -> New query -> Run
-- ПОСЛЕ supabase-household-migration.sql (использует is_household_member()).

create table if not exists public.food_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  emoji text not null default '📦',
  action text not null check (action in ('used','wasted')),
  qty_kg numeric,
  created_at timestamptz not null default now()
);
alter table public.food_events enable row level security;
drop policy if exists "household food events" on public.food_events;
create policy "household food events" on public.food_events for all
  using (is_household_member(household_id)) with check (is_household_member(household_id));

create index if not exists food_events_household_created_idx
  on public.food_events (household_id, created_at desc);
