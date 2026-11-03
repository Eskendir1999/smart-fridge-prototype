// Isolated review of the supplied SQL candidate. This does not authorize its deployment.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
module.exports=async({pool,root,client,user,other,stranger,household,check})=>{
 for(const file of ['supabase-diet-mode-migration.sql','supabase-dietitian-migration.sql'])await pool.query(fs.readFileSync(path.join(root,file),'utf8'));
 // Reproduce production's broad old grants before testing the candidate revocations.
 await pool.query('grant all on family_profiles,family_measurements,dietitian_messages,dietitian_summaries to anon,authenticated');
 const legacy=randomUUID(),profile=randomUUID(),measurement=randomUUID();
 await pool.query("insert into family_profiles(id,household_id,created_by,name,sex,age,height_cm,start_weight_kg) values($1,$2,$3,'Synthetic unclaimed','male',30,170,70)",[legacy,household,user]);
 const before=(await pool.query('select to_jsonb(p) as row from family_profiles p where id=$1',[legacy])).rows[0].row;
 await pool.query(fs.readFileSync(path.join(root,'review/profile-privacy.sql'),'utf8'));
 const after=(await pool.query("select to_jsonb(p)-'profile_owner_user_id' as row,profile_owner_user_id from family_profiles p where id=$1",[legacy])).rows[0];
 assert.deepEqual(after.row,before);assert.equal(after.profile_owner_user_id,null);
 check('REVIEW SQL: legacy data preserved; created_by is never inferred as owner');
 await pool.query("notify pgrst,'reload schema'");
 const a=client(user),b=client(other),c=client(stranger);
 const must=async promise=>{const r=await promise;if(r.error)throw Error(JSON.stringify(r.error));return r.data;};
 // SELECT can reach a newly added column before PostgREST refreshes its INSERT metadata.
 // Poll only the known pre-execution schema-cache miss, reusing one synthetic ID.
 let ready=false;
 for(let n=0;n<80;n++){
  const r=await a.from('family_profiles').insert({id:profile,household_id:household,created_by:user,profile_owner_user_id:user,name:'Synthetic confirmed owner',sex:'male',age:30,height_cm:170,start_weight_kg:70}).select('id').single();
  if(!r.error){ready=true;break;}
  assert.equal(r.error.code,'PGRST204',JSON.stringify(r.error));await new Promise(r=>setTimeout(r,50));
 }
 assert.ok(ready,'review INSERT schema cache reload');
 await must(a.from('family_measurements').insert({id:measurement,profile_id:profile,log_date:'2026-11-03',weight:70}).select('id').single());
 assert.equal((await must(a.from('family_profiles').select('id'))).length,1);
 assert.equal((await must(a.from('family_measurements').select('id'))).length,1);
 for(const actor of [b,c]){
  assert.deepEqual(await must(actor.from('family_profiles').select('id')),[]);
  assert.deepEqual(await must(actor.from('family_measurements').select('id')),[]);
  assert.deepEqual(await must(actor.from('family_profiles').update({name:'must not write'}).eq('id',profile).select('id')),[]);
  assert.deepEqual(await must(actor.from('family_measurements').delete().eq('id',measurement).select('id')),[]);
 }
 check('REVIEW HTTP: same-family B and another family cannot read/update/delete A profile or measurements');
 assert.equal((await a.from('family_profiles').update({profile_owner_user_id:other}).eq('id',profile)).error.code,'42501');
 assert.equal((await b.from('family_measurements').insert({profile_id:profile,log_date:'2026-11-04',weight:60})).error.code,'42501');
 assert.deepEqual(await must(a.from('family_profiles').update({profile_owner_user_id:user}).eq('id',legacy).select('id')),[]);
 check('REVIEW HTTP: reassignment, foreign measurement insert and creator claim of unowned legacy profile are denied');
 for(const table of ['dietitian_messages','dietitian_summaries']){
  assert.equal((await a.from(table).select('*')).error.code,'42501');
  assert.equal((await a.from(table).delete().eq('user_id',user)).error.code,'42501');
 }
 check('REVIEW HTTP: legacy AI archive is closed; owner export/delete remains a release blocker');
 const saved=await must(a.from('family_profiles').update({name:'Synthetic corrected'}).eq('id',profile).select('id').single());assert.equal(saved.id,profile);
 assert.equal((await must(a.from('family_profiles').delete().eq('id',profile).select('id'))).length,1);
 assert.equal((await pool.query('select count(*)::int n from family_measurements where profile_id=$1',[profile])).rows[0].n,0);
 assert.deepEqual(await must(a.from('family_profiles').delete().eq('id',profile).select('id')),[]);
 check('REVIEW HTTP: owner deletion confirms one row, cascades measurements, and repeated delete confirms no row');
 // Known candidate gap: an authenticated anonymous account is not explicitly denied.
 const guest=randomUUID();await pool.query('insert into auth.users values($1)',[guest]);
 const tx=await pool.connect();try{
  await tx.query('begin');await tx.query('set local role authenticated');
  await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[guest,JSON.stringify({sub:guest,role:'authenticated',is_anonymous:true})]);
  await tx.query("insert into family_profiles(created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg) values($1,$1,'Synthetic guest diagnostic','male',30,170,70)",[guest]);
 }finally{await tx.query('rollback');tx.release();}
 const blockers=['SQL candidate permits authenticated anonymous profile creation; add a verified permanent-account predicate before deployment.','Legacy AI owner export/delete, account lifecycle, owner confirmation and retention are not supplied.'];
 console.log('BLOCKED REVIEW: '+blockers.join(' '));
 return {candidateOnly:true,productionMigration:false,blockers};
};
