-- Smart Fridge — миграция для чата с ИИ-диетологом
-- Выполнить в Supabase Dashboard -> SQL Editor -> New query -> Run

-- Сообщения текущей (последней) недели общения. Раз в неделю серверная
-- функция api/dietitian-weekly-summary.js сжимает их в одну запись в
-- dietitian_summaries и удаляет отсюда — история не растёт бесконечно,
-- диетолог помнит суть прошлых недель через summary, а не полный лог.
create table if not exists public.dietitian_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
alter table public.dietitian_messages enable row level security;
drop policy if exists "user manages own dietitian messages" on public.dietitian_messages;
create policy "user manages own dietitian messages" on public.dietitian_messages for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists dietitian_messages_user_created_idx
  on public.dietitian_messages (user_id, created_at);

-- Недельные выжимки — то, что остаётся после еженедельной очистки.
create table if not exists public.dietitian_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  summary text not null,
  created_at timestamptz not null default now()
);
alter table public.dietitian_summaries enable row level security;
drop policy if exists "user manages own dietitian summaries" on public.dietitian_summaries;
create policy "user manages own dietitian summaries" on public.dietitian_summaries for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists dietitian_summaries_user_week_idx
  on public.dietitian_summaries (user_id, week_start desc);

-- Примечание: api/dietitian-weekly-summary.js читает/пишет обе таблицы через
-- service_role ключ (как send-expiry-notifications.js) — ему нужно видеть
-- сообщения всех пользователей, а не только своего аккаунта.
