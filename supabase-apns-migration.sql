-- Smart Fridge — миграция для нативных push-уведомлений на iOS (APNs)
-- Выполнить в Supabase Dashboard -> SQL Editor -> New query -> Run
-- Отдельно от supabase-push-migration.sql (тот — для Web Push/PWA);
-- эта таблица — для устройств, где приложение установлено из App Store
-- (Capacitor Push Notifications plugin, APNs device token).

create table if not exists public.apns_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);
alter table public.apns_tokens enable row level security;
drop policy if exists "user manages own apns tokens" on public.apns_tokens;
create policy "user manages own apns tokens" on public.apns_tokens for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Примечание: серверная функция уведомлений (api/send-expiry-notifications.js)
-- читает эту таблицу через service_role ключ (обходит RLS), как и
-- push_subscriptions — ей нужно видеть токены всех пользователей всех
-- домохозяйств, а не только своего аккаунта.
