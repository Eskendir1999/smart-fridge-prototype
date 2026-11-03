const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');const {PGlite}=require('@electric-sql/pglite');
const {createStockDb,user,other,stranger,household,otherHousehold}=require('./helpers/stock-db.cjs');
const candidate=fs.readFileSync(path.join(__dirname,'../review/dinner-my-data.sql'),'utf8');let engine;
test.before(async()=>{engine=await PGlite.create()});test.after(async()=>engine?.close());
async function fixture(){
 await engine.exec('drop schema public cascade;drop schema if exists sf_private cascade;drop schema if exists auth cascade;create schema public');
 const database={exec:(...a)=>engine.exec(...a),query:(...a)=>engine.query(...a),transaction:fn=>engine.transaction(fn)};
 const f=await createStockDb({database,enableDinner:true});await engine.exec(candidate);
 const profile=randomUUID();await engine.query("insert into family_profiles(id,household_id,created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg) values($1,$2,$3,$3,'Private owner','male',30,170,70)",[profile,household,user]);
 const as=(actor,sql,args=[],role='authenticated')=>engine.transaction(async tx=>{await tx.exec('set local role '+role);await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor||'']);return tx.query(sql,args)});
 const rpc=(kind,body={},id=randomUUID(),actor=user)=>as(actor,'select public.dinner_mutate($1,$2,$3,$4::jsonb) r',[id,household,kind,JSON.stringify(body)]).then(r=>r.rows[0].r);
 const exportData=actor=>as(actor||user,'select public.sf_dinner_my_data() r').then(r=>r.rows[0].r);
 const erase=actor=>as(actor||user,'delete from family_profiles where id=$1 returning id',[profile]);
 const a=await f.add(),b=await f.add();for(const [id,ingredient_id]of [[a,'cheese'],[b,'cucumber']])await rpc('confirm_lot',{id,expected_version:0,ingredient_id,qty_num:500,unit:'г',expires_on:'2099-01-01'});
 const today=(await rpc('snapshot')).today;
 const body={profiles:[{id:profile,mode:'standard',exclusions:[]}],meals:[{id:'d0',recipe_id:'cheese-cucumber',recipe_version:1,day:today,portions:1}],deltas:[{id:a,expected_version:1,amount:20},{id:b,expected_version:1,amount:100}]};
 const id=randomUUID();await rpc('consume',body,id);
 return {...f,as,rpc,exportData,erase,profile,body,id,a,b};
}
test('review export returns only own dinner actions, with no shared-row creator metadata',async()=>{
 const f=await fixture();const otherOp=randomUUID();await engine.query("insert into sf_private.dinner_operations(id,household_id,user_id,kind,payload) values($1,$2,$3,'shopping',$4)",[otherOp,household,other,JSON.stringify({profiles:[{id:'OTHER PRIVATE',exclusions:['nuts']}]})]);
 const data=await f.exportData();assert.equal(data.version,1);assert.equal(data.operations.length,3);assert.equal(data.events.length,1);
 const own=data.operations.find(o=>o.id===f.id);assert.deepEqual(own.profiles,f.body.profiles);assert.equal(own.meals[0].recipe_id,'cheese-cucumber');assert.equal(own.lot_changes.length,2);
 for(const field of ['before_lots','after_lots','created_by','household_id','user_id','OTHER PRIVATE'])assert.ok(!JSON.stringify(data).includes(field));
 const b=await f.exportData(other);assert.equal(b.operations.length,1);assert.equal(b.operations[0].id,otherOp);assert.equal(b.events.length,0);assert.equal((await f.exportData(stranger)).operations.length,0);
});
test('own export works after household departure without returning former members profiles',async()=>{
 const f=await fixture();await engine.query('update household_members set household_id=$1 where user_id=$2',[otherHousehold,user]);
 assert.ok((await f.exportData()).operations.some(o=>o.id===f.id));await assert.rejects(f.rpc('snapshot'),/access denied/);
});
test('anonymous Auth and deleted account tokens cannot export even with authenticated role',async()=>{
 const f=await fixture();await assert.rejects(f.as(null,'select public.sf_dinner_my_data()',[],'anon'),/permission denied/);
 await engine.exec('alter table auth.users add column is_anonymous boolean not null default false');await engine.query('update auth.users set is_anonymous=true where id=$1',[user]);
 await assert.rejects(f.exportData(),/Permanent account required/);await engine.query('update auth.users set is_anonymous=false where id=$1',[user]);
 await engine.query('delete from auth.users where id=$1',[stranger]);await assert.rejects(f.exportData(stranger),/Permanent account required/);
});
test('confirmed profile deletion scrubs its private request body and preserves inventory, event and replay tombstone',async()=>{
 const f=await fixture();assert.equal((await f.erase(other)).rows.length,0);assert.equal((await f.erase()).rows.length,1);
 const receipt=(await engine.query('select * from sf_private.dinner_operations where id=$1',[f.id])).rows[0];assert.deepEqual(receipt.payload,{});assert.ok(receipt.profile_context_erased_at);assert.equal(receipt.before_lots.length,2);
 assert.equal((await f.exportData()).operations.find(o=>o.id===f.id).profiles.length,0);assert.ok(!JSON.stringify(await f.exportData()).includes(f.profile));
 await assert.rejects(f.rpc('consume',f.body,f.id),/already used/);const resolved=await f.rpc('resolve',{},f.id);assert.equal(resolved.operation_state,'saved');assert.equal(resolved.resolved_kind,'consume');
 assert.equal(Number((await engine.query('select qty_num from fridge_items where id=$1',[f.a])).rows[0].qty_num),480);assert.equal((await engine.query('select count(*)::int n from dinner_events')).rows[0].n,1);
 await assert.rejects(f.rpc('consume',f.body),/Profile unavailable/);await f.rpc('undo',{operation_id:f.id});assert.equal(Number((await engine.query('select qty_num from fridge_items where id=$1',[f.a])).rows[0].qty_num),500);
 assert.equal((await engine.query('select count(*)::int n from dinner_events')).rows[0].n,2);
});
test('profile deletion does not erase unrelated own profile or another actors receipt',async()=>{
 const f=await fixture();const otherProfile=randomUUID(),otherOp=randomUUID(),ownOther=randomUUID();
 for(const [id,actor,profileId]of [[otherOp,other,f.profile],[ownOther,user,otherProfile]])await engine.query("insert into sf_private.dinner_operations(id,household_id,user_id,kind,payload) values($1,$2,$3,'shopping',$4)",[id,household,actor,JSON.stringify({profiles:[{id:profileId,exclusions:['egg']}]})]);
 await f.erase();for(const id of [otherOp,ownOther])assert.equal((await engine.query('select payload from sf_private.dinner_operations where id=$1',[id])).rows[0].payload.profiles[0].exclusions[0],'egg');
});
test('failed cleanup rolls back profile deletion and leaves original receipt recoverable',async()=>{
 const f=await fixture();await engine.exec("create function public.fail_cleanup() returns trigger language plpgsql as $$begin raise exception 'cleanup failure';end$$;create trigger fail_cleanup before update on sf_private.dinner_operations for each row when(new.profile_context_erased_at is not null) execute function public.fail_cleanup()");
 await assert.rejects(f.erase(),/cleanup failure/);assert.equal((await engine.query('select id from family_profiles where id=$1',[f.profile])).rows.length,1);assert.deepEqual((await engine.query('select payload from sf_private.dinner_operations where id=$1',[f.id])).rows[0].payload,f.body);
});
test('clients cannot bypass cleanup through direct receipts or privileged trigger invocation',async()=>{
 const f=await fixture();for(const sql of ['select * from sf_private.dinner_operations','update sf_private.dinner_operations set payload=\'{}\'','select sf_private.dinner_forget_deleted_profile()'])await assert.rejects(f.as(user,sql),/permission denied/);
 assert.equal((await f.erase()).rows.length,1);assert.equal((await f.erase()).rows.length,0);
});
