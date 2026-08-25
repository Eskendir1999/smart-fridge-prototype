-- Smart Fridge — схема для Supabase
-- Выполнить в Dashboard -> SQL Editor -> New query -> Run

create table if not exists public.fridge_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  compartment text not null check (compartment in ('fridge','freezer')),
  name text not null,
  emoji text not null default '📦',
  qty_num numeric not null default 1,
  unit text not null default 'шт',
  location text,
  expires_on date,
  created_at timestamptz not null default now()
);
alter table public.fridge_items enable row level security;
drop policy if exists "own fridge items" on public.fridge_items;
create policy "own fridge items" on public.fridge_items for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  emoji text not null default '🛒',
  qty_num numeric not null default 1,
  unit text not null default 'шт',
  note text,
  created_at timestamptz not null default now()
);
alter table public.cart_items enable row level security;
drop policy if exists "own cart items" on public.cart_items;
create policy "own cart items" on public.cart_items for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.measurement_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  log_date date not null,
  weight numeric,
  neck numeric,
  chest numeric,
  belly numeric,
  hips numeric,
  created_at timestamptz not null default now(),
  unique(user_id, log_date)
);
alter table public.measurement_logs enable row level security;
drop policy if exists "own measurement logs" on public.measurement_logs;
create policy "own measurement logs" on public.measurement_logs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.food_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  used_count integer not null default 0,
  used_weight_kg numeric not null default 0,
  wasted_count integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.food_stats enable row level security;
drop policy if exists "own food stats" on public.food_stats;
create policy "own food stats" on public.food_stats for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
