const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {createStockDb,user,other,stranger,household}=require('./helpers/stock-db.cjs');
let f;const profile='30000000-0000-4000-8000-000000000001';
const legacy='30000000-0000-4000-8000-000000000002';
const root=path.join(__dirname,'..');
async function as(actor,sql,args=[],role='authenticated'){
 return f.db.transaction(async tx=>{await tx.exec(`set local role ${role}`);await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor||'']);return tx.query(sql,args);});
}
test.before(async()=>{
 f=await createStockDb();
 for(const file of ['supabase-family-profiles-migration.sql','supabase-diet-mode-migration.sql','supabase-dietitian-migration.sql','review/profile-privacy.sql'])await f.db.exec(fs.readFileSync(path.join(root,file),'utf8'));
 await f.db.query(`insert into family_profiles(id,household_id,created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg) values($1,$2,$3,$3,'Owner','male',30,170,70),($4,$2,$3,null,'Unclaimed','female',25,165,65)`,[profile,household,user,legacy]);
 await f.db.query(`insert into family_measurements(profile_id,log_date,weight) values($1,'2026-11-03',70)`,[profile]);
});
test.after(async()=>f?.db.close());
test('owner reads own profile and measurements; same household and outsider see neither',async()=>{
 assert.equal((await as(user,'select * from family_profiles')).rows.length,1);
 assert.equal((await as(user,'select * from family_measurements')).rows.length,1);
 for(const actor of [other,stranger]){
  assert.equal((await as(actor,'select * from family_profiles')).rows.length,0);
  assert.equal((await as(actor,'select * from family_measurements')).rows.length,0);
  assert.equal((await as(actor,'update family_profiles set name=\'hacked\' where id=$1 returning id',[profile])).rows.length,0);
  assert.equal((await as(actor,'delete from family_measurements where profile_id=$1 returning id',[profile])).rows.length,0);
 }
});
test('legacy creator cannot claim an unowned profile through UPDATE',async()=>{
 assert.equal((await as(user,'update family_profiles set profile_owner_user_id=$1 where id=$2 returning id',[user,legacy])).rows.length,0);
});
test('ownership reassignment and foreign measurement inserts are denied',async()=>{
 await assert.rejects(as(user,'update family_profiles set profile_owner_user_id=$1 where id=$2',[other,profile]),/row-level security/);
 await assert.rejects(as(other,"insert into family_measurements(profile_id,log_date,weight) values($1,'2026-11-04',65)",[profile]),/row-level security/);
 await assert.rejects(as(user,"insert into family_profiles(household_id,created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg) values($1,$2,$3,'Other','male',30,170,70)",[household,user,other]),/row-level security/);
});
test('anonymous cannot read private tables and authenticated cannot read/write legacy AI',async()=>{
 await assert.rejects(as(null,'select * from family_profiles',[],'anon'),/permission denied/);
 for(const table of ['dietitian_messages','dietitian_summaries'])await assert.rejects(as(user,'select * from '+table),/permission denied/);
 await assert.rejects(as(user,"insert into dietitian_messages(user_id,role,content) values($1,'user','private')",[user]),/permission denied/);
});
test('owner update works and an adult profile cannot become a child profile',async()=>{
 assert.equal((await as(user,"update family_profiles set name='Mine' where id=$1 returning id",[profile])).rows.length,1);
 await assert.rejects(as(user,'update family_profiles set age=17 where id=$1',[profile]),/row-level security/);
});
test('leaving and deleting household does not delete private history or remove owner access',async()=>{
 await f.db.query('delete from household_members where user_id=$1',[user]);
 assert.equal((await as(user,'select * from family_profiles')).rows.length,1);
 await f.db.query('delete from households where id=$1',[household]);
 assert.equal((await as(user,'select * from family_profiles')).rows[0].household_id,null);
 assert.equal((await as(user,'select * from family_measurements')).rows.length,1);
});
test('confirmed owner deletion cascades to measurements',async()=>{
 assert.equal((await as(user,'delete from family_profiles where id=$1 returning id',[profile])).rows.length,1);
 assert.equal((await as(user,'select * from family_measurements')).rows.length,0);
});
