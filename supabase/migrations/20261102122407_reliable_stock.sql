-- Prepared only. Requires schema + household/security + food-log migrations.
-- Apply in an isolated database first; do not run against production as part of this PR.
begin;
-- Historical dates have no provenance. Mark them as estimates conservatively;
-- future explicit/manual dates are not estimates unless the client says so.
alter table public.fridge_items add column expiry_estimated boolean not null default true;
alter table public.fridge_items alter column expiry_estimated set default false;

create schema if not exists sf_private;
revoke all on schema sf_private from public, anon, authenticated;
grant usage on schema sf_private to authenticated;
create table sf_private.stock_operations (
  id uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  payload jsonb not null,
  before_item jsonb,
  after_item jsonb,
  before_cart jsonb,
  event_id uuid,
  qty_kg numeric not null default 0,
  undone boolean not null default false,
  created_at timestamptz not null default now()
);
alter table sf_private.stock_operations enable row level security;
revoke all on sf_private.stock_operations from public, anon, authenticated;

-- Privileged implementation stays outside the exposed schema. It alone can write the
-- immutable retry/undo receipts. Every entry checks auth + household, with qualified SQL.
create function sf_private.stock_mutate(op_id uuid, hh_id uuid, kind text, body jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  op sf_private.stock_operations%rowtype;
  original sf_private.stock_operations%rowtype;
  fi public.fridge_items%rowtype;
  ci public.cart_items%rowtype;
  previous jsonb;
  remaining numeric;
  amount numeric;
  kg numeric := 0;
  ev uuid;
begin
  if uid is null or not public.is_household_member(hh_id) then
    raise exception 'Household access denied' using errcode = '42501';
  end if;
  if op_id is null or body is null then raise exception 'Invalid operation'; end if;
  -- Serialize cooperating clients, including retries and undo, inside this household.
  perform pg_advisory_xact_lock(hashtextextended(hh_id::text, 0));
  select * into op from sf_private.stock_operations where id = op_id;
  if found then
    if op.user_id <> uid or op.household_id <> hh_id or op.action <> kind or op.payload <> body then
      raise exception 'Operation ID already used' using errcode = '22023';
    end if;
  else
    op.id := op_id; op.user_id := uid; op.household_id := hh_id; op.action := kind; op.payload := body;
    if kind in ('add_item', 'add_cart') then
      amount := (body->>'qty_num')::numeric;
      if amount is null or amount <= 0 or amount::text in ('NaN','Infinity','-Infinity')
        or length(btrim(coalesce(body->>'name',''))) = 0
        or coalesce(body->>'unit','') not in ('шт','г','кг','мл','л') then raise exception 'Invalid product'; end if;
      if kind = 'add_item' then
        insert into public.fridge_items(id,user_id,household_id,name,emoji,qty_num,unit,compartment,location,expires_on,expiry_estimated)
        values(op_id,uid,hh_id,body->>'name',coalesce(body->>'emoji','📦'),amount,body->>'unit',body->>'compartment',body->>'location',nullif(body->>'expires_on','')::date,coalesce((body->>'expiry_estimated')::boolean,false)) returning * into fi;
        op.after_item := to_jsonb(fi);
      else
        insert into public.cart_items(id,user_id,household_id,name,emoji,qty_num,unit,note)
        values(op_id,uid,hh_id,body->>'name',coalesce(body->>'emoji','🛒'),amount,body->>'unit',body->>'note') returning * into ci;
        op.before_cart := to_jsonb(ci);
      end if;
    elsif kind = 'buy' then
      select * into ci from public.cart_items where id = (body->>'id')::uuid and household_id = hh_id for update;
      if not found then raise exception 'Cart item changed; reload' using errcode = '40001'; end if;
      if ci.qty_num is distinct from (body->>'expected_qty')::numeric or ci.unit is distinct from body->>'expected_unit' then
        raise exception 'Cart item changed; reload' using errcode = '40001';
      end if;
      if ci.qty_num <= 0 or ci.qty_num::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid quantity'; end if;
      op.before_cart := to_jsonb(ci);
      insert into public.fridge_items(id,user_id,household_id,name,emoji,qty_num,unit,compartment,location,expires_on,expiry_estimated)
      values(op_id,uid,hh_id,ci.name,ci.emoji,ci.qty_num,ci.unit,body->>'compartment',body->>'location',nullif(body->>'expires_on','')::date,true) returning * into fi;
      op.after_item := to_jsonb(fi);
      delete from public.cart_items where id = ci.id;
    elsif kind in ('used','wasted') then
      select * into fi from public.fridge_items where id = (body->>'id')::uuid and household_id = hh_id for update;
      if not found then raise exception 'Product changed; reload' using errcode = '40001'; end if;
      if fi.qty_num is distinct from (body->>'expected_qty')::numeric or fi.unit is distinct from body->>'expected_unit' then
        raise exception 'Product changed; reload' using errcode = '40001';
      end if;
      amount := (body->>'amount')::numeric;
      if amount is null or amount <= 0 or amount > fi.qty_num or amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid quantity'; end if;
      op.before_item := to_jsonb(fi);
      remaining := fi.qty_num - amount;
      kg := case when fi.unit in ('кг','л') then amount when fi.unit in ('г','мл') then amount/1000 else amount*0.15 end;
      if remaining = 0 then
        delete from public.fridge_items where id = fi.id;
      else
        update public.fridge_items set qty_num = remaining where id = fi.id returning * into fi;
        op.after_item := to_jsonb(fi);
      end if;
      insert into public.food_events(id,household_id,user_id,name,emoji,action,qty_kg)
        values(op_id,hh_id,uid,fi.name,fi.emoji,kind,kg);
      op.event_id := op_id; op.qty_kg := kg;
      insert into public.food_stats(user_id,used_count,used_weight_kg,wasted_count)
        values(uid,case when kind='used' then 1 else 0 end,case when kind='used' then kg else 0 end,case when kind='wasted' then 1 else 0 end)
        on conflict (user_id) do update set
          used_count = public.food_stats.used_count + excluded.used_count,
          used_weight_kg = public.food_stats.used_weight_kg + excluded.used_weight_kg,
          wasted_count = public.food_stats.wasted_count + excluded.wasted_count;
    elsif kind = 'undo' then
      select * into original from sf_private.stock_operations where id = (body->>'operation_id')::uuid and household_id = hh_id and user_id = uid for update;
      if not found or original.action = 'undo' then raise exception 'Nothing to undo'; end if;
      if original.undone then raise exception 'Already undone'; end if;
      if original.action = 'add_cart' then
        select to_jsonb(c) into previous from public.cart_items c where id = original.id and household_id = hh_id for update;
        if previous is distinct from original.before_cart then raise exception 'Cart changed; cannot undo' using errcode = '40001'; end if;
        delete from public.cart_items where id = original.id;
      else
        select to_jsonb(f) into previous from public.fridge_items f where id = coalesce((original.after_item->>'id')::uuid,(original.before_item->>'id')::uuid) and household_id = hh_id for update;
        if previous is distinct from original.after_item then raise exception 'Product changed; cannot undo' using errcode = '40001'; end if;
        if original.after_item is not null then delete from public.fridge_items where id = (original.after_item->>'id')::uuid; end if;
        if original.before_item is not null then
          insert into public.fridge_items select * from jsonb_populate_record(null::public.fridge_items,original.before_item);
        end if;
        if original.action = 'buy' then
          insert into public.cart_items select * from jsonb_populate_record(null::public.cart_items,original.before_cart);
        end if;
        if original.event_id is not null then
          delete from public.food_events where id = original.event_id and household_id = hh_id;
          update public.food_stats set
            used_count = used_count - case when original.action='used' then 1 else 0 end,
            used_weight_kg = used_weight_kg - case when original.action='used' then original.qty_kg else 0 end,
            wasted_count = wasted_count - case when original.action='wasted' then 1 else 0 end
            where user_id = uid;
        end if;
      end if;
      update sf_private.stock_operations set undone = true where id = original.id;
    else raise exception 'Unknown stock operation';
    end if;
    insert into sf_private.stock_operations(id,household_id,user_id,action,payload,before_item,after_item,before_cart,event_id,qty_kg)
      values(op_id,hh_id,uid,kind,body,op.before_item,op.after_item,op.before_cart,op.event_id,coalesce(op.qty_kg,0));
  end if;
  -- A replay returns current state, never an obsolete cached snapshot.
  return jsonb_build_object('operation_id',op_id,
    'fridge_items',coalesce((select jsonb_agg(f order by f.created_at,f.id) from public.fridge_items f where household_id=hh_id),'[]'::jsonb),
    'cart_items',coalesce((select jsonb_agg(c order by c.created_at,c.id) from public.cart_items c where household_id=hh_id),'[]'::jsonb),
    'stats',(select to_jsonb(s) from public.food_stats s where user_id=uid));
end;
$$;
revoke all on function sf_private.stock_mutate(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function sf_private.stock_mutate(uuid,uuid,text,jsonb) to authenticated;

create function public.stock_mutate(op_id uuid, hh_id uuid, kind text, body jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select sf_private.stock_mutate(op_id,hh_id,kind,body);
$$;
revoke all on function public.stock_mutate(uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.stock_mutate(uuid,uuid,text,jsonb) to authenticated;
commit;
