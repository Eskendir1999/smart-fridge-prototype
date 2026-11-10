begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create schema sf_telegram;
revoke all on schema sf_telegram from public, anon, authenticated;
grant usage on schema sf_telegram to service_role;
create table sf_telegram.handled_updates (
  update_id bigint primary key,
  handled_at timestamptz not null default clock_timestamp()
);
create index handled_updates_expiry on sf_telegram.handled_updates(handled_at);
alter table sf_telegram.handled_updates enable row level security;
revoke all on sf_telegram.handled_updates from public, anon, authenticated;

-- Browser status uses the current signed-in account and never exposes the link code.
drop policy "own telegram link readable" on public.telegram_links;
create policy "own telegram link readable" on public.telegram_links
  for select to authenticated using (user_id = (select sf_private.personal_actor()));
revoke all on public.telegram_links from public, anon, authenticated;
grant select (user_id, chat_id) on public.telegram_links to authenticated;

create or replace function public.generate_telegram_link_token() returns text
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := sf_private.require_personal_actor();
  token text := replace(gen_random_uuid()::text, '-', '');
begin
  insert into public.telegram_links (user_id, link_token, link_token_expires_at)
  values (actor, encode(sha256(convert_to(token, 'UTF8')), 'hex'), clock_timestamp() + interval '5 minutes')
  on conflict (user_id) do update
    set link_token = excluded.link_token, link_token_expires_at = excluded.link_token_expires_at
    where telegram_links.chat_id is null;
  if not found then raise exception 'telegram_already_linked' using errcode = '22023'; end if;
  return token;
end;
$$;
revoke all on function public.generate_telegram_link_token() from public, anon, authenticated;
grant execute on function public.generate_telegram_link_token() to authenticated;

create or replace function public.unlink_telegram() returns void
language plpgsql security definer set search_path = '' as $$
declare actor uuid := sf_private.require_personal_actor();
begin
  delete from public.telegram_links where user_id = actor;
end;
$$;
revoke all on function public.unlink_telegram() from public, anon, authenticated;
grant execute on function public.unlink_telegram() to authenticated;

create function sf_telegram.process_update(p_update_id bigint, p_chat_id bigint, p_action text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  today date := (statement_timestamp() at time zone 'Asia/Almaty')::date;
  payload jsonb;
begin
  if p_update_id is null or p_update_id < 0 or p_chat_id is null or p_chat_id <= 0 or
    p_action is null or p_action not in ('link', 'unlink', 'help', 'buy', 'expiry', 'dinner', 'status') then
    raise exception 'invalid_telegram_update' using errcode = '22023';
  end if;

  -- Telegram delivers updates for up to 24 hours. Keep only unlinked
  -- technical update IDs with a margin, and prune without scheduling delivery.
  delete from sf_telegram.handled_updates where handled_at < statement_timestamp() - interval '2 days';
  insert into sf_telegram.handled_updates(update_id) values (p_update_id) on conflict do nothing;
  if not found then return jsonb_build_object('status', 'duplicate'); end if;

  if p_action = 'link' then
    if p_token ~ '^[0-9a-f]{32}$' then
      begin
        update public.telegram_links l
        set chat_id = p_chat_id, link_token = null, link_token_expires_at = null, linked_at = clock_timestamp()
        where l.chat_id is null
          and l.link_token = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
          and l.link_token_expires_at > clock_timestamp();
        if found then return jsonb_build_object('status', 'linked'); end if;
      exception when unique_violation then
        return jsonb_build_object('status', 'invalid_link');
      end;
    end if;
    return jsonb_build_object('status', 'invalid_link');
  end if;

  if p_action = 'unlink' then
    delete from public.telegram_links where chat_id = p_chat_id;
    return jsonb_build_object('status', 'unlinked');
  end if;

  -- Resolve chat, current household and data in one snapshot. The caller
  -- never supplies a user or household identifier.
  select case when m.household_id is null then jsonb_build_object('status', 'no_household')
    else jsonb_build_object('status', 'ok', 'today', today,
      'cart', case when p_action in ('buy', 'status') then (
        select coalesce(jsonb_agg(to_jsonb(c)), '[]') from (
          select name, qty_num, unit from public.cart_items
          where household_id = m.household_id order by created_at, id limit 11
        ) c
      ) else '[]'::jsonb end,
      'expiry', case when p_action in ('expiry', 'status') then (
        select coalesce(jsonb_agg(to_jsonb(f)), '[]') from (
          select name, expires_on, expiry_estimated from public.fridge_items
          where household_id = m.household_id and qty_num > 0 and expires_on <= today + 3
          order by expires_on, id limit 11
        ) f
      ) else '[]'::jsonb end)
    end
  into payload
  from public.telegram_links l
  left join public.household_members m on m.user_id = l.user_id
  where l.chat_id = p_chat_id;
  return coalesce(payload, jsonb_build_object('status', 'not_linked'));
end;
$$;
revoke all on function sf_telegram.process_update(bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function sf_telegram.process_update(bigint, bigint, text, text) to service_role;

create function public.sf_telegram_update(p_update_id bigint, p_chat_id bigint, p_action text, p_token text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select sf_telegram.process_update(p_update_id, p_chat_id, p_action, p_token)
$$;
revoke all on function public.sf_telegram_update(bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function public.sf_telegram_update(bigint, bigint, text, text) to service_role;

notify pgrst, 'reload schema';
commit;
