-- Smart Fridge — закрываем доступ к чужим семьям (аудит, находка S-01)
-- Выполнить в Supabase Dashboard -> SQL Editor -> New query -> Run
-- ПОСЛЕ supabase-household-migration.sql, один раз. Скрипт можно запускать повторно.
--
-- Что было не так:
--   * households читал любой залогиненный пользователь, вместе с invite_code;
--   * в household_members можно было вставить или переписать свою строку
--     с ЛЮБЫМ household_id, без кода приглашения;
--   * после этого is_household_member() открывал чужие продукты, корзину,
--     профили, замеры и журнал еды.
-- Что делает миграция:
--   * households видят только члены семьи;
--   * прямые INSERT/UPDATE в household_members и INSERT в households закрыты,
--     создать семью и вступить в неё можно только через функции
--     create_household() и join_household(code), которые проверяют код;
--   * неудачные попытки ввода кода ограничены (10 в час на пользователя);
--   * все коды приглашения перевыпускаются: старые были видны всем;
--   * is_household_member получает фиксированный search_path и больше не
--     вызывается ролью anon.

begin;

-- 1. is_household_member: фиксированный search_path, только для authenticated
create or replace function public.is_household_member(target_household uuid)
returns boolean language sql security definer stable
set search_path = ''
as $$
  select exists(
    select 1 from public.household_members
    where household_id = target_household and user_id = auth.uid()
  );
$$;
revoke execute on function public.is_household_member(uuid) from public, anon;
grant execute on function public.is_household_member(uuid) to authenticated;

-- 2. households: читать могут только члены этой семьи, создавать — только через RPC
drop policy if exists "any authenticated user can read households" on public.households;
drop policy if exists "members read own household" on public.households;
create policy "members read own household" on public.households
  for select to authenticated using (public.is_household_member(id));
drop policy if exists "any authenticated user can create household" on public.households;

-- 3. household_members: только чтение; вступление и создание — через RPC
drop policy if exists "user creates own membership" on public.household_members;
drop policy if exists "user updates own membership" on public.household_members;

-- 4. Журнал неудачных попыток ввода кода (защита от перебора).
--    RLS включён и политик нет: напрямую таблица недоступна никому, кроме функций ниже.
create table if not exists public.household_join_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index if not exists household_join_attempts_user_time
  on public.household_join_attempts (user_id, attempted_at);
alter table public.household_join_attempts enable row level security;

-- 5. Генерация кода: 6 символов без похожих букв/цифр, криптостойкий источник
--    (gen_random_uuid), 32 символа алфавита делят 256 без остатка — без перекоса.
create or replace function public.generate_household_invite_code()
returns text language plpgsql volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := uuid_send(gen_random_uuid());
  code text := '';
begin
  for i in 0..5 loop
    code := code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return code;
end;
$$;
revoke execute on function public.generate_household_invite_code() from public, anon, authenticated;

-- 6. Создать семью для себя. Если пользователь уже в семье, возвращает её id.
create or replace function public.create_household()
returns uuid language plpgsql security definer volatile
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  hh_id uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select household_id into hh_id from public.household_members where user_id = uid;
  if hh_id is not null then
    return hh_id;
  end if;

  loop
    begin
      insert into public.households (invite_code)
        values (public.generate_household_invite_code())
        returning id into hh_id;
      exit;
    exception when unique_violation then
      -- совпал код приглашения, пробуем другой
    end;
  end loop;

  insert into public.household_members (household_id, user_id) values (hh_id, uid);
  return hh_id;
end;
$$;
revoke execute on function public.create_household() from public, anon;
grant execute on function public.create_household() to authenticated;

-- 7. Вступить в семью по коду приглашения.
--    Возвращает id семьи или null, если код не найден.
--    После 10 неудачных попыток за час — ошибка 'too many attempts'.
create or replace function public.join_household(code text)
returns uuid language plpgsql security definer volatile
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  normalized text := upper(btrim(coalesce(code, '')));
  hh_id uuid;
  recent_failures int;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select count(*) into recent_failures
    from public.household_join_attempts
    where user_id = uid and attempted_at > now() - interval '1 hour';
  if recent_failures >= 10 then
    raise exception 'too many attempts' using errcode = 'P0001',
      hint = 'Подождите час и попробуйте снова';
  end if;

  select id into hh_id from public.households where invite_code = normalized;
  if hh_id is null then
    insert into public.household_join_attempts (user_id) values (uid);
    return null;
  end if;

  insert into public.household_members (user_id, household_id) values (uid, hh_id)
    on conflict (user_id) do update set household_id = excluded.household_id, joined_at = now();

  -- после удачного входа счётчик ошибок обнуляется
  delete from public.household_join_attempts where user_id = uid;
  return hh_id;
end;
$$;
revoke execute on function public.join_household(text) from public, anon;
grant execute on function public.join_household(text) to authenticated;

-- 8. Перевыпуск всех кодов приглашения: до этой миграции их мог прочитать любой.
--    Уже вступившие члены семьи остаются, меняется только код, который показывает приложение.
do $$
declare r record;
begin
  for r in select id from public.households loop
    loop
      begin
        update public.households
          set invite_code = public.generate_household_invite_code()
          where id = r.id;
        exit;
      exception when unique_violation then
      end;
    end loop;
  end loop;
end $$;

commit;
