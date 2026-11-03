// Full production migration, real signed JWT/PostgREST/native PostgreSQL.
// Managed Auth issuance is tested separately against Supabase before release.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
module.exports=async({pool,client,user,other,stranger,household,check})=>{
 const A=randomUUID(),B=randomUUID(),legacy=randomUUID();
 for(const [id,owner,name] of [[A,user,'HTTP OWNER'],[B,other,'HTTP OTHER'],[legacy,null,'UNCLAIMED']]){
  await pool.query("insert into family_profiles(id,household_id,created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg) values($1,$2,$3,$4,$5,'male',30,170,70)",[id,household,user,owner,name]);
  await pool.query("insert into family_measurements(profile_id,log_date,weight) values($1,'2026-11-03',70)",[id]);
 }
 for(const actor of [user,other]){
  await pool.query("insert into dietitian_messages(user_id,role,content) values($1,'user','SYNTHETIC')",[actor]);
  await pool.query("insert into dietitian_summaries(user_id,week_start,summary) values($1,'2026-11-02','SYNTHETIC DERIVED')",[actor]);
  await pool.query("insert into measurement_logs(user_id,log_date,weight) values($1,'2026-11-03',70)",[actor]);
 }
 const a=client(user),b=client(other),c=client(stranger);
 const must=async promise=>{const r=await promise;if(r.error)throw Error(JSON.stringify(r.error));return r.data;};
 const data=(actor,args={})=>actor.rpc('sf_my_data',args);
 const ticket=async(scope,profile_id=null)=>{const t=await must(data(a,{action:'prepare_delete',scope,profile_id}));return {action:'delete',scope,profile_id,request_id:t.request_id};};
 assert.deepEqual((await must(data(a))).profiles.map(x=>x.id),[A]);
 assert.deepEqual((await must(data(b))).profiles.map(x=>x.id),[B]);
 assert.deepEqual((await must(data(c))).profiles,[]);
 for(const actor of [b,c])assert.deepEqual(await must(actor.from('family_measurements').select('*').eq('profile_id',A)),[]);
 for(const id of [B,legacy])assert.equal((await data(a,{action:'prepare_delete',scope:'profile',profile_id:id})).error?.code,'42501');
 check('MY DATA: same-family and foreign-family reads/export/delete respect confirmed owner; legacy stays unassigned');
 for(const actor of [a,b])for(const table of ['family_profiles','family_measurements','measurement_logs'])assert.equal((await actor.from(table).delete().neq('id',randomUUID())).error?.code,'42501');
 assert.equal((await a.from('family_profiles').update({profile_owner_user_id:user}).eq('id',legacy)).error?.code,'42501');
 for(const table of ['dietitian_messages','dietitian_summaries'])assert.equal((await a.from(table).select('*')).error?.code,'42501');
 check('MY DATA: direct old-client writes, owner claims and raw AI archive endpoints are denied');
 const args=await ticket('measurements',A);
 // Hold the actor lock until two actual API sessions are waiting on it.
 const lock=await pool.connect();let rs;
 try{
  await lock.query('begin');await lock.query("select pg_advisory_xact_lock(hashtextextended('my-data:'||$1::text,0))",[user]);
  const pending=[data(a,args),data(a,args)].map(x=>Promise.resolve(x));let seen=false;
  for(let n=0;n<100;n++){
   const count=(await pool.query("select count(*)::int n from pg_locks l join pg_stat_activity s on s.pid=l.pid where l.locktype='advisory' and not l.granted and s.usename='sf_api_test'")).rows[0].n;
   if(count>=2){seen=true;break;}await new Promise(r=>setTimeout(r,30));
  }
  await lock.query('commit');rs=await Promise.all(pending);assert.ok(seen,'two API backend sessions must overlap');
 }finally{await lock.query('rollback');lock.release();}
 assert.ok(rs.every(r=>!r.error));assert.deepEqual(rs[0].data,rs[1].data);assert.equal(rs[0].data.removed,1);
 assert.equal((await data(b,args)).error?.code,'22023');
 await pool.query("insert into family_measurements(profile_id,log_date,weight) values($1,'2026-11-04',71)",[A]);
 assert.deepEqual(await must(data(a,args)),rs[0].data);assert.equal((await must(data(a))).measurements.length,1);
 check('MY DATA: concurrent deletion and replay execute once, cannot delete later data or replay another actor ticket');
 await pool.query("update sf_private.data_deletion_receipts set created_at=created_at-interval '91 days',expires_at=expires_at-interval '91 days' where request_id=$1",[args.request_id]);
 assert.equal((await data(a,args)).error?.code,'22023');
 await pool.query('select sf_private.purge_expired_deletion_receipts()');
 assert.equal((await data(a,args)).error?.code,'22023');assert.equal((await must(data(a))).measurements.length,1);
 check('MY DATA: expired and physically purged 90-day tickets are rejected without deleting new data');
 const ai=await ticket('legacy_ai');
 await pool.query("create function public.fixture_reject_summary() returns trigger language plpgsql as $$begin raise exception 'fixture failure';end;$$;create trigger fixture_fail before delete on dietitian_summaries for each row execute function public.fixture_reject_summary()");
 assert.equal((await data(a,ai)).error?.code,'P0001');assert.equal((await must(data(a))).legacy_messages.length,1);
 assert.equal((await pool.query('select result from sf_private.data_deletion_receipts where request_id=$1',[ai.request_id])).rows[0].result,null);
 await pool.query('drop trigger fixture_fail on dietitian_summaries;drop function public.fixture_reject_summary()');
 await must(data(a,ai));assert.equal((await must(data(a))).legacy_summaries.length,0);assert.equal((await must(data(b))).legacy_messages.length,1);
 check('MY DATA: failed derived-data deletion rolls back originals and completion; retry removes only owner archive');
 const profile=await ticket('profile',A);await must(data(a,profile));assert.deepEqual((await must(data(a))).profiles,[]);assert.equal((await pool.query('select count(*)::int n from family_measurements where profile_id=$1',[A])).rows[0].n,0);
 await pool.query('delete from auth.sessions where id=$1',[user]);
 assert.equal((await data(a)).error?.code,'42501');assert.equal((await data(a,profile)).error?.code,'42501');
 assert.deepEqual(await must(a.from('measurement_logs').select('*')),[]);
 await pool.query('insert into auth.sessions(id,user_id) values($1,$1)',[user]);
 await pool.query('update auth.users set is_anonymous=true where id=$1',[user]);assert.equal((await data(a)).error?.code,'42501');
 await pool.query('update auth.users set is_anonymous=false where id=$1',[user]);
 check('MY DATA: profile cascade succeeds; revoked session and actual anonymous account fail despite valid signed JWT');
 return {productionMigration:true,managedAuthIssuance:'separate acceptance',ownerIsolation:true,retentionDays:90};
};
