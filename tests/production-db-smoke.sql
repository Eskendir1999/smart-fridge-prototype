-- Rollback-only acceptance. Synthetic records are invisible to other sessions and
-- never persist. No existing user's row is selected for mutation or deleted.
begin;
set local statement_timeout='30s';
set local idle_in_transaction_session_timeout='10s';
select set_config('sf.release_test_user',gen_random_uuid()::text,true),
       set_config('sf.release_test_other',gen_random_uuid()::text,true),
       set_config('sf.release_test_house',gen_random_uuid()::text,true),
       set_config('sf.release_test_foreign_house',gen_random_uuid()::text,true);
insert into auth.users(id) values(current_setting('sf.release_test_user')::uuid),(current_setting('sf.release_test_other')::uuid);
insert into public.households(id,invite_code) values
 (current_setting('sf.release_test_house')::uuid,'RELEASE-CHECK-'||gen_random_uuid()::text),
 (current_setting('sf.release_test_foreign_house')::uuid,'RELEASE-CHECK-'||gen_random_uuid()::text);
insert into public.household_members(user_id,household_id) values
 (current_setting('sf.release_test_user')::uuid,current_setting('sf.release_test_house')::uuid),
 (current_setting('sf.release_test_other')::uuid,current_setting('sf.release_test_foreign_house')::uuid);
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('sf.release_test_user'),true),
       set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('sf.release_test_user'),'role','authenticated')::text,true);
do $$
declare
  hh uuid:=current_setting('sf.release_test_house')::uuid;
  product uuid:=gen_random_uuid(); use_op uuid:=gen_random_uuid(); cart uuid:=gen_random_uuid(); buy_op uuid:=gen_random_uuid();
  reply jsonb;
begin
  if auth.uid() is distinct from current_setting('sf.release_test_user')::uuid then raise exception 'wrong auth context'; end if;
  reply:=public.stock_mutate(product,hh,'add_item',jsonb_build_object('name','Synthetic rollback-only release check','qty_num',500,'unit','г','compartment','fridge','expiry_estimated',false));
  reply:=public.stock_mutate(use_op,hh,'used',jsonb_build_object('id',product,'expected_qty',500,'expected_unit','г','amount',200));
  reply:=public.stock_mutate(use_op,hh,'used',jsonb_build_object('id',product,'expected_qty',500,'expected_unit','г','amount',200));
  if (select qty_num from public.fridge_items where id=product)<>300 then raise exception 'wrong remainder'; end if;
  if (select count(*) from public.food_events where id=use_op)<>1 then raise exception 'duplicate journal'; end if;
  reply:=public.stock_mutate(gen_random_uuid(),hh,'undo',jsonb_build_object('operation_id',use_op));
  if (select qty_num from public.fridge_items where id=product)<>500 then raise exception 'undo did not restore'; end if;
  if exists(select 1 from public.food_events where id=use_op) then raise exception 'undo did not restore journal'; end if;
  reply:=public.stock_mutate(cart,hh,'add_cart',jsonb_build_object('name','Synthetic cart release check','qty_num',2,'unit','шт'));
  reply:=public.stock_mutate(buy_op,hh,'buy',jsonb_build_object('id',cart,'expected_qty',2,'expected_unit','шт','compartment','fridge'));
  reply:=public.stock_mutate(buy_op,hh,'buy',jsonb_build_object('id',cart,'expected_qty',2,'expected_unit','шт','compartment','fridge'));
  if exists(select 1 from public.cart_items where id=cart) or (select count(*) from public.fridge_items where id=buy_op)<>1 then raise exception 'transfer failed'; end if;
  reply:=public.stock_mutate(gen_random_uuid(),hh,'undo',jsonb_build_object('operation_id',buy_op));
  if not exists(select 1 from public.cart_items where id=cart) then raise exception 'cart undo failed'; end if;
  begin
    update public.fridge_items set qty_num=1 where id=product;
    raise exception 'legacy direct write was allowed';
  exception when insufficient_privilege then null; end;
  if has_table_privilege(current_user,'sf_private.stock_release_backup','SELECT') then raise exception 'backup exposed'; end if;
  if has_table_privilege(current_user,'public.fridge_items','TRUNCATE') then raise exception 'truncate privilege exposed'; end if;
  perform set_config('request.jwt.claim.sub',current_setting('sf.release_test_other'),true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('sf.release_test_other'),'role','authenticated')::text,true);
  if exists(select 1 from public.fridge_items where id=product) then raise exception 'foreign family read allowed'; end if;
  begin
    reply:=public.stock_mutate(gen_random_uuid(),hh,'add_cart',jsonb_build_object('name','must be denied','qty_num',1,'unit','шт'));
    raise exception 'foreign family write allowed';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
select jsonb_build_object('rollback_smoke','passed','persisted_test_rows',
  (select count(*) from public.households where invite_code like 'RELEASE-CHECK-%')) as verification;
