begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table sf_private.account_erasure_control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  acceptance_actor uuid,
  acceptance_until timestamptz
);
insert into sf_private.account_erasure_control default values;
alter table sf_private.account_erasure_control enable row level security;
revoke all on sf_private.account_erasure_control from public, anon, authenticated;

-- The secret receipt stays with the requester. After success the server keeps
-- only its hash and the completion time, independently of the erased account.
create table sf_private.account_erasure_receipts (
  receipt_hash bytea primary key,
  actor uuid references auth.users(id) on delete cascade,
  original_session uuid,
  started_at timestamptz not null,
  completed_at timestamptz,
  expires_at timestamptz not null,
  check ((completed_at is null and actor is not null and original_session is not null)
    or (completed_at is not null and actor is null and original_session is null))
);
create unique index account_erasure_one_pending on sf_private.account_erasure_receipts(actor);
create index account_erasure_expiry on sf_private.account_erasure_receipts(expires_at);
alter table sf_private.account_erasure_receipts enable row level security;
revoke all on sf_private.account_erasure_receipts from public, anon, authenticated;

create or replace function sf_private.purge_expired_deletion_receipts() returns bigint
language plpgsql security invoker set search_path = '' as $$
declare personal_removed bigint; account_removed bigint;
begin
  delete from sf_private.data_deletion_receipts where expires_at <= clock_timestamp();
  get diagnostics personal_removed = row_count;
  delete from sf_private.account_erasure_receipts where expires_at <= clock_timestamp();
  get diagnostics account_removed = row_count;
  return personal_removed + account_removed;
end;
$$;

alter table public.fridge_items alter column user_id drop not null;
alter table public.cart_items alter column user_id drop not null;
alter table public.food_events alter column user_id drop not null;
alter table public.dinner_events alter column user_id drop not null;

-- Removing attribution alone does not change a lot's contents. Preserve the
-- version so a surviving member's existing undo still compares equal.
create or replace function sf_private.dinner_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.user_id is not null and new.user_id is null
    and (to_jsonb(new) - 'user_id') = (to_jsonb(old) - 'user_id') then
    return new;
  end if;
  new.dinner_version := old.dinner_version + 1;
  if new.name is distinct from old.name then new.ingredient_id := null; end if;
  return new;
end;
$$;

create function sf_private.erase_attribution(snapshot jsonb, actor uuid) returns jsonb
language sql immutable set search_path = '' as $$
  select case when snapshot->>'user_id' = actor::text then
    (snapshot || '{"user_id":null}'::jsonb)
      || case when snapshot ? 'dinner_scope' then '{"dinner_scope":null}'::jsonb else '{}'::jsonb end
  else snapshot end
$$;
revoke all on function sf_private.erase_attribution(jsonb, uuid) from public, anon, authenticated;

create function sf_private.erasure_households(actor uuid) returns setof uuid
language sql stable set search_path = '' as $$
  select household_id from public.household_members where user_id = actor
  union select household_id from public.fridge_items where user_id = actor
  union select household_id from public.cart_items where user_id = actor
  union select household_id from public.food_events where user_id = actor
  union select household_id from public.dinner_events where user_id = actor
  union select household_id from sf_private.stock_operations
    where user_id = actor or actor::text in (before_item->>'user_id', after_item->>'user_id', before_cart->>'user_id')
  union select household_id from sf_private.dinner_operations
    where user_id = actor or (payload->'expected'->>'user_id') = actor::text
      or before_lots @> jsonb_build_array(jsonb_build_object('user_id', actor))
      or after_lots @> jsonb_build_array(jsonb_build_object('user_id', actor))
$$;
revoke all on function sf_private.erasure_households(uuid) from public, anon, authenticated;

-- Operator-only core. A restore into quarantine can use the same erasure
-- logic with independently verified deletion requests.
create function sf_private.erase_account(actor uuid, verified_session uuid default null) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  affected uuid[];
  surviving uuid[];
  household uuid;
begin
  select array(select id from sf_private.erasure_households(actor) id where id is not null order by id)
    into affected;
  foreach household in array affected loop
    perform pg_advisory_xact_lock(hashtextextended(household::text, 0));
  end loop;

  perform 1 from auth.users u where u.id = actor for update;
  if not found then return false; end if;
  if verified_session is not null then
    perform 1 from auth.sessions s where s.id = verified_session and s.user_id = actor
      and (s.not_after is null or s.not_after > clock_timestamp()) for share;
    if not found then raise exception 'authentication_required' using errcode = '42501'; end if;
  end if;

  if exists(select 1 from sf_private.erasure_households(actor) id where id is not null and not (id = any(affected))) then
    raise exception 'account data changed; retry' using errcode = '40001';
  end if;
  select array(select distinct h.household_id from public.household_members h
    where h.household_id = any(affected) and h.user_id <> actor) into surviving;

  update public.fridge_items set user_id = null where user_id = actor and household_id = any(surviving);
  update public.cart_items set user_id = null, dinner_scope = null
    where user_id = actor and household_id = any(surviving);
  update public.food_events set user_id = null where user_id = actor and household_id = any(surviving);
  update public.dinner_events set user_id = null where user_id = actor and household_id = any(surviving);

  -- Other members can undo their own operations on these shared rows.
  update sf_private.stock_operations set
    before_item = sf_private.erase_attribution(before_item, actor),
    after_item = sf_private.erase_attribution(after_item, actor),
    before_cart = sf_private.erase_attribution(before_cart, actor)
  where user_id <> actor and actor::text in (before_item->>'user_id', after_item->>'user_id', before_cart->>'user_id');
  update sf_private.dinner_operations o set
    before_lots = (select coalesce(jsonb_agg(sf_private.erase_attribution(x, actor) order by ordinal), '[]')
      from jsonb_array_elements(o.before_lots) with ordinality as lot(x, ordinal)),
    after_lots = (select coalesce(jsonb_agg(sf_private.erase_attribution(x, actor) order by ordinal), '[]')
      from jsonb_array_elements(o.after_lots) with ordinality as lot(x, ordinal)),
    payload = case when o.payload->'expected'->>'user_id' = actor::text
      then jsonb_set(o.payload, '{expected}', sf_private.erase_attribution(o.payload->'expected', actor)) else o.payload end
  where o.user_id <> actor and (o.payload->'expected'->>'user_id' = actor::text
    or o.before_lots @> jsonb_build_array(jsonb_build_object('user_id', actor))
    or o.after_lots @> jsonb_build_array(jsonb_build_object('user_id', actor)));

  delete from sf_private.stock_release_backup where row_data->>'user_id' = actor::text;
  -- Supabase cascades Auth identities, sessions and refresh tokens. Application
  -- FKs cascade personal rows and only clear creator provenance on old profiles.
  delete from auth.flow_state f where f.user_id = actor or f.linking_target_id = actor;
  delete from auth.users u where u.id = actor;

  -- A sole member's inventory has no other recipient. Keep households that
  -- still link to closed legacy profiles, without changing the legacy link.
  delete from public.fridge_items where household_id = any(affected) and not (household_id = any(surviving));
  delete from public.cart_items where household_id = any(affected) and not (household_id = any(surviving));
  delete from public.food_events where household_id = any(affected) and not (household_id = any(surviving));
  delete from public.dinner_events where household_id = any(affected) and not (household_id = any(surviving));
  delete from public.households h where h.id = any(affected) and not (h.id = any(surviving))
    and not exists (select 1 from public.family_profiles p where p.household_id = h.id);

  -- The old code was known to the departing member. Replace it without
  -- touching the remaining memberships.
  foreach household in array affected loop
    loop
      begin
        update public.households set invite_code = public.generate_household_invite_code() where id = household;
        exit;
      exception when unique_violation then null;
      end;
    end loop;
  end loop;
  return true;
end;
$$;
revoke all on function sf_private.erase_account(uuid, uuid) from public, anon, authenticated;

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
  if hh_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(hh_id::text, 0));
    -- Re-read after the lock. Deletion may have rotated this invite or
    -- closed the last membership while the request was queued.
    if not exists(select 1 from public.households h where h.id = hh_id and h.invite_code = normalized
      and exists(select 1 from public.household_members m where m.household_id = h.id)) then
      hh_id := null;
    end if;
  end if;
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

create function sf_private.account_erasure_enabled(actor uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled or coalesce(acceptance_actor = actor and acceptance_until > statement_timestamp(), false)
    from sf_private.account_erasure_control where singleton), false)
$$;
revoke all on function sf_private.account_erasure_enabled(uuid) from public, anon, authenticated;

create schema sf_erasure;
revoke all on schema sf_erasure from public;
grant usage on schema sf_erasure to anon, authenticated;

create function sf_erasure.request(action text, receipt_secret uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid;
  sid uuid;
  receipt_hash_value bytea;
  receipt sf_private.account_erasure_receipts%rowtype;
  stamp timestamptz;
begin
  if action = 'availability' then
    actor_id := sf_private.personal_actor();
    return jsonb_build_object('enabled', actor_id is not null and sf_private.account_erasure_enabled(actor_id));
  end if;
  if receipt_secret is null then raise exception 'receipt_required' using errcode = '22023'; end if;
  receipt_hash_value := sha256(convert_to(receipt_secret::text, 'UTF8'));

  if action = 'status' then
    select * into receipt from sf_private.account_erasure_receipts r
      where r.receipt_hash = receipt_hash_value and r.completed_at is not null and r.expires_at > clock_timestamp();
    if not found then return jsonb_build_object('status', 'unknown_or_expired'); end if;
    return jsonb_build_object('status', 'active_account_deleted',
      'completed_at', receipt.completed_at, 'expires_at', receipt.expires_at);
  end if;

  actor_id := sf_private.personal_actor();
  if actor_id is null or action not in ('prepare', 'delete') or action is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('account-erasure:' || actor_id::text, 0));
  if not sf_private.account_erasure_enabled(actor_id) then
    raise exception 'account_erasure_unavailable' using errcode = '55000';
  end if;
  sid := (auth.jwt()->>'session_id')::uuid;

  if action = 'prepare' then
    perform sf_private.require_personal_actor();
    delete from sf_private.account_erasure_receipts r where r.actor = actor_id;
    stamp := clock_timestamp();
    insert into sf_private.account_erasure_receipts(receipt_hash, actor, original_session, started_at, expires_at)
      values(receipt_hash_value, actor_id, sid, stamp, stamp + interval '10 minutes');
    return jsonb_build_object('status', 'confirmation_required');
  end if;

  select * into receipt from sf_private.account_erasure_receipts r
    where r.receipt_hash = receipt_hash_value and r.actor = actor_id and r.expires_at > clock_timestamp() for update;
  if not found then raise exception 'request_expired_or_unknown' using errcode = '22023'; end if;
  if sid is null or sid = receipt.original_session
    or not exists (select 1 from auth.sessions s where s.id = sid and s.user_id = actor_id
      and s.created_at >= receipt.started_at)
    or not exists (select 1 from jsonb_array_elements(coalesce(auth.jwt()->'amr', '[]')) claim
      where claim->>'method' = 'password'
        and (claim->>'timestamp')::bigint >= floor(extract(epoch from receipt.started_at)))
    or (coalesce(auth.jwt()->>'aal', '') <> 'aal2'
      and exists (select 1 from auth.mfa_factors f where f.user_id = actor_id and f.status = 'verified')) then
    raise exception 'fresh_password_sign_in_required' using errcode = '42501';
  end if;

  -- This update and the hard deletion commit together. A lost response can
  -- only be resolved as a receipt lookup. It never issues another deletion.
  stamp := clock_timestamp();
  update sf_private.account_erasure_receipts r set actor = null, original_session = null,
    completed_at = stamp, expires_at = stamp + interval '90 days' where r.receipt_hash = receipt_hash_value;
  if not sf_private.erase_account(actor_id, sid) then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  return jsonb_build_object('status', 'active_account_deleted',
    'completed_at', stamp, 'expires_at', stamp + interval '90 days');
end;
$$;
revoke all on function sf_erasure.request(text, uuid) from public, anon, authenticated;
grant execute on function sf_erasure.request(text, uuid) to anon, authenticated;

create function public.sf_account_erasure(action text, receipt_secret uuid default null) returns jsonb
language sql security invoker set search_path = '' as $$
  select sf_erasure.request(action, receipt_secret)
$$;
revoke all on function public.sf_account_erasure(text, uuid) from public, anon, authenticated;
grant execute on function public.sf_account_erasure(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
