const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {createMyDataDb,user,other,stranger,A,B,legacy}=require('./helpers/my-data-db.cjs');
const {csv}=require('../personal-data/export.js');let f;
async function ticket(scope,profile_id=null,actor=user){const t=await f.data({action:'prepare_delete',scope,profile_id},actor);return {action:'delete',scope,profile_id,request_id:t.request_id};}
test.before(async()=>f=await createMyDataDb());test.after(async()=>f?.db.close());
test('export contains only owned profiles and own account archive, no family or unclaimed data',async()=>{
 const s=await f.data();assert.deepEqual(s.profiles.map(p=>p.id),[A]);assert.equal(s.measurements.length,1);assert.equal(s.legacy_measurements.length,1);assert.equal(s.legacy_messages[0].content,'OWNER ARCHIVE');assert.equal(s.legacy_summaries.length,1);assert.equal(s.ai.enabled,false);
 assert.doesNotMatch(JSON.stringify(s),/OTHER|UNCLAIMED|user_id|household_id|created_by/);
 const otherData=await f.data({},other);assert.deepEqual(otherData.profiles.map(p=>p.id),[B]);assert.deepEqual((await f.data({},stranger)).profiles,[]);
});
test('anonymous role, missing identity and anonymous sign-in are refused',async()=>{
 await assert.rejects(f.data({},null,'anon'),/permission denied/);await assert.rejects(f.data({},null),/authentication_required/);await assert.rejects(f.data({},user,'authenticated',true),/authentication_required/);
});
test('foreign or unclaimed deletion, arbitrary scope, supplied read selectors are refused',async()=>{
 for(const id of [B,legacy])await assert.rejects(f.data({action:'prepare_delete',profile_id:id,scope:'profile'}),/not_available/);
 await assert.rejects(f.data({action:'delete',scope:'fridge',request_id:randomUUID()}),/invalid_action/);
 await assert.rejects(f.data({profile_id:B}),/invalid_read_arguments/);
 assert.equal((await f.data({},other)).profiles.length,1);
});
test('CSV preserves null, Unicode, quotes/newlines and prevents spreadsheet formulas',()=>{
 const s=csv({profiles:[{id:'p',name:'=SUM(1,1)',note:'a,"б"\nв',empty:null,nested:['egg']}],exported_at:'now'});
 assert.match(s,/"'=SUM\(1,1\)"/);assert.ok(s.includes('"a,""б""\nв"'));assert.ok(s.includes('"empty",""'));assert.ok(s.startsWith('\uFEFF'));
 for(const text of ['+1','-1','@cmd','\t=1','   =1'])assert.ok(csv({profiles:[{name:text}]}).includes("'"+text));
});
test('clear measurements is repeatable with same receipt and does not touch profile or family inventory',async()=>{
 await f.add();const args=await ticket('measurements',A);
 const a=await f.data(args),b=await f.data(args);assert.deepEqual(a,b);assert.equal(a.removed,1);assert.equal((await f.data()).profiles.length,1);assert.equal((await f.data()).measurements.length,0);assert.equal((await f.db.query('select * from fridge_items')).rows.length,1);
 await assert.rejects(f.data({...args,scope:'profile'}),/request_id_reused/);
});
test('failure deleting a derived summary rolls back original deletion and receipt',async()=>{
 await f.db.exec("create function public.reject_summary_delete() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end; $$; create trigger reject_summary before delete on dietitian_summaries for each row execute function public.reject_summary_delete()");
 const args=await ticket('legacy_ai');
 await assert.rejects(f.data(args),/fixture failure/);
 assert.equal((await f.data()).legacy_messages.length,1);
 assert.equal((await f.db.query('select * from sf_private.data_deletion_receipts where request_id=$1',[args.request_id])).rows[0].result,null);
 await f.db.exec('drop trigger reject_summary on dietitian_summaries; drop function public.reject_summary_delete()');
});
test('legacy messages and derived summaries deleted together only for actor',async()=>{
 const args=await ticket('legacy_ai');const result=await f.data(args);assert.equal(result.removed,1);assert.equal(result.related_removed,1);assert.deepEqual(await f.data(args),result);
 const s=await f.data();assert.equal(s.legacy_messages.length,0);assert.equal(s.legacy_summaries.length,0);assert.equal((await f.data({},other)).legacy_messages.length,1);
});
test('90-day tickets reject expired and purged IDs without deleting newly added records',async()=>{
 const args=await ticket('legacy_measurements');await f.data(args);
 await f.db.query("insert into measurement_logs(user_id,log_date,weight) values($1,'2026-11-02',71)",[user]);
 await f.db.query("update sf_private.data_deletion_receipts set created_at=created_at-interval '91 days',expires_at=expires_at-interval '91 days' where request_id=$1",[args.request_id]);
 await assert.rejects(f.data(args),/request_expired_or_unknown/);
 assert.equal((await f.data()).legacy_measurements.length,1);
 assert.ok(Number((await f.db.query('select sf_private.purge_expired_deletion_receipts() n')).rows[0].n)>=1);
 await assert.rejects(f.data(args),/request_expired_or_unknown/);
 await assert.rejects(f.data({...args,request_id:randomUUID()}),/request_expired_or_unknown/);
 assert.equal((await f.data()).legacy_measurements.length,1);
 assert.equal((await f.data({},other)).legacy_measurements.length,1);
});
test('actual anonymous account and revoked/expired/wrong-user sessions fail despite permanent JWT claim',async()=>{
 await f.db.query('update auth.users set is_anonymous=true where id=$1',[user]);
 await assert.rejects(f.data(),/authentication_required/);
 await f.db.query('update auth.users set is_anonymous=false where id=$1',[user]);
 await f.db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1",[user]);
 await assert.rejects(f.data(),/authentication_required/);
 await f.db.query('update auth.sessions set not_after=null,user_id=$1 where id=$2',[other,user]);
 await assert.rejects(f.data(),/authentication_required/);
 await f.db.query('delete from auth.sessions where id=$1',[user]);
 await assert.rejects(f.data(),/authentication_required/);
 await f.db.query('insert into auth.sessions(id,user_id) values($1,$1)',[user]);
});
test('profile delete cascades, receipt survives response loss and does not expose another actors receipt',async()=>{
 const args=await ticket('profile',A);const result=await f.data(args);assert.equal(result.status,'active_database_deleted');assert.deepEqual(await f.data(args),result);assert.equal((await f.data()).profiles.length,0);await assert.rejects(f.data(args,other),/request_expired_or_unknown/);
});
test('client cannot forge receipts or read raw legacy archive',async()=>{
 await assert.rejects(f.db.transaction(async tx=>{await tx.exec('set local role authenticated');return tx.query('select * from sf_private.data_deletion_receipts')}),/permission denied/);
});
