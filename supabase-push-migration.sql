-- Smart Fridge — миграция для push-уведомлений об истекающем сроке годности
-- Выполнить в Supabase Dashboard -> SQL Editor -> New query -> Run
-- ПОСЛЕ supabase-household-migration.sql

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "user manages own push subscriptions" on public.push_subscriptions;
create policy "user manages own push subscriptions" on public.push_subscriptions for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Примечание: серверная функция уведомлений читает эту таблицу и fridge_items
-- через service_role ключ (обходит RLS), т.к. должна видеть подписки всех
-- пользователей всех домохозяйств, а не только своего аккаунта.
