'use strict';
// Isolated CI database only. Never reads production env names.
const assert=require('node:assert/strict');const {Pool}=require('pg');
const {readFile}=require('node:fs/promises');const {join}=require('node:path');
const {createTransaction}=require('../pilot/postgres.cjs');const {createCollector}=require('../pilot/collector.cjs');
async function main(){
 const url=new URL(process.env.SF_PILOT_TEST_DATABASE_URL||'');
 assert.ok(['localhost','127.0.0.1'].includes(url.hostname));assert.equal(url.pathname,'/sf_pilot_test_ci');
 const pool=new Pool({connectionString:url.href,max:8,application_name:'sf-pilot-acceptance'});
 let blocker;
 try{
  await pool.query(await readFile(join(__dirname,'../pilot/sql/storage.sql'),'utf8'));
  const pilotId='SYN-'+Date.now();
  const grant={pilotId,userId:'u1',householdCode:'H1',actorCode:'A',member:true,pilotActive:true,gatesAccepted:true,consent:true,expiresAt:2000,builds:['SYNTHETIC'],currentDay:8};
  await pool.query('INSERT INTO sf_pilot_private.pilots(pilot_id,grants) VALUES ($1,$2)',[pilotId,JSON.stringify({u1:grant})]);
  const transaction=createTransaction({pool,readReceipt:async()=>null,verifyReadback:async()=>null});
  const service=createCollector({authenticate:async()=>({id:'u1'}),transaction,now:()=>1000,testMode:true});
  const batch=id=>({pilot_id:pilotId,stream_id:'S'+id,events:[{schema_version:'1.2',event_id:'E'+id,pilot_id:pilotId,household_code:'H1',actor_code:'A',attempt_id:'A'+id,day_index:8,build_sha:'SYNTHETIC',seq:1,source:'client',event:'attempt_started',data:{origin:'natural',phase:'product'}}]});
  const state=async()=>(await pool.query('SELECT state FROM sf_pilot_private.pilots WHERE pilot_id=$1',[pilotId])).rows[0].state;
  await Promise.all(Array.from({length:6},()=>service.ingest('fixture',batch(1))));
  assert.equal((await state()).events.length,1);console.log('PASS six concurrent retries: one event');
  await Promise.all([2,3,4].map(id=>service.ingest('fixture',batch(id))));
  assert.deepEqual((await state()).events.map(x=>x.event.seq),[1,2,3,4]);console.log('PASS concurrent streams: no lost updates, unique order');
  const broken=batch(5);broken.events.push({...batch(1).events[0],event_id:'Ebroken',seq:2});
  await assert.rejects(service.ingest('fixture',broken),/ATTEMPT_ALREADY_STARTED/);
  assert.equal((await state()).events.length,4);console.log('PASS whole batch rollback');
  // Hold actual row lock, queue ingestion, prove it is waiting via pg_stat_activity.
  blocker=await pool.connect();await blocker.query('BEGIN');
  await blocker.query('SELECT 1 FROM sf_pilot_private.pilots WHERE pilot_id=$1 FOR UPDATE',[pilotId]);
  const pending=service.ingest('fixture',batch(6)).then(()=>({ok:true}),e=>({error:e}));
  let waiting=false;
  for(let i=0;i<100;i++){
   const r=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='sf-pilot-acceptance' AND wait_event_type='Lock'");
   if(r.rows[0].n>0){waiting=true;break;}await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(waiting,true,'ingest must actually wait on server lock');
  grant.consent=false;await blocker.query('UPDATE sf_pilot_private.pilots SET grants=$2 WHERE pilot_id=$1',[pilotId,JSON.stringify({u1:grant})]);
  await blocker.query('COMMIT');blocker.release();blocker=null;
  assert.match((await pending).error?.message??'',/NOT_ADMITTED/);assert.equal((await state()).events.length,4);
  console.log('PASS queued ingest observes committed consent revocation');
  const fresh=new Pool({connectionString:url.href});try{assert.equal((await fresh.query('SELECT jsonb_array_length(state->\'events\') AS n FROM sf_pilot_private.pilots WHERE pilot_id=$1',[pilotId])).rows[0].n,4);}finally{await fresh.end();}
  console.log('PASS data visible through independent connection pool');
 }finally{if(blocker){await blocker.query('ROLLBACK');blocker.release();}await pool.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
