const test=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {createStockDb,user,other,stranger,household,otherHousehold}=require('./helpers/stock-db.cjs');
const catalog=require('../dinner/catalog.json');
const {PGlite}=require('@electric-sql/pglite');
let engine;
test.before(async()=>{engine=await PGlite.create()});
test.after(async()=>{await engine?.close()});
const profileId='30000000-0000-4000-8000-000000000001';
async function fixture(){
 // Each case gets a clean schema; reuse the initialized WASM engine, not its data.
 await engine.exec('drop schema public cascade; drop schema if exists sf_private cascade; drop schema if exists auth cascade; create schema public');
 const database={exec:(...a)=>engine.exec(...a),query:(...a)=>engine.query(...a),transaction:fn=>engine.transaction(fn),close:async()=>{}};
 const f=await createStockDb({database,enableDinner:true});
 await f.db.query(`insert into family_profiles(id,household_id,created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg) values($1,$2,$3,$3,'Test','male',30,170,70)`,[profileId,household,user]);
 const rpc=(kind,body={},opts={})=>f.db.transaction(async tx=>{await tx.exec(`set local role ${opts.role||'authenticated'}`);await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[opts.as===null?'':opts.as||user]);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:opts.as===null?null:opts.as||user,session_id:opts.as===null?null:opts.as||user})]);return (await tx.query('select public.dinner_mutate($1::uuid,$2::uuid,$3,$4::jsonb) as result',[opts.id||randomUUID(),opts.hh||household,kind,JSON.stringify(body)])).rows[0].result});
 const state=()=>rpc('snapshot'); const initial=await state();const today=initial.today;
 const profiles=[{id:profileId,mode:'standard',exclusions:[]}];
 const meals=(count=1,portions=1)=>Array.from({length:count},(_,i)=>({id:'d'+i,day:new Date(Date.parse(today+'T00:00Z')+i*86400000).toISOString().slice(0,10),recipe_id:'cheese-cucumber',recipe_version:1,portions}));
 const row=async id=>(await f.db.query('select * from fridge_items where id=$1',[id])).rows[0];
 async function lot(ingredient='cheese',qty=500,unit='г',date='2099-12-01'){
  const id=await f.add(qty,unit);await rpc('confirm_lot',{id,expected_version:0,ingredient_id:ingredient,qty_num:qty,unit,expires_on:date});return id;
 }
 const request=async(ids,amounts)=>({profiles,meals:meals(),deltas:await Promise.all(ids.map(async(id,i)=>({id,expected_version:(await row(id)).dinner_version,amount:amounts[i]})))});
 return {...f,rpc,state,today,profiles,meals,row,lot,request};
}
test('dinner catalog in SQL equals the reviewed client artifact',async()=>{const f=await fixture();try{assert.deepEqual((await f.db.query('select sf_private.dinner_catalog() c')).rows[0].c,catalog);}finally{await f.db.close()}});
test('atomic partial use preserves both lots; repeats and undo retain an immutable journal',async()=>{const f=await fixture();try{
 const a=await f.lot(),b=await f.lot('cucumber',2000);const body=await f.request([a,b],[200,1000]);body.meals[0].portions=10;const id=randomUUID();
 const saved=await f.rpc('consume',body,{id});assert.equal(saved.kind,'consume');assert.equal(Number((await f.row(a)).qty_num),300);assert.equal(Number((await f.row(b)).qty_num),1000);
 await f.rpc('consume',body,{id});assert.equal((await f.db.query('select count(*)::int n from dinner_events')).rows[0].n,1);
 await assert.rejects(()=>f.rpc('consume',{...body,deltas:[body.deltas[0]]},{id}),/already used/);
 const undo=randomUUID();await f.rpc('undo',{operation_id:id},{id:undo});await f.rpc('undo',{operation_id:id},{id:undo});
 await f.rpc('undo',{operation_id:id});assert.equal(Number((await f.row(a)).qty_num),500);assert.equal(Number((await f.row(b)).qty_num),2000);
 assert.deepEqual((await f.db.query('select kind from dinner_events order by created_at')).rows.map(r=>r.kind),['consume','reversal']);
 assert.equal((await f.state()).stats.used_count,0);assert.equal((await f.rpc('consume',body,{id})).undone,true);
 }finally{await f.db.close()}});
test('stale second lot refuses the whole batch, including the first lot and journal',async()=>{const f=await fixture();try{
 const ids=[await f.lot(),await f.lot('cucumber')].sort();const body=await f.request(ids,await Promise.all(ids.map(async id=>(await f.row(id)).ingredient_id==='cheese'?20:100)));
 await f.db.query('update fridge_items set qty_num=qty_num-1 where id=$1',[ids[1]]);
 const before=await f.row(ids[0]);await assert.rejects(()=>f.rpc('consume',body),/Lot changed/);assert.deepEqual(await f.row(ids[0]),before);
 assert.equal((await f.db.query('select count(*)::int n from dinner_events')).rows[0].n,0);
 }finally{await f.db.close()}});
test('failure after both lot updates rolls back inventory, stats and receipt',async()=>{const f=await fixture();try{
 const a=await f.lot(),b=await f.lot('cucumber');const body=await f.request([a,b],[20,100]);const id=randomUUID();
 await f.db.exec(`create function public.fail_dinner() returns trigger language plpgsql as $$begin raise exception 'injected receipt failure'; end$$;create trigger fail before insert on sf_private.dinner_operations for each row when(new.kind='consume') execute function public.fail_dinner();`);
 await assert.rejects(()=>f.rpc('consume',body,{id}),/injected/);assert.equal(Number((await f.row(a)).qty_num),500);assert.equal(Number((await f.row(b)).qty_num),500);
 assert.equal((await f.db.query('select count(*)::int n from dinner_events')).rows[0].n,0);assert.equal((await f.state()).stats,null);
 await f.db.exec('drop trigger fail on sf_private.dinner_operations');await f.rpc('consume',body,{id});assert.equal(Number((await f.row(a)).qty_num),480);
 }finally{await f.db.close()}});
test('undo refuses a subsequent change in any lot without restoring the other one',async()=>{const f=await fixture();try{
 const a=await f.lot(),b=await f.lot('cucumber'),id=randomUUID();await f.rpc('consume',await f.request([a,b],[20,100]),{id});
 await f.db.query("update fridge_items set name='Changed' where id=$1",[b]);await assert.rejects(()=>f.rpc('undo',{operation_id:id}),/cannot undo/);
 assert.equal(Number((await f.row(a)).qty_num),480);assert.equal((await f.row(b)).ingredient_id,null);assert.equal((await f.db.query('select count(*)::int n from dinner_events')).rows[0].n,1);
 }finally{await f.db.close()}});
test('family, actor, profile exclusion and stale profile snapshots are checked server-side',async()=>{const f=await fixture();try{
 const a=await f.lot();const body=await f.request([a],[20]);await assert.rejects(()=>f.rpc('consume',body,{as:stranger}),/access denied/);
 await assert.rejects(()=>f.rpc('snapshot',{}, {as:null,role:'anon'}),/permission denied/);
 await f.db.query("update family_profiles set excluded_foods=array['dairy'] where id=$1",[profileId]);await assert.rejects(()=>f.rpc('consume',body),/Profile changed/);
 await assert.rejects(()=>f.rpc('consume',{...body,profiles:[{...body.profiles[0],exclusions:['dairy']}]}),/excluded/);
 await f.db.query("update family_profiles set excluded_foods='{}' where id=$1",[profileId]);const id=randomUUID();await f.rpc('consume',body,{id});
 await assert.rejects(()=>f.rpc('undo',{operation_id:id},{as:other}),/Nothing to undo/);
 assert.equal(Number((await f.row(a)).qty_num),480);
 }finally{await f.db.close()}});
test('provenance, expiry, unit compatibility and actual limits cannot be bypassed',async()=>{const f=await fixture();try{
 const a=await f.add();const raw=await f.request([a],[20]);await assert.rejects(()=>f.rpc('consume',raw),/clarification/);
 await f.rpc('confirm_lot',{id:a,expected_version:0,ingredient_id:'cheese',qty_num:500,unit:'г',expires_on:'2000-01-01'});await assert.rejects(async()=>f.rpc('consume',await f.request([a],[20])),/clarification/);
 await f.rpc('confirm_lot',{id:a,expected_version:(await f.row(a)).dinner_version,ingredient_id:'cheese',qty_num:500,unit:'мл',expires_on:'2099-01-01'});await assert.rejects(async()=>f.rpc('consume',await f.request([a],[20])),/incompatible/);
 await f.rpc('confirm_lot',{id:a,expected_version:(await f.row(a)).dinner_version,ingredient_id:'cheese',qty_num:500,unit:'г',expires_on:'2099-01-01'});
 for(const n of [0,-1,31,NaN])await assert.rejects(async()=>f.rpc('consume',await f.request([a],[n])));
 }finally{await f.db.close()}});
test('weekly 20 g cheese leaves 190 g shopping; scope replacement retains manual purchases',async()=>{const f=await fixture();try{
 await f.lot('cheese',20);await f.lot('cucumber',2000);await f.rpc('add_cart',{}).catch(()=>{});
 await f.rpc('shopping',{profiles:f.profiles,meals:f.meals(7),desired:{cheese:190000},scope_id:'week'});
 let carts=(await f.state()).cart_items;assert.equal(carts.length,1);assert.equal(Number(carts[0].qty_num),190);assert.equal(carts[0].unit,'г');
 await f.db.query("insert into cart_items(user_id,household_id,name,qty_num,unit) values($1,$2,'Manual',1,'шт')",[user,household]);
 const body={profiles:f.profiles,meals:f.meals(7,2),desired:{cheese:400000,cucumber:100000},scope_id:'week',expected_scope_revision:1},id=randomUUID();
 await f.rpc('shopping',body,{id});await f.rpc('shopping',body,{id});carts=(await f.state()).cart_items;assert.equal(carts.length,3);assert.ok(carts.some(c=>c.name==='Manual'));
 assert.equal(Number(carts.find(c=>c.ingredient_id==='cheese').qty_num),400);
 }finally{await f.db.close()}});
test('shopping rechecks exact deficits and refuses uncertain lots without removing the old scope',async()=>{const f=await fixture();try{
 const a=await f.lot('cheese',20);await f.lot('cucumber',500);
 const body={profiles:f.profiles,meals:f.meals(),desired:{cheese:10000},scope_id:'today'};await f.rpc('shopping',body);
 await f.db.query('update fridge_items set qty_num=25 where id=$1',[a]);await assert.rejects(()=>f.rpc('shopping',{...body,expected_scope_revision:1}),/demand changed/);
 await f.add();await assert.rejects(()=>f.rpc('shopping',{...body,expected_scope_revision:1,desired:{cheese:5000}}),/clarification/);assert.equal((await f.state()).cart_items.length,1);
 }finally{await f.db.close()}});
test('dinner purchase is atomic, retry-safe, retains ingredient and user-confirmed date',async()=>{const f=await fixture();try{
 await f.lot('cucumber',500);await f.rpc('shopping',{profiles:f.profiles,meals:f.meals(),desired:{cheese:30000},scope_id:'today'});
 const cart=(await f.state()).cart_items[0],body={id:cart.id,expected:cart,expires_on:'2099-01-01'},id=randomUUID();await f.rpc('buy',body,{id});await f.rpc('buy',body,{id});
 const saved=await f.row(id);assert.equal(saved.ingredient_id,'cheese');assert.equal(saved.quantity_source,'user');assert.equal(saved.date_source,'user');assert.equal((await f.state()).cart_items.length,0);
 await f.rpc('consume',await f.request([id],[30]));assert.equal(Number((await f.row(id)).qty_num),0);
 }finally{await f.db.close()}});
test('non-mass ingredients never become invented kilograms; event journal is not directly writable',async()=>{const f=await fixture();try{
 const egg=await f.lot('egg',10,'шт'),cuc=await f.lot('cucumber',500);const body=await f.request([egg,cuc],[2,100]);body.meals[0].recipe_id='egg-cucumber';await f.rpc('consume',body);
 assert.equal(Number((await f.state()).stats.used_weight_kg),0.1);
 await assert.rejects(()=>f.db.transaction(async tx=>{await tx.exec('set local role authenticated');await tx.query('delete from dinner_events')}),/permission denied/);
 }finally{await f.db.close()}});
test('stale shopping revision cannot overwrite a newer generated contribution',async()=>{const f=await fixture();try{
 await f.lot('cucumber',500);const body={profiles:f.profiles,meals:f.meals(),desired:{cheese:30000},scope_id:'scope'};
 await f.rpc('shopping',body);await assert.rejects(()=>f.rpc('shopping',body),/plan changed/);
 assert.equal((await f.state()).demand_versions.scope,1);assert.equal((await f.state()).cart_items.length,1);
 }finally{await f.db.close()}});
test('invalid legacy numeric stock is never available to the server calculation',async()=>{const f=await fixture();try{
 const a=await f.lot('cheese'),b=await f.lot('cucumber');
 for(const value of ['NaN','Infinity','-1','1.0001']){
  await f.db.query('update fridge_items set qty_num=$1::numeric where id=$2',[value,a]);
  await assert.rejects(async()=>f.rpc('consume',await f.request([a,b],[1,100])),/clarification/);
  await assert.rejects(()=>f.rpc('shopping',{profiles:f.profiles,meals:f.meals(),desired:{cheese:30000},scope_id:'invalid'}),/clarification/);
 }
 }finally{await f.db.close()}});
test('failed purchase delete rolls back its new lot and remains safely repeatable',async()=>{const f=await fixture();try{
 await f.lot('cucumber',500);await f.rpc('shopping',{profiles:f.profiles,meals:f.meals(),desired:{cheese:30000},scope_id:'purchase-failure'});
 const cart=(await f.state()).cart_items[0],id=randomUUID(),body={id:cart.id,expected:cart,expires_on:'2099-01-01'};
 await f.db.exec(`create function public.fail_purchase() returns trigger language plpgsql as $$begin raise exception 'injected cart delete';end$$;create trigger fail before delete on public.cart_items for each row execute function public.fail_purchase();`);
 await assert.rejects(()=>f.rpc('buy',body,{id}),/injected/);assert.equal(await f.row(id),undefined);assert.equal((await f.state()).cart_items.length,1);
 await f.db.exec('drop trigger fail on public.cart_items');await f.rpc('buy',body,{id});assert.ok(await f.row(id));assert.equal((await f.state()).cart_items.length,0);
 }finally{await f.db.close()}});
test('provenance confirmation cannot overwrite a newer lot snapshot',async()=>{const f=await fixture();try{
 const id=await f.lot('cheese',500),version=(await f.row(id)).dinner_version;
 await f.db.query('update fridge_items set qty_num=300 where id=$1',[id]);
 await assert.rejects(()=>f.rpc('confirm_lot',{id,expected_version:version,ingredient_id:'cheese',qty_num:500,unit:'г',expires_on:'2099-01-01'}),/Lot changed/);
 assert.equal(Number((await f.row(id)).qty_num),300);
 }finally{await f.db.close()}});
test('dinner defaults off and obeys both its feature gate and global production write pause',async()=>{
 const off=await createStockDb();try{assert.equal((await off.db.query('select enabled from sf_private.dinner_release_control')).rows[0].enabled,false);}finally{await off.db.close()}
 const f=await fixture();try{const a=await f.lot(),body=await f.request([a],[20]),id=randomUUID();
 await f.db.exec('update sf_private.dinner_release_control set enabled=false');await assert.rejects(()=>f.rpc('consume',body,{id}),e=>e.code==='55000');assert.equal(Number((await f.row(a)).qty_num),500);
 await f.db.exec('update sf_private.dinner_release_control set enabled=true;update sf_private.stock_release_control set enabled=false');await assert.rejects(()=>f.rpc('consume',body,{id}),e=>e.code==='55000');assert.equal(Number((await f.row(a)).qty_num),500);
 await f.db.exec('update sf_private.stock_release_control set enabled=true');await f.rpc('consume',body,{id});await f.rpc('consume',body,{id});assert.equal(Number((await f.row(a)).qty_num),480);
 }finally{await f.db.close()}
});
test('unsupported lot can be explicitly excluded and restored without falsifying quantity or provenance',async()=>{const f=await fixture();try{
 const id=await f.add(),before=await f.row(id);await f.lot('cucumber',500);
 await assert.rejects(()=>f.rpc('shopping',{profiles:f.profiles,meals:f.meals(),desired:{cheese:30000},scope_id:'unsupported'}),/clarification/);
 await f.rpc('exclude_lot',{id,expected_version:before.dinner_version,excluded:true});const after=await f.row(id);
 assert.equal(after.qty_num,before.qty_num);assert.equal(after.quantity_source,'legacy_unknown');assert.equal(after.ingredient_id,null);
 await f.rpc('shopping',{profiles:f.profiles,meals:f.meals(),desired:{cheese:30000},scope_id:'unsupported'});
 await f.rpc('exclude_lot',{id,expected_version:after.dinner_version,excluded:false});assert.equal((await f.row(id)).dinner_excluded,false);
 }finally{await f.db.close()}});
test('private profile output is owner-only and minimal; privacy hold never exposes legacy rows',async()=>{const f=await fixture();try{
 await f.db.query(`insert into family_profiles(id,household_id,created_by,name,sex,age,height_cm,start_weight_kg) values('30000000-0000-4000-8000-000000000099',$1,$2,'Unclaimed secret','male',30,170,70)`,[household,user]);
 const own=(await f.state()).profiles;assert.equal(own.length,1);assert.equal(own[0].id,profileId);
 for(const key of ['weight','start_weight_kg','height_cm','age','sex','baby_age_months','target_weight_kg'])assert.equal(key in own[0],false);
 assert.deepEqual((await f.rpc('snapshot',{}, {as:other})).profiles,[]);
 const id=await f.lot(),body=await f.request([id],[20]);await assert.rejects(()=>f.rpc('consume',body,{as:other}),/Profile unavailable/);
 await f.db.exec("alter table family_profiles drop constraint family_profiles_excluded_foods_check");await f.db.query("update family_profiles set excluded_foods=array['sesame'] where id=$1",[profileId]);await assert.rejects(()=>f.rpc('consume',{...body,profiles:[{...f.profiles[0],exclusions:['sesame']}]}),/Unknown profile restrictions/);await f.db.query("update family_profiles set excluded_foods='{}' where id=$1",[profileId]);
 await f.db.exec('update sf_private.dinner_release_control set profile_privacy_accepted=false');assert.deepEqual((await f.state()).profiles,[]);assert.equal((await f.state()).profile_access_ready,false);
 await assert.rejects(()=>f.rpc('consume',body),/not accepted/);assert.equal(Number((await f.row(id)).qty_num),500);
 }finally{await f.db.close()}});
test('authenticated anonymous accounts cannot enter the dinner personal-data path',async()=>{const f=await fixture();try{
 await f.db.query('update auth.users set is_anonymous=true where id=$1',[user]);
 await assert.rejects(()=>f.state(),e=>e.code==='42501');
 }finally{await f.db.close()}});
test('redacted operation resolution acknowledges commit or atomically cancels a late original write',async()=>{const f=await fixture();try{
 const id=await f.lot(),body=await f.request([id],[20]),cancelled=randomUUID();const r=await f.rpc('resolve',{}, {id:cancelled});assert.equal(r.operation_state,'cancelled');
 await assert.rejects(()=>f.rpc('consume',body,{id:cancelled}),/already used/);assert.equal(Number((await f.row(id)).qty_num),500);
 const committed=randomUUID();await f.rpc('consume',body,{id:committed});const saved=await f.rpc('resolve',{}, {id:committed});assert.equal(saved.operation_state,'saved');assert.equal(saved.resolved_kind,'consume');assert.equal(Number((await f.row(id)).qty_num),480);
 await assert.rejects(()=>f.rpc('resolve',{}, {id:committed,as:other}),e=>e.code==='42501');
 }finally{await f.db.close()}});
