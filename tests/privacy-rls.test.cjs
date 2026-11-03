const test=require('node:test'),assert=require('node:assert/strict');
const {createMyDataDb,user,other,stranger,household,A,legacy}=require('./helpers/my-data-db.cjs');
let f;
async function as(actor,sql,args=[],role='authenticated',claims={}){
 return f.db.transaction(async tx=>{await tx.exec(`set local role ${role}`);await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor||'']);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor,session_id:actor,...claims})]);return tx.query(sql,args);});
}
test.before(async()=>f=await createMyDataDb());test.after(async()=>f?.db.close());
test('same family and outsider cannot read another owner or unclaimed legacy profiles',async()=>{
 assert.deepEqual((await as(user,'select id from family_profiles')).rows.map(x=>x.id),[A]);
 for(const actor of [other,stranger])assert.equal((await as(actor,'select * from family_measurements where profile_id=$1',[A])).rows.length,0);
 assert.equal((await as(user,'select * from family_profiles where id=$1',[legacy])).rows.length,0);
});
test('permanent live session is required for all personal table reads',async()=>{
 assert.equal((await as(user,'select * from family_profiles',[],'authenticated',{is_anonymous:true})).rows.length,0);
 assert.equal((await as(user,'select * from measurement_logs',[],'authenticated',{session_id:null})).rows.length,0);
 await f.db.query('update auth.users set is_anonymous=true where id=$1',[user]);
 assert.equal((await as(user,'select * from family_measurements')).rows.length,0);
 await f.db.query('update auth.users set is_anonymous=false where id=$1',[user]);
});
test('all old-client direct writes and ownership claims are denied even for the owner',async()=>{
 for(const actor of [user,other]){
  await assert.rejects(as(actor,'update family_profiles set profile_owner_user_id=$1 where id=$2',[actor,legacy]),/permission denied/);
  for(const table of ['family_profiles','family_measurements','measurement_logs'])await assert.rejects(as(actor,'delete from '+table),/permission denied/);
 }
 // No extra parameters for real write checks.
 await assert.rejects(as(user,"insert into family_measurements(profile_id,log_date,weight) values($1,'2026-11-04',65)",[A]),/permission denied/);
 await assert.rejects(as(user,"update family_profiles set name='resurrect' where id=$1",[A]),/permission denied/);
});
test('anonymous reads, raw AI archives, technical receipts and maintenance are denied',async()=>{
 await assert.rejects(as(null,'select * from family_profiles',[],'anon'),/permission denied/);
 for(const table of ['dietitian_messages','dietitian_summaries','sf_private.data_deletion_receipts'])await assert.rejects(as(user,'select * from '+table),/permission denied/);
 await assert.rejects(as(user,'select sf_private.purge_expired_deletion_receipts()'),/permission denied/);
 for(const table of ['family_profiles','family_measurements','measurement_logs','dietitian_messages','dietitian_summaries'])for(const role of ['anon','authenticated']){
  const p=(await f.db.query("select has_table_privilege($1,$2,'TRUNCATE,TRIGGER,REFERENCES,INSERT,UPDATE,DELETE') allowed",[role,table])).rows[0];assert.equal(p.allowed,false);
 }
});
test('leaving/deleting household and original creator does not destroy another owner private history',async()=>{
 await f.db.query('delete from household_members where user_id=$1',[user]);
 assert.equal((await as(user,'select * from family_profiles')).rows.length,1);
 await f.db.query('delete from households where id=$1',[household]);
 assert.equal((await as(user,'select * from family_profiles')).rows[0].household_id,null);
 assert.equal((await as(user,'select * from family_measurements')).rows.length,1);
 await f.db.query('delete from auth.users where id=$1',[user]);
 // B was created by A in the fixture, but belongs to B.
 assert.equal((await as(other,'select * from family_profiles')).rows.length,1);
 assert.equal((await as(other,'select * from family_profiles')).rows[0].created_by,null);
 assert.equal((await as(other,'select * from family_measurements')).rows.length,1);
});
