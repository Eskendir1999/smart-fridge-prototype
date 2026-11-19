-- Integrated against released owner/My Data schema. Prepared, not yet applied to production.
-- Gates remain off; no legacy ownership assignment or receipt TTL is introduced.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create table sf_private.dinner_release_control(
  singleton boolean primary key default true check(singleton), enabled boolean not null default false,
  profile_privacy_accepted boolean not null default false,
  acceptance_household uuid references public.households(id) on delete set null,
  acceptance_until timestamptz
);
alter table sf_private.dinner_release_control enable row level security;
revoke all on sf_private.dinner_release_control from public,anon,authenticated;
insert into sf_private.dinner_release_control(singleton,enabled) values(true,false);
-- Temporary production acceptance is scoped to one freshly created fixture household.
create function sf_private.dinner_acceptance(hh uuid) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from sf_private.dinner_release_control c where c.singleton
   and c.acceptance_household=hh and c.acceptance_until>statement_timestamp())
$$;
revoke all on function sf_private.dinner_acceptance(uuid) from public,anon,authenticated;
alter table public.fridge_items
  add column ingredient_id text,
  add column quantity_source text not null default 'legacy_unknown' check(quantity_source in ('measured','user','legacy_unknown')),
  add column date_source text not null default 'legacy_unknown' check(date_source in ('label','user','legacy_unknown')),
  add column dinner_version bigint not null default 0,
  add column dinner_excluded boolean not null default false;
alter table public.cart_items add column ingredient_id text, add column dinner_scope text;
create index dinner_cart_scope_idx on public.cart_items(household_id,user_id,dinner_scope) where dinner_scope is not null;
create function sf_private.dinner_version() returns trigger language plpgsql set search_path='' as $$
begin
  new.dinner_version := old.dinner_version + 1;
  if new.name is distinct from old.name then new.ingredient_id := null; end if;
  return new;
end; $$;
create trigger dinner_version before update on public.fridge_items for each row execute function sf_private.dinner_version();
revoke all on function sf_private.dinner_version() from public,anon,authenticated;
-- Keep undo for existing stock receipts and invalidate stale lot versions.
create or replace function sf_private.stock_mutate(op_id uuid, hh_id uuid, kind text, body jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  op sf_private.stock_operations%rowtype;
  original sf_private.stock_operations%rowtype;
  fi public.fridge_items%rowtype;
  ci public.cart_items%rowtype;
  previous jsonb;
  expected jsonb;
  -- Pre-Dinner receipts omit these columns. Compare with their migration defaults,
  -- while any later change (including a Dinner version change) still prevents undo.
  lot_defaults constant jsonb := '{"ingredient_id":null,"quantity_source":"legacy_unknown","date_source":"legacy_unknown","dinner_version":0,"dinner_excluded":false}';
  cart_defaults constant jsonb := '{"ingredient_id":null,"dinner_scope":null}';
  remaining numeric;
  amount numeric;
  kg numeric := 0;
begin
  if uid is null or not public.is_household_member(hh_id) then
    raise exception 'Household access denied' using errcode = '42501';
  end if;
  if op_id is null or body is null then raise exception 'Invalid operation'; end if;
  -- Serialize cooperating clients, including retries and undo, inside this household.
  perform pg_advisory_xact_lock(hashtextextended(hh_id::text, 0));
  perform 1 from sf_private.stock_release_control where singleton and enabled for share;
  if not found then raise exception 'Stock writes paused; retry later' using errcode = '55000'; end if;
  -- Membership can change while this request waits for the household lock.
  -- Recheck and hold that membership row until commit, so a queued request cannot
  -- mutate a household after the user has joined a different one.
  perform 1 from public.household_members where user_id=uid and household_id=hh_id for share;
  if not found then raise exception 'Household access denied' using errcode = '42501'; end if;
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
    elsif kind = 'edit' then
      select * into fi from public.fridge_items where id = (body->>'id')::uuid and household_id = hh_id for update;
      if not found then raise exception 'Product changed; reload' using errcode = '40001'; end if;
      expected := jsonb_build_object('name',fi.name,'emoji',fi.emoji,'qty_num',fi.qty_num,
        'unit',fi.unit,'location',fi.location,'expires_on',fi.expires_on,
        'expiry_estimated',fi.expiry_estimated,'compartment',fi.compartment);
      if expected is distinct from body->'expected' then
        raise exception 'Product changed; reload' using errcode = '40001';
      end if;
      amount := (body->>'qty_num')::numeric;
      if amount is null or amount <= 0 or amount::text in ('NaN','Infinity','-Infinity')
        or length(btrim(coalesce(body->>'name',''))) = 0
        or coalesce(body->>'unit','') not in ('шт','г','кг','мл','л') then raise exception 'Invalid product'; end if;
      op.before_item := to_jsonb(fi);
      update public.fridge_items set name=body->>'name',emoji=coalesce(body->>'emoji','📦'),
        quantity_source=case when fi.qty_num is distinct from amount or fi.unit is distinct from body->>'unit'
          or fi.name is distinct from body->>'name' then 'legacy_unknown' else fi.quantity_source end,
        date_source=case when fi.expires_on is distinct from nullif(body->>'expires_on','')::date
          or fi.expiry_estimated is distinct from coalesce((body->>'expiry_estimated')::boolean,false)
          then 'legacy_unknown' else fi.date_source end,
        qty_num=amount,unit=body->>'unit',location=body->>'location',compartment=body->>'compartment',
        expires_on=nullif(body->>'expires_on','')::date,expiry_estimated=coalesce((body->>'expiry_estimated')::boolean,false)
        where id=fi.id returning * into fi;
      op.after_item := to_jsonb(fi);
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
        if previous is distinct from (cart_defaults||original.before_cart) then raise exception 'Cart changed; cannot undo' using errcode = '40001'; end if;
        delete from public.cart_items where id = original.id;
      else
        select to_jsonb(f) into previous from public.fridge_items f where id = coalesce((original.after_item->>'id')::uuid,(original.before_item->>'id')::uuid) and household_id = hh_id for update;
        if previous is distinct from (lot_defaults||original.after_item) then raise exception 'Product changed; cannot undo' using errcode = '40001'; end if;
        if original.after_item is not null then delete from public.fridge_items where id = (original.after_item->>'id')::uuid; end if;
        if original.before_item is not null then
          insert into public.fridge_items select * from jsonb_populate_record(null::public.fridge_items,lot_defaults||original.before_item||jsonb_build_object(
            'dinner_version', greatest(coalesce((original.before_item->>'dinner_version')::bigint,0),
              coalesce((original.after_item->>'dinner_version')::bigint,0))+1));
        end if;
        if original.action = 'buy' then
          insert into public.cart_items select * from jsonb_populate_record(null::public.cart_items,cart_defaults||original.before_cart);
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
create table sf_private.dinner_operations(
  id uuid primary key, household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, kind text not null, payload jsonb not null,
  before_lots jsonb not null default '[]', after_lots jsonb not null default '[]', undone boolean not null default false,
  used_count int not null default 0, used_kg numeric not null default 0, created_at timestamptz not null default now()
);
alter table sf_private.dinner_operations enable row level security;
revoke all on sf_private.dinner_operations from public,anon,authenticated;
create table sf_private.dinner_scopes(
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, scope_id text not null,
  revision bigint not null default 0, primary key(household_id,user_id,scope_id)
);
alter table sf_private.dinner_scopes enable row level security;
revoke all on sf_private.dinner_scopes from public,anon,authenticated;
create table public.dinner_events(
  id uuid primary key, household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check(kind in ('consume','reversal')), reverses uuid references public.dinner_events(id),
  quantities jsonb not null, created_at timestamptz not null default now()
);
alter table public.dinner_events enable row level security;
create policy dinner_events_read on public.dinner_events for select to authenticated using((select sf_private.personal_actor()) is not null and public.is_household_member(household_id));
revoke all on public.dinner_events from public,anon,authenticated;
grant select on public.dinner_events to authenticated;
create index dinner_events_household_created_idx on public.dinner_events(household_id,created_at desc);
create function sf_private.dinner_catalog() returns jsonb language sql immutable set search_path='' as $catalog$
  select $data${"ingredients":{"egg":{"name":"Яйца","tags":["egg"],"allergensReviewed":true},"cheese":{"name":"Твёрдый сыр","tags":["dairy"],"allergensReviewed":true},"milk":{"name":"Молоко","tags":["dairy"],"allergensReviewed":true},"butter":{"name":"Масло сливочное","tags":["dairy"],"allergensReviewed":true},"herbs":{"name":"Зелень","tags":[],"allergensReviewed":true},"tomato":{"name":"Помидоры","tags":[],"allergensReviewed":true},"cucumber":{"name":"Огурцы","tags":[],"allergensReviewed":true},"oil":{"name":"Оливковое масло","tags":[],"allergensReviewed":true}},"recipes":[{"id":"cheese-cucumber","title":"Салат с сыром и огурцом","basePortions":1,"allowedModes":["standard"],"ingredients":[{"ingredientId":"cheese","quantity":{"value":30,"unit":"g"}},{"ingredientId":"cucumber","quantity":{"value":150,"unit":"g"}}],"steps":["Подготовьте продукты в указанных количествах.","Нарежьте огурец и сыр, смешайте.","Перед списанием укажите фактический расход."],"version":1},{"id":"egg-tomato","title":"Салат с яйцом и помидорами","basePortions":1,"allowedModes":["standard"],"ingredients":[{"ingredientId":"egg","quantity":{"value":2,"unit":"pcs"}},{"ingredientId":"tomato","quantity":{"value":150,"unit":"g"}},{"ingredientId":"oil","quantity":{"value":5,"unit":"ml"}}],"steps":["Сварите яйца, остудите и очистите.","Нарежьте яйца и помидоры, добавьте отмеренное масло.","Перед списанием укажите фактический расход."],"version":1},{"id":"vegetable-salad","title":"Салат из огурцов и помидоров","basePortions":1,"allowedModes":["standard"],"ingredients":[{"ingredientId":"cucumber","quantity":{"value":150,"unit":"g"}},{"ingredientId":"tomato","quantity":{"value":150,"unit":"g"}},{"ingredientId":"oil","quantity":{"value":5,"unit":"ml"}}],"steps":["Подготовьте и отмерьте продукты.","Нарежьте овощи, смешайте с маслом.","Перед списанием укажите фактический расход."],"version":1},{"id":"egg-cucumber","title":"Салат с яйцом и огурцом","basePortions":1,"allowedModes":["standard"],"variantOf":"cheese-cucumber","ingredients":[{"ingredientId":"egg","quantity":{"value":2,"unit":"pcs"}},{"ingredientId":"cucumber","quantity":{"value":150,"unit":"g"}}],"steps":["Сварите яйца, остудите и очистите.","Нарежьте яйца и огурец, смешайте.","Перед списанием укажите фактический расход."],"version":1}],"version":1}$data$::jsonb;
$catalog$;
revoke all on function sf_private.dinner_catalog() from public,anon,authenticated;
create function sf_private.dinner_factor(unit text) returns numeric language sql immutable set search_path='' as $$
  select case unit when 'г' then 1000 when 'g' then 1000 when 'кг' then 1000000 when 'kg' then 1000000
    when 'мл' then 1000 when 'ml' then 1000 when 'л' then 1000000 when 'l' then 1000000 when 'шт' then 1000 when 'pcs' then 1000 end::numeric;
$$;
revoke all on function sf_private.dinner_factor(text) from public,anon,authenticated;
create function sf_private.dinner_requirements(hh uuid, meals jsonb, profiles jsonb)
returns table(meal_id text, day date, ingredient_id text, unit text, required numeric)
language plpgsql set search_path='' as $$
declare m jsonb; r jsonb; ln jsonb; p jsonb; fp public.family_profiles%rowtype; cat jsonb:=sf_private.dinner_catalog(); n numeric;
begin
  if not exists(select 1 from sf_private.dinner_release_control where singleton and (profile_privacy_accepted or sf_private.dinner_acceptance(hh))) then
    raise exception 'Private profile access not accepted' using errcode='42501';
  end if;
  if jsonb_typeof(meals) is distinct from 'array' or jsonb_array_length(meals) not between 1 and 21
    or jsonb_typeof(profiles) is distinct from 'array' or jsonb_array_length(profiles) not between 1 and 30 then raise exception 'Invalid menu'; end if;
  if (select count(distinct x->>'id') from jsonb_array_elements(profiles) x) <> jsonb_array_length(profiles)
    or (select count(distinct x->>'id') from jsonb_array_elements(meals) x) <> jsonb_array_length(meals) then raise exception 'Duplicate selection'; end if;
  for p in select x from jsonb_array_elements(profiles) x order by x->>'id' loop
    select * into fp from public.family_profiles f where id=(p->>'id')::uuid
      and to_jsonb(f)->>'profile_owner_user_id'=auth.uid()::text and f.age>=18 for share;
    if not found then raise exception 'Profile unavailable' using errcode='42501'; end if;
    if fp.excluded_foods is null or not(fp.excluded_foods <@ array['dairy','egg','fish','nuts','gluten']::text[]) then
      raise exception 'Unknown profile restrictions';
    end if;
    if jsonb_build_object('id',fp.id,'mode',fp.diet_mode,'exclusions',fp.excluded_foods) is distinct from p then raise exception 'Profile changed; reload' using errcode='40001'; end if;
  end loop;
  for m in select x from jsonb_array_elements(meals) x order by x->>'day',x->>'id' loop
    select x into r from jsonb_array_elements(cat->'recipes') x where x->>'id'=m->>'recipe_id' and x->>'version'=m->>'recipe_version';
    if not found then raise exception 'Unknown recipe'; end if;
    n:=(m->>'portions')::numeric;
    if n is null or n<1 or n>100 or n<>trunc(n) or m->>'day' is null or (m->>'day') !~ '^\d{4}-\d{2}-\d{2}$' or m->>'id' is null then raise exception 'Invalid portions/date'; end if;
    for p in select x from jsonb_array_elements(profiles) x loop
      if not (r->'allowedModes' ? (p->>'mode')) then raise exception 'Recipe excluded for mode'; end if;
      for ln in select x from jsonb_array_elements(r->'ingredients') x loop
        if exists(select 1 from jsonb_array_elements_text(cat->'ingredients'->(ln->>'ingredientId')->'tags') t
          where (p->'exclusions') ? t) then raise exception 'Recipe excluded for profile'; end if;
      end loop;
    end loop;
    for ln in select x from jsonb_array_elements(r->'ingredients') x loop
      meal_id:=m->>'id'; day:=(m->>'day')::date; ingredient_id:=ln->>'ingredientId'; unit:=ln->'quantity'->>'unit';
      required:=(ln->'quantity'->>'value')::numeric*sf_private.dinner_factor(unit)*n/(r->>'basePortions')::numeric;
      if required<>trunc(required) or (unit='pcs' and mod(required,1000)<>0) then raise exception 'Quantity needs clarification'; end if;
      return next;
    end loop;
  end loop;
end; $$;
revoke all on function sf_private.dinner_requirements(uuid,jsonb,jsonb) from public,anon,authenticated;
create function sf_private.dinner_state(hh uuid, uid uuid) returns jsonb language sql set search_path='' as $$
 select jsonb_build_object('fridge_items',coalesce((select jsonb_agg(f order by f.created_at,f.id) from public.fridge_items f where f.household_id=hh),'[]'::jsonb),
  'cart_items',coalesce((select jsonb_agg(c order by c.created_at,c.id) from public.cart_items c where c.household_id=hh),'[]'::jsonb),
  'stats',(select to_jsonb(s) from public.food_stats s where s.user_id=uid),
  'profile_access_ready',exists(select 1 from sf_private.dinner_release_control where singleton and (profile_privacy_accepted or sf_private.dinner_acceptance(hh)))
     and exists(select 1 from pg_catalog.pg_attribute where attrelid='public.family_profiles'::regclass and attname='profile_owner_user_id' and not attisdropped),
  'profiles',case when exists(select 1 from sf_private.dinner_release_control where singleton and (profile_privacy_accepted or sf_private.dinner_acceptance(hh)))
    then coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'stock_scope_id',hh,
      'profile_owner_user_id',uid,'diet_mode',p.diet_mode,'excluded_foods',p.excluded_foods) order by p.id)
      from public.family_profiles p where to_jsonb(p)->>'profile_owner_user_id'=uid::text and p.age>=18),'[]'::jsonb)
    else '[]'::jsonb end,
  'events',coalesce((select jsonb_agg(e order by e.created_at desc,e.id) from
    (select * from public.dinner_events where household_id=hh order by created_at desc,id limit 20) e),'[]'::jsonb),
  'demand_versions',coalesce((select jsonb_object_agg(d.scope_id,d.revision) from sf_private.dinner_scopes d where d.household_id=hh and d.user_id=uid),'{}'::jsonb),
  'today',(now() at time zone 'Asia/Almaty')::date);
$$;
revoke all on function sf_private.dinner_state(uuid,uuid) from public,anon,authenticated;
create function sf_private.dinner_mutate(op_id uuid,hh_id uuid,kind text,body jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=sf_private.require_personal_actor(); op sf_private.dinner_operations%rowtype; original sf_private.dinner_operations%rowtype;
 fi public.fridge_items%rowtype; ci public.cart_items%rowtype; req record; d jsonb; snap jsonb; r jsonb;
 required_map jsonb:='{}'; used_map jsonb:='{}'; remaining_map jsonb:='{}'; demand jsonb:='{}';
 before_rows jsonb:='[]'; after_rows jsonb:='[]'; actuals jsonb:='[]'; n numeric; ticks numeric; available numeric; deficit numeric; take numeric;
 kg numeric:=0; cnt int:=0; scope_revision bigint; today date:=(now() at time zone 'Asia/Almaty')::date; uncertain boolean;
begin
 if uid is null or not public.is_household_member(hh_id) then raise exception 'Household access denied' using errcode='42501'; end if;
 if exists(select 1 from auth.users u where u.id=uid and coalesce((to_jsonb(u)->>'is_anonymous')::boolean,false)) then
   raise exception 'Anonymous Auth not allowed' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(hh_id::text,0));
 if sf_private.personal_actor() is distinct from uid then raise exception 'authentication_required' using errcode='42501'; end if;
 perform 1 from public.household_members where user_id=uid and household_id=hh_id for share;
 if not found then raise exception 'Household access denied' using errcode='42501'; end if;
 if kind='snapshot' then return sf_private.dinner_state(hh_id,uid); end if;
 perform 1 from sf_private.stock_release_control where singleton and enabled for share;
 if not found then raise exception 'Stock writes paused; retry later' using errcode='55000'; end if;
 perform 1 from sf_private.dinner_release_control where singleton and (enabled or sf_private.dinner_acceptance(hh_id)) for share;
 if not found then raise exception 'Dinner writes disabled; retry later' using errcode='55000'; end if;
 if op_id is null or jsonb_typeof(body) is distinct from 'object' or octet_length(body::text)>65536 then raise exception 'Invalid request'; end if;
 -- Logout removes private request input locally. Resolve its opaque ID under the
 -- same lock: acknowledge a committed receipt, or reserve a cancellation tombstone
 -- so a delayed original request can never commit after a "not saved" result.
 if kind='resolve' then
   select * into op from sf_private.dinner_operations where id=op_id;
   if found then
     if op.household_id<>hh_id or op.user_id<>uid then raise exception 'Operation access denied' using errcode='42501'; end if;
   else
     insert into sf_private.dinner_operations(id,household_id,user_id,kind,payload) values(op_id,hh_id,uid,'cancelled','{}') returning * into op;
   end if;
   return sf_private.dinner_state(hh_id,uid)||jsonb_build_object('operation_id',op_id,'kind','resolve','resolved_kind',op.kind,
      'operation_state',case when op.kind='cancelled' then 'cancelled' else 'saved' end,'undone',op.undone);
 end if;
 select * into op from sf_private.dinner_operations where id=op_id;
 if found then
   if op.household_id<>hh_id or op.user_id<>uid or op.kind<>kind or op.payload<>body then raise exception 'Operation ID already used' using errcode='22023'; end if;
 else
   if kind='exclude_lot' then
     select * into fi from public.fridge_items where id=(body->>'id')::uuid and household_id=hh_id for update;
     if not found or fi.dinner_version is distinct from (body->>'expected_version')::bigint then raise exception 'Lot changed' using errcode='40001'; end if;
     if jsonb_typeof(body->'excluded') is distinct from 'boolean' then raise exception 'Invalid exclusion'; end if;
     before_rows:=jsonb_build_array(to_jsonb(fi));
     update public.fridge_items set dinner_excluded=(body->>'excluded')::boolean where id=fi.id returning * into fi;
     after_rows:=jsonb_build_array(to_jsonb(fi));
   elsif kind='confirm_lot' then
     select * into fi from public.fridge_items where id=(body->>'id')::uuid and household_id=hh_id for update;
     if not found or fi.dinner_version is distinct from (body->>'expected_version')::bigint then raise exception 'Lot changed' using errcode='40001'; end if;
     n:=(body->>'qty_num')::numeric;
     if body->>'ingredient_id' is null or not (sf_private.dinner_catalog()->'ingredients' ? (body->>'ingredient_id')) or n is null or n<0 or n>1000000
       or n::text in ('NaN','Infinity','-Infinity') or n<>round(n,3) or coalesce(body->>'unit','') not in ('г','кг','мл','л','шт')
       or (body->>'unit'='шт' and n<>trunc(n)) then raise exception 'Invalid quantity/ingredient'; end if;
     if nullif(body->>'expires_on','') is not null and body->>'expires_on' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid date'; end if;
     before_rows:=jsonb_build_array(to_jsonb(fi));
     update public.fridge_items set ingredient_id=body->>'ingredient_id',qty_num=n,unit=body->>'unit',quantity_source='user',dinner_excluded=false,
       expires_on=nullif(body->>'expires_on','')::date,date_source=case when nullif(body->>'expires_on','') is null then 'legacy_unknown' else 'user' end,expiry_estimated=false
       where id=fi.id returning * into fi;
     after_rows:=jsonb_build_array(to_jsonb(fi));
   elsif kind in ('consume','shopping') then
     -- Validate profiles and the canonical recipe before touching any rows.
     for req in select * from sf_private.dinner_requirements(hh_id,body->'meals',body->'profiles') loop
       if kind='consume' and req.day<>today then raise exception 'Cooking date changed; reload' using errcode='40001'; end if;
       required_map:=jsonb_set(required_map,array[req.ingredient_id],to_jsonb(coalesce((required_map->>req.ingredient_id)::numeric,0)+req.required));
     end loop;
     if kind='consume' then
       if jsonb_array_length(body->'meals')<>1 or jsonb_typeof(body->'deltas') is distinct from 'array'
         or jsonb_array_length(body->'deltas') not between 1 and 50 then raise exception 'Invalid consumption'; end if;
       if (select count(distinct x->>'id') from jsonb_array_elements(body->'deltas') x)<>jsonb_array_length(body->'deltas') then raise exception 'Duplicate lot'; end if;
       for d in select x from jsonb_array_elements(body->'deltas') x order by x->>'id' loop
         select * into fi from public.fridge_items where id=(d->>'id')::uuid and household_id=hh_id for update;
         if not found or fi.dinner_version is distinct from (d->>'expected_version')::bigint then raise exception 'Lot changed' using errcode='40001'; end if;
         if fi.dinner_excluded or fi.qty_num<=0 or fi.qty_num::text in ('NaN','Infinity','-Infinity') or fi.qty_num<>round(fi.qty_num,3)
           or fi.ingredient_id is null or not(required_map ? fi.ingredient_id) or fi.quantity_source not in ('measured','user')
           or fi.date_source not in ('label','user') or fi.expiry_estimated or fi.expires_on is null or fi.expires_on<today then raise exception 'Lot needs clarification'; end if;
         select x into r from jsonb_array_elements((sf_private.dinner_catalog()->'recipes')) x where x->>'id'=body->'meals'->0->>'recipe_id';
         if not exists(select 1 from jsonb_array_elements(r->'ingredients') x where x->>'ingredientId'=fi.ingredient_id and
           (case when fi.unit in ('г','кг') then 'g' when fi.unit in ('мл','л') then 'ml' when fi.unit='шт' then 'pcs' end)=x->'quantity'->>'unit') then raise exception 'Unit incompatible'; end if;
         n:=(d->>'amount')::numeric;
         if n is null or n<=0 or n>fi.qty_num or n::text in ('NaN','Infinity','-Infinity') or n<>round(n,3) or (fi.unit='шт' and n<>trunc(n)) then raise exception 'Invalid actual quantity'; end if;
         ticks:=n*sf_private.dinner_factor(fi.unit);
         available:=coalesce((used_map->>fi.ingredient_id)::numeric,0)+ticks;
         if available>(required_map->>fi.ingredient_id)::numeric then raise exception 'Actual exceeds confirmed recipe'; end if;
         used_map:=jsonb_set(used_map,array[fi.ingredient_id],to_jsonb(available));
         before_rows:=before_rows||jsonb_build_array(to_jsonb(fi));
         actuals:=actuals||jsonb_build_array(jsonb_build_object('lot_id',fi.id,'ingredient_id',fi.ingredient_id,'amount',n,'unit',fi.unit));
         kg:=kg+case when fi.unit='г' then n/1000 when fi.unit='кг' then n else 0 end; cnt:=cnt+1;
         update public.fridge_items set qty_num=qty_num-n where id=fi.id returning * into fi;
         after_rows:=after_rows||jsonb_build_array(to_jsonb(fi));
       end loop;
       insert into public.dinner_events(id,household_id,user_id,kind,quantities) values(op_id,hh_id,uid,'consume',actuals);
       insert into public.food_stats(user_id,used_count,used_weight_kg) values(uid,cnt,kg) on conflict(user_id) do update
         set used_count=public.food_stats.used_count+cnt,used_weight_kg=public.food_stats.used_weight_kg+kg;
     else
       if length(coalesce(body->>'scope_id','')) not between 1 and 100 then raise exception 'Invalid shopping scope'; end if;
       insert into sf_private.dinner_scopes(household_id,user_id,scope_id) values(hh_id,uid,body->>'scope_id') on conflict do nothing;
       select revision into scope_revision from sf_private.dinner_scopes where household_id=hh_id and user_id=uid and scope_id=body->>'scope_id' for update;
       if scope_revision is distinct from coalesce((body->>'expected_scope_revision')::bigint,0) then raise exception 'Shopping plan changed; reload' using errcode='40001'; end if;
       for req in select * from sf_private.dinner_requirements(hh_id,body->'meals',body->'profiles') loop
         deficit:=req.required; uncertain:=false;
         for fi in select * from public.fridge_items f where f.household_id=hh_id and not f.dinner_excluded and (f.ingredient_id=req.ingredient_id or f.ingredient_id is null)
           and f.qty_num<>0 order by f.expires_on nulls last,f.id for update loop
           if fi.expires_on<req.day then continue; end if;
           if fi.qty_num<0 or fi.qty_num::text in ('NaN','Infinity','-Infinity') or fi.qty_num<>round(fi.qty_num,3)
             or (fi.unit='шт' and fi.qty_num<>trunc(fi.qty_num))
             or fi.ingredient_id is null or fi.quantity_source not in ('measured','user') or fi.expires_on is null
             or fi.date_source not in ('label','user') or fi.expiry_estimated or
             (case when fi.unit in ('г','кг') then 'g' when fi.unit in ('мл','л') then 'ml' when fi.unit='шт' then 'pcs' end) is distinct from req.unit then uncertain:=true; continue; end if;
           available:=coalesce((remaining_map->>fi.id::text)::numeric,fi.qty_num*sf_private.dinner_factor(fi.unit));
           take:=least(available,deficit); deficit:=deficit-take;
           remaining_map:=jsonb_set(remaining_map,array[fi.id::text],to_jsonb(available-take));
         end loop;
         if deficit>0 and uncertain then raise exception 'Inventory needs clarification'; end if;
         if deficit>0 then demand:=jsonb_set(demand,array[req.ingredient_id],to_jsonb(coalesce((demand->>req.ingredient_id)::numeric,0)+deficit)); end if;
       end loop;
       if demand is distinct from body->'desired' then raise exception 'Shopping demand changed; reload' using errcode='40001'; end if;
       delete from public.cart_items where household_id=hh_id and user_id=uid and dinner_scope=body->>'scope_id';
       for d in select jsonb_build_object('id',key,'amount',value) from jsonb_each(demand) loop
         select x into r from jsonb_array_elements(sf_private.dinner_catalog()->'recipes') cr cross join lateral jsonb_array_elements(cr->'ingredients') x where x->>'ingredientId'=d->>'id' limit 1;
         insert into public.cart_items(user_id,household_id,name,emoji,qty_num,unit,note,ingredient_id,dinner_scope)
           values(uid,hh_id,sf_private.dinner_catalog()->'ingredients'->(d->>'id')->>'name','🛒',(d->>'amount')::numeric/1000,
             case r->'quantity'->>'unit' when 'g' then 'г' when 'ml' then 'мл' else 'шт' end,'Для выбранного ужина',d->>'id',body->>'scope_id');
       end loop;
       update sf_private.dinner_scopes set revision=revision+1 where household_id=hh_id and user_id=uid and scope_id=body->>'scope_id';
     end if;
   elsif kind='buy' then
     select * into ci from public.cart_items where id=(body->>'id')::uuid and household_id=hh_id for update;
     if not found or to_jsonb(ci) is distinct from body->'expected' then raise exception 'Shopping changed' using errcode='40001'; end if;
     if ci.ingredient_id is null or ci.qty_num<=0 then raise exception 'Unmapped purchase'; end if;
     if nullif(body->>'expires_on','') is not null and body->>'expires_on' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid date'; end if;
     insert into public.fridge_items(id,user_id,household_id,name,emoji,qty_num,unit,compartment,location,expires_on,expiry_estimated,ingredient_id,quantity_source,date_source)
       values(op_id,uid,hh_id,ci.name,ci.emoji,ci.qty_num,ci.unit,'fridge','Средняя полка',nullif(body->>'expires_on','')::date,false,ci.ingredient_id,'user',
         case when nullif(body->>'expires_on','') is null then 'legacy_unknown' else 'user' end) returning * into fi;
     after_rows:=jsonb_build_array(to_jsonb(fi)); delete from public.cart_items where id=ci.id;
   elsif kind='undo' then
     select * into original from sf_private.dinner_operations where id=(body->>'operation_id')::uuid and household_id=hh_id and user_id=uid for update;
     if not found or original.kind<>'consume' then raise exception 'Nothing to undo'; end if;
     if not original.undone then
       for snap in select x from jsonb_array_elements(original.after_lots) x order by x->>'id' loop
         select * into fi from public.fridge_items where id=(snap->>'id')::uuid and household_id=hh_id for update;
         if not found or to_jsonb(fi) is distinct from snap then raise exception 'Lot changed; cannot undo' using errcode='40001'; end if;
       end loop;
       for snap in select x from jsonb_array_elements(original.before_lots) x loop
         update public.fridge_items set qty_num=(snap->>'qty_num')::numeric where id=(snap->>'id')::uuid;
       end loop;
       update public.food_stats set used_count=used_count-original.used_count,used_weight_kg=used_weight_kg-original.used_kg where user_id=uid;
       insert into public.dinner_events(id,household_id,user_id,kind,reverses,quantities) select op_id,hh_id,uid,'reversal',original.id,e.quantities from public.dinner_events e where id=original.id;
       update sf_private.dinner_operations set undone=true where id=original.id;
     end if;
   else raise exception 'Unknown dinner action'; end if;
   insert into sf_private.dinner_operations(id,household_id,user_id,kind,payload,before_lots,after_lots,used_count,used_kg)
     values(op_id,hh_id,uid,kind,body,before_rows,after_rows,cnt,kg) returning * into op;
 end if;
 return sf_private.dinner_state(hh_id,uid)||jsonb_build_object('operation_id',op_id,'kind',op.kind,'undone',op.undone);
end; $$;
revoke all on function sf_private.dinner_mutate(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function sf_private.dinner_mutate(uuid,uuid,text,jsonb) to authenticated;
create function public.dinner_mutate(op_id uuid,hh_id uuid,kind text,body jsonb) returns jsonb language sql security invoker set search_path='' as $$
 select sf_private.dinner_mutate(op_id,hh_id,kind,body);
$$;
revoke all on function public.dinner_mutate(uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.dinner_mutate(uuid,uuid,text,jsonb) to authenticated;
notify pgrst, 'reload schema';

alter table sf_private.dinner_operations add column profile_context_erased_at timestamptz;
create index dinner_operations_user_created_idx on sf_private.dinner_operations(user_id,created_at,id);

-- dinner_requirements holds FOR SHARE on each profile until its receipt commits.
-- DELETE waits for that lock, then this AFTER trigger sees and erases its receipt.
-- A later new consume/shopping cannot validate a profile which no longer exists.
-- Keep operation IDs, undo snapshots and shared inventory history: deleting a
-- receipt would allow a lost-response retry to execute the same UUID again.
create function sf_private.dinner_forget_deleted_profile() returns trigger
language plpgsql security definer set search_path='' as $$
declare owner_id uuid := nullif(to_jsonb(old)->>'profile_owner_user_id','')::uuid;
begin
 if owner_id is not null then
  update sf_private.dinner_operations o set payload='{}'::jsonb,profile_context_erased_at=now()
   where o.user_id=owner_id and o.payload @> jsonb_build_object('profiles',jsonb_build_array(jsonb_build_object('id',old.id)));
 end if;
 return old;
end $$;
revoke all on function sf_private.dinner_forget_deleted_profile() from public,anon,authenticated;
create trigger dinner_forget_deleted_profile after delete on public.family_profiles
 for each row execute function sf_private.dinner_forget_deleted_profile();

-- Stable projection shares the outer My Data SELECT snapshot. It is not callable by clients.
create function sf_private.dinner_export_snapshot(actor uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('version',1,'exported_at',now(),
  'operations',coalesce((select jsonb_agg(jsonb_build_object(
    'id',o.id,'kind',o.kind,'created_at',o.created_at,'undone',o.undone,
    'profile_context_erased_at',o.profile_context_erased_at,
    'profiles',coalesce(o.payload->'profiles','[]'::jsonb),'meals',coalesce(o.payload->'meals','[]'::jsonb),
    'related_operation_id',o.payload->'operation_id',
    'lot_changes',coalesce((select jsonb_agg(jsonb_build_object('id',lot->'id','quantity',lot->'qty_num','unit',lot->'unit'))
      from jsonb_array_elements(o.after_lots) lot),'[]'::jsonb)) order by o.created_at,o.id)
    from sf_private.dinner_operations o where o.user_id=actor),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'kind',e.kind,'reverses',e.reverses,
    'quantities',e.quantities,'created_at',e.created_at) order by e.created_at,e.id)
    from public.dinner_events e where e.user_id=actor),'[]'::jsonb),
  'limits',jsonb_build_object('scope','own_dinner_actions_only','shared_inventory_removed',false,
    'profile_deletion','private_request_context_erased; operation_ids_and_undo_preserved',
    'backups','unverified','account_retention','unverified'));
$$;
revoke all on function sf_private.dinner_export_snapshot(uuid) from public,anon,authenticated;
create function sf_private.dinner_my_data() returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=sf_private.require_personal_actor(); output jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('my-data:'||actor::text,0));
 if sf_private.personal_actor() is distinct from actor then raise exception 'authentication_required' using errcode='42501'; end if;
 select sf_private.dinner_export_snapshot(actor) into output;
 if pg_catalog.octet_length(output::text)>5242880 then raise exception 'export_too_large'; end if;
 return output;
end $$;
revoke all on function sf_private.dinner_my_data() from public,anon;
grant execute on function sf_private.dinner_my_data() to authenticated;
create function public.sf_dinner_my_data() returns jsonb
language sql security invoker set search_path='' as $$select sf_private.dinner_my_data()$$;
revoke all on function public.sf_dinner_my_data() from public,anon;
grant execute on function public.sf_dinner_my_data() to authenticated;

create or replace function sf_private.my_data(action text,profile_id uuid,scope text,request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_actor uuid:=sf_private.require_personal_actor();
 output jsonb;
 receipt sf_private.data_deletion_receipts%rowtype;
 removed bigint:=0; removed_summaries bigint:=0;
 issued_at timestamptz;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('my-data:'||v_actor::text,0));
 if sf_private.personal_actor() is distinct from v_actor then raise exception 'authentication_required' using errcode='42501'; end if;
 if action='read' and (exists(select 1 from sf_private.dinner_operations o where o.user_id=v_actor) or exists(select 1 from public.dinner_events e where e.user_id=v_actor)) then raise exception 'client_upgrade_required' using errcode='55000'; end if;
 if action in ('read','read_v2') then
  if profile_id is not null or scope is not null or request_id is not null then raise exception 'invalid_read_arguments'; end if;
  select jsonb_build_object(
   'version',1,'export_contract',2,'dinner',sf_private.dinner_export_snapshot(v_actor), 'exported_at',now(),
   'profiles',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'sex',p.sex,'age',p.age,'height_cm',p.height_cm,'start_weight_kg',p.start_weight_kg,'target_weight_kg',p.target_weight_kg,'goal',p.goal,'activity_level',p.activity_level,'diet_mode',p.diet_mode,'baby_age_months',p.baby_age_months,'excluded_foods',p.excluded_foods,'meal_choices',p.meal_choices,'created_at',p.created_at) order by p.created_at,p.id) from public.family_profiles p where p.profile_owner_user_id=v_actor),'[]'::jsonb),
   'measurements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'profile_id',m.profile_id,'log_date',m.log_date,'weight',m.weight,'neck',m.neck,'chest',m.chest,'belly',m.belly,'hips',m.hips,'created_at',m.created_at) order by m.log_date,m.id) from public.family_measurements m join public.family_profiles p on p.id=m.profile_id where p.profile_owner_user_id=v_actor),'[]'::jsonb),
   'legacy_measurements',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'log_date',m.log_date,'weight',m.weight,'neck',m.neck,'chest',m.chest,'belly',m.belly,'hips',m.hips,'created_at',m.created_at) order by m.log_date,m.id) from public.measurement_logs m where m.user_id=v_actor),'[]'::jsonb),
   'legacy_messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'role',m.role,'content',m.content,'created_at',m.created_at) order by m.created_at,m.id) from public.dietitian_messages m where m.user_id=v_actor),'[]'::jsonb),
   'legacy_summaries',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'week_start',m.week_start,'summary',m.summary,'created_at',m.created_at) order by m.created_at,m.id) from public.dietitian_summaries m where m.user_id=v_actor),'[]'::jsonb),
   'ai',jsonb_build_object('enabled',false,'memory_enabled',false,'consent_flow_available',false),
   'legacy_scope','account_archive_not_assigned_to_a_profile',
   'deletion_limits',jsonb_build_object('backups','unverified','external_provider','unverified')
  ) into output;
  if pg_catalog.octet_length(output::text)>5242880 then raise exception 'export_too_large'; end if;
  return output;
 end if;

 if action not in ('prepare_delete','delete') or action is null or scope is null
  or scope not in ('measurements','profile','legacy_ai','legacy_measurements') then raise exception 'invalid_action'; end if;
 if (scope in ('legacy_ai','legacy_measurements'))<>(profile_id is null) then raise exception 'invalid_scope'; end if;
 -- One actor lock orders prepare/delete/read and makes duplicate execution atomic.
 if action='prepare_delete' then
  if request_id is not null then raise exception 'server_ticket_required'; end if;
  if profile_id is not null then
   perform 1 from public.family_profiles p where p.id=$2 and p.profile_owner_user_id=v_actor for update;
   if not found then raise exception 'not_available' using errcode='42501'; end if;
  end if;
  if (select count(*) from sf_private.data_deletion_receipts r where r.actor=v_actor and r.result is null and r.expires_at>clock_timestamp())>=100 then
   raise exception 'too_many_pending_requests';
  end if;
  issued_at:=clock_timestamp();
  insert into sf_private.data_deletion_receipts(actor,scope,profile_id,created_at,expires_at)
   values(v_actor,$3,$2,issued_at,issued_at+interval '90 days') returning * into receipt;
  return jsonb_build_object('status','confirmation_required','request_id',receipt.request_id,'scope',receipt.scope,'profile_id',receipt.profile_id,'expires_at',receipt.expires_at);
 end if;
 if request_id is null then raise exception 'server_ticket_required'; end if;
 select * into receipt from sf_private.data_deletion_receipts r where r.actor=v_actor and r.request_id=$4 for update;
 if not found or receipt.expires_at<=clock_timestamp() then raise exception 'request_expired_or_unknown' using errcode='22023'; end if;
 if receipt.scope is distinct from scope or receipt.profile_id is distinct from profile_id then raise exception 'request_id_reused'; end if;
 if receipt.result is not null then return receipt.result; end if;
 if profile_id is not null then
  perform 1 from public.family_profiles p where p.id=$2 and p.profile_owner_user_id=v_actor for update;
  if not found then raise exception 'not_available' using errcode='42501'; end if;
 end if;
 if receipt.expires_at<=clock_timestamp() then raise exception 'request_expired_or_unknown' using errcode='22023'; end if;
 if scope='profile' then
  select count(*) into removed_summaries from public.family_measurements m where m.profile_id=$2;
  delete from public.family_profiles p where p.id=$2 and p.profile_owner_user_id=v_actor;
  get diagnostics removed=row_count;
 elsif scope='measurements' then
  delete from public.family_measurements m where m.profile_id=$2;
  get diagnostics removed=row_count;
 elsif scope='legacy_measurements' then
  delete from public.measurement_logs m where m.user_id=v_actor;
  get diagnostics removed=row_count;
 else
  delete from public.dietitian_messages m where m.user_id=v_actor;
  get diagnostics removed=row_count;
  delete from public.dietitian_summaries m where m.user_id=v_actor;
  get diagnostics removed_summaries=row_count;
 end if;
 output:=jsonb_build_object('request_id',request_id,'scope',scope,'profile_id',profile_id,'status','active_database_deleted','removed',removed,'related_removed',removed_summaries,'completed_at',clock_timestamp(),'expires_at',receipt.expires_at,'backups','unverified','external_provider','unverified');
 update sf_private.data_deletion_receipts r set result=output where r.actor=v_actor and r.request_id=$4;
 return output;
end;
$$;
notify pgrst,'reload schema';
commit;
