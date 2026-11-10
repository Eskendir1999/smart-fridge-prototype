const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {createStockDb,user,other,stranger,household,otherHousehold}=require('./helpers/stock-db.cjs');
let f;
test.before(async()=>{f=await createStockDb();});
test.after(async()=>{await f?.db.close();});
const spend=(id,amount=200,qty=500)=>({id,amount,expected_qty:qty,expected_unit:'г'});
const buy=id=>({id,expected_qty:500,expected_unit:'г',compartment:'fridge',location:'Средняя полка',expires_on:'2026-11-08'});
const scalar=async sql=>(await f.db.query(sql)).rows[0].n;
test('500 g minus 200 g leaves 300; retry after lost response changes neither remainder nor journal/stats',async()=>{
  const id=await f.add(),op=randomUUID();
  const a=await f.rpc('used',spend(id),{id:op});
  const b=await f.rpc('used',spend(id),{id:op});
  assert.equal(a.fridge_items.find(p=>p.id===id).qty_num,300);
  assert.equal(b.fridge_items.find(p=>p.id===id).qty_num,300);
  assert.equal(await scalar(`select count(*)::int n from food_events where id='${op}'`),1);
  assert.equal(b.stats.used_count,a.stats.used_count);assert.equal(b.stats.used_weight_kg,a.stats.used_weight_kg);
});
test('undo partial use restores exact product, stats and journal; undo retry is idempotent',async()=>{
  const id=await f.add(),op=randomUUID(),undo=randomUUID();
  const before=(await f.db.query('select to_jsonb(f) r from fridge_items f where id=$1',[id])).rows[0].r;
  const stats=(await f.db.query('select * from food_stats where user_id=$1',[user])).rows[0];
  await f.rpc('used',spend(id),{id:op});
  await f.rpc('undo',{operation_id:op},{id:undo});await f.rpc('undo',{operation_id:op},{id:undo});
  assert.deepEqual((await f.db.query('select to_jsonb(f) r from fridge_items f where id=$1',[id])).rows[0].r,{...before,dinner_version:Number(before.dinner_version)+2});
  assert.deepEqual((await f.db.query('select * from food_stats where user_id=$1',[user])).rows[0],stats);
  assert.equal(await scalar(`select count(*)::int n from food_events where id='${op}'`),0);
});
test('full use and waste can both be undone',async()=>{
  for(const action of ['used','wasted']){
    const id=await f.add(),op=randomUUID();await f.rpc(action,spend(id,500),{id:op});
    assert.equal(await scalar(`select count(*)::int n from fridge_items where id='${id}'`),0);
    await f.rpc('undo',{operation_id:op});
    assert.equal(await scalar(`select qty_num::int n from fridge_items where id='${id}'`),500);
  }
});
test('buy commits transfer once and undo restores original cart, including owner and timestamps',async()=>{
  const id=await f.cart(),op=randomUUID();
  const before=(await f.db.query('select to_jsonb(c) r from cart_items c where id=$1',[id])).rows[0].r;
  await f.rpc('buy',buy(id),{id:op});const result=await f.rpc('buy',buy(id),{id:op});
  assert.equal(result.cart_items.some(c=>c.id===id),false);assert.equal(result.fridge_items.filter(p=>p.id===op).length,1);
  await assert.rejects(f.rpc('buy',buy(id)),/Cart item changed/);
  await f.rpc('undo',{operation_id:op});
  assert.deepEqual((await f.db.query('select to_jsonb(c) r from cart_items c where id=$1',[id])).rows[0].r,before);
  assert.equal(await scalar(`select count(*)::int n from fridge_items where id='${op}'`),0);
});
for(const [table,event] of [['fridge_items','insert'],['cart_items','delete'],['stock_operations','insert']]){
  test(`failure at ${table} ${event} rolls entire purchase back; retry creates one item`,async()=>{
    const id=await f.cart(),op=randomUUID(),schema=table==='stock_operations'?'sf_private':'public';
    await f.db.exec(`create or replace function public.test_fail() returns trigger language plpgsql as $$begin raise exception 'injected failure'; end$$;
      create trigger injected_failure before ${event} on ${schema}.${table} for each row execute function public.test_fail();`);
    await assert.rejects(f.rpc('buy',buy(id),{id:op}),/injected failure/);
    assert.equal(await scalar(`select count(*)::int n from cart_items where id='${id}'`),1);
    assert.equal(await scalar(`select count(*)::int n from fridge_items where id='${op}'`),0);
    assert.equal(await scalar(`select count(*)::int n from sf_private.stock_operations where id='${op}'`),0);
    await f.db.exec(`drop trigger injected_failure on ${schema}.${table}`);
    await f.rpc('buy',buy(id),{id:op});await f.rpc('buy',buy(id),{id:op});
    assert.equal(await scalar(`select count(*)::int n from fridge_items where id='${op}'`),1);
  });
}
for(const table of ['food_events','food_stats']){
  test(`failure writing ${table} rolls back quantity, event and statistics`,async()=>{
    const id=await f.add(),op=randomUUID();
    await f.db.exec(`create trigger injected_failure before insert on public.${table} for each row execute function public.test_fail();`);
    await assert.rejects(f.rpc('used',spend(id),{id:op}),/injected failure/);
    assert.equal(await scalar(`select qty_num::int n from fridge_items where id='${id}'`),500);
    assert.equal(await scalar(`select count(*)::int n from food_events where id='${op}'`),0);
    await f.db.exec(`drop trigger injected_failure on public.${table}`);
  });
}
test('stale quantity and changed row prevent destructive use/undo',async()=>{
  const id=await f.add(),op=randomUUID();await f.rpc('used',spend(id),{id:op});
  await assert.rejects(f.rpc('used',spend(id)),/Product changed/);
  await f.rpc('used',spend(id,50,300));
  await assert.rejects(f.rpc('undo',{operation_id:op}),/Product changed/);
  assert.equal(await scalar(`select qty_num::int n from fridge_items where id='${id}'`),250);
});
test('invalid quantities and reused ID with different intent are rejected',async()=>{
  const id=await f.add(),op=randomUUID();
  for(const amount of [-1,0,501,'NaN','Infinity',null]) await assert.rejects(f.rpc('used',spend(id,amount)),/quantity|numeric/);
  await f.rpc('used',spend(id),{id:op});
  await assert.rejects(f.rpc('used',spend(id,100),{id:op}),/already used/);
});
test('anonymous, non-member, foreign source IDs and undo of another member are denied',async()=>{
  const id=await f.add(),op=randomUUID();
  await assert.rejects(f.rpc('used',spend(id),{role:'anon',as:null}),/permission denied/);
  await assert.rejects(f.rpc('used',spend(id),{as:stranger}),/access denied/);
  await assert.rejects(f.rpc('used',spend(id),{as:stranger,hh:otherHousehold}),/Product changed/);
  await f.rpc('used',spend(id),{id:op});
  await assert.rejects(f.rpc('undo',{operation_id:op},{as:other}),/Nothing to undo/);
  await assert.rejects(f.db.transaction(async tx=>{await tx.exec('set local role authenticated');await tx.query('select * from sf_private.stock_operations');}),/permission denied/);
});
test('same household members can consume, while replay returns current state after later changes',async()=>{
  const id=await f.add(),op=randomUUID();await f.rpc('used',spend(id),{id:op});
  await f.rpc('used',spend(id,50,300),{as:other});
  const result=await f.rpc('used',spend(id),{id:op});assert.equal(result.fridge_items.find(p=>p.id===id).qty_num,250);
});
test('failed undo leaves original consumption, journal and receipt intact; retry restores all',async()=>{
  const id=await f.add(),op=randomUUID(),undo=randomUUID();await f.rpc('used',spend(id,500),{id:op});
  const prior=(await f.db.query('select * from food_stats where user_id=$1',[user])).rows[0];
  await f.db.exec('create trigger injected_failure before insert on public.fridge_items for each row execute function public.test_fail()');
  await assert.rejects(f.rpc('undo',{operation_id:op},{id:undo}),/injected failure/);
  assert.equal(await scalar(`select count(*)::int n from fridge_items where id='${id}'`),0);
  assert.equal(await scalar(`select count(*)::int n from food_events where id='${op}'`),1);
  assert.equal((await f.db.query('select undone from sf_private.stock_operations where id=$1',[op])).rows[0].undone,false);
  assert.deepEqual((await f.db.query('select * from food_stats where user_id=$1',[user])).rows[0],prior);
  await f.db.exec('drop trigger injected_failure on public.fridge_items');await f.rpc('undo',{operation_id:op},{id:undo});
  assert.equal(await scalar(`select qty_num::int n from fridge_items where id='${id}'`),500);
  assert.equal(await scalar(`select count(*)::int n from food_events where id='${op}'`),0);
});
test('retrying adds creates one row; undo reverses fridge and cart additions',async()=>{
  for(const [kind,table,body] of [
    ['add_item','fridge_items',{name:'Added',qty_num:1,unit:'шт',compartment:'fridge',expires_on:null,expiry_estimated:false}],
    ['add_cart','cart_items',{name:'Added',qty_num:1,unit:'шт'}]]){
    const id=randomUUID();await f.rpc(kind,body,{id});await f.rpc(kind,body,{id});
    assert.equal(await scalar(`select count(*)::int n from ${table} where id='${id}'`),1);
    await f.rpc('undo',{operation_id:id});assert.equal(await scalar(`select count(*)::int n from ${table} where id='${id}'`),0);
  }
});
test('new privileged code is private; public RPC is invoker, anon cannot execute and receipt table has RLS/no client grants',async()=>{
  const p=(await f.db.query(`select p.prosecdef,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where proname='stock_mutate' order by n.nspname`)).rows;
  assert.deepEqual(p,[{prosecdef:false,nspname:'public'},{prosecdef:true,nspname:'sf_private'}]);
  assert.equal((await f.db.query("select has_function_privilege('anon','public.stock_mutate(uuid,uuid,text,jsonb)','execute') allowed")).rows[0].allowed,false);
  assert.equal((await f.db.query("select has_table_privilege('authenticated','sf_private.stock_operations','insert') allowed")).rows[0].allowed,false);
  assert.equal((await f.db.query("select relrowsecurity from pg_class where oid='sf_private.stock_operations'::regclass")).rows[0].relrowsecurity,true);
});
async function editBody(id,changes={}){
  const row=(await f.db.query('select to_jsonb(f) r from fridge_items f where id=$1',[id])).rows[0].r;
  const fields=['name','emoji','qty_num','unit','location','expires_on','expiry_estimated','compartment'];
  const expected=Object.fromEntries(fields.map(key=>[key,row[key]]));
  return {id,expected,...expected,...changes};
}
test('editing uses a durable operation, can move compartments and undo restores exact original row',async()=>{
  const id=await f.add(),op=randomUUID();const body=await editBody(id,{name:'Edited',qty_num:450,compartment:'freezer',location:'Морозилка'});
  await f.rpc('edit',body,{id:op});const result=await f.rpc('edit',body,{id:op});
  const row=result.fridge_items.find(p=>p.id===id);assert.equal(row.qty_num,450);assert.equal(row.compartment,'freezer');
  assert.equal(await scalar(`select count(*)::int n from sf_private.stock_operations where id='${op}'`),1);
  await f.rpc('undo',{operation_id:op});const restored=(await f.db.query('select to_jsonb(f) r from fridge_items f where id=$1',[id])).rows[0].r;
  for(const key of Object.keys(body.expected))assert.deepEqual(restored[key],body.expected[key]);
});
test('stale editor cannot overwrite a later consumption or rename by another family member',async()=>{
  const id=await f.add();const stale=await editBody(id,{qty_num:600});await f.rpc('used',spend(id),{as:other});
  await assert.rejects(f.rpc('edit',stale),/Product changed/);assert.equal(await scalar(`select qty_num::int n from fridge_items where id='${id}'`),300);
  const a=await editBody(id,{name:'Name A'}),b=await editBody(id,{name:'Name B'});await f.rpc('edit',a,{as:other});
  await assert.rejects(f.rpc('edit',b),/Product changed/);
});
test('failed edit and zero quantity leave product and receipt unchanged',async()=>{
  const id=await f.add(),op=randomUUID(),body=await editBody(id,{qty_num:0});
  await assert.rejects(f.rpc('edit',body,{id:op}),/Invalid product/);
  assert.equal(await scalar(`select qty_num::int n from fridge_items where id='${id}'`),500);
  assert.equal(await scalar(`select count(*)::int n from sf_private.stock_operations where id='${op}'`),0);
});
test('legacy direct writes are denied while transaction RPC and reads remain available',async()=>{
  const id=await f.add();
  await assert.rejects(f.db.transaction(async tx=>{
    await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
    await tx.query('update fridge_items set qty_num=1 where id=$1',[id]);
  }),/permission denied/);
  assert.equal(await scalar(`select qty_num::int n from fridge_items where id='${id}'`),500);
  await f.rpc('used',spend(id));assert.equal(await scalar(`select qty_num::int n from fridge_items where id='${id}'`),300);
});
test('release pause rejects mutations without changing stock; resume safely retries same ID',async()=>{
  const id=await f.add(),op=randomUUID();await f.db.exec('update sf_private.stock_release_control set enabled=false');
  try{await assert.rejects(f.rpc('used',spend(id),{id:op}),/Stock writes paused/);assert.equal(await scalar(`select qty_num::int n from fridge_items where id='${id}'`),500);}
  finally{await f.db.exec('update sf_private.stock_release_control set enabled=true');}
  await f.rpc('used',spend(id),{id:op});assert.equal(await scalar(`select qty_num::int n from fridge_items where id='${id}'`),300);
});
test('release migration snapshots existing rows before metadata changes without altering quantities',async()=>{
  const u='90000000-0000-4000-8000-000000000001',h='90000000-0000-4000-8000-000000000002',id='90000000-0000-4000-8000-000000000003';
  const isolated=await createStockDb({beforeStockMigration:async db=>db.exec(`
    insert into auth.users(id) values('${u}');insert into households(id,invite_code) values('${h}','BACKUP');
    insert into household_members(user_id,household_id) values('${u}','${h}');
    insert into fridge_items(id,user_id,household_id,name,qty_num,compartment,unit) values('${id}','${u}','${h}','Synthetic backup fixture',500,'fridge','г');
  `)});
  try{
    const before=(await isolated.db.query("select row_data from sf_private.stock_release_backup where source_table='fridge_items' and source_id=$1",[id])).rows[0].row_data;
    assert.equal(before.qty_num,500);assert.equal(before.expiry_estimated,undefined);
    const after=(await isolated.db.query('select to_jsonb(f) r from fridge_items f where id=$1',[id])).rows[0].r;
    for(const key of ['expiry_estimated','ingredient_id','quantity_source','date_source','dinner_version','dinner_excluded']) delete after[key];assert.deepEqual(after,before);
    assert.equal((await isolated.db.query("select has_table_privilege('authenticated','sf_private.stock_release_backup','select') allowed")).rows[0].allowed,false);
  }finally{await isolated.db.close();}
});
