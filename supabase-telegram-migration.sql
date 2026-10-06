-- Smart Fridge — миграция: уведомления в Telegram.
-- Выполнить в Supabase Dashboard -> SQL Editor -> New query -> Run (один раз, после остальных миграций).
--
-- Как это работает: в приложении пользователь жмёт «Подключить Telegram», функция
-- generate_telegram_link_token() выдаёт одноразовый код на 15 минут, приложение открывает
-- t.me/<бот>?start=<код>, а вебхук бота (api/telegram-webhook.js, с сервисным ключом)
-- записывает chat_id. Писать в таблицу напрямую из браузера нельзя — только читать свою строку.

create table if not exists public.telegram_links (
  user_id uuid primary key references auth.users(id) on delete cascade,
  chat_id bigint unique,
  link_token text unique,
  link_token_expires_at timestamptz,
  linked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.telegram_links enable row level security;

drop policy if exists "own telegram link readable" on public.telegram_links;
create policy "own telegram link readable" on public.telegram_links
  for select using (auth.uid() = user_id);

-- Политик на insert/update/delete нет намеренно: любое изменение идёт через функции ниже
-- или через сервисный ключ вебхука, который обходит RLS.

create or replace function public.generate_telegram_link_token()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  t := replace(gen_random_uuid()::text, '-', '');

  -- chat_id не трогаем: если Telegram уже подключён, он продолжит работать,
  -- пока пользователь не завершит привязку нового чата.
  insert into public.telegram_links (user_id, link_token, link_token_expires_at)
  values (auth.uid(), t, now() + interval '15 minutes')
  on conflict (user_id) do update
    set link_token = excluded.link_token,
        link_token_expires_at = excluded.link_token_expires_at;

  return t;
end;
$$;

revoke all on function public.generate_telegram_link_token() from public, anon;
grant execute on function public.generate_telegram_link_token() to authenticated;

create or replace function public.unlink_telegram()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from public.telegram_links where user_id = auth.uid();
end;
$$;

revoke all on function public.unlink_telegram() from public, anon;
grant execute on function public.unlink_telegram() to authenticated;
