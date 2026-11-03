'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {mkdtemp,rm,readFile}=require('node:fs/promises');const {tmpdir}=require('node:os');const {join}=require('node:path');
const {createTransaction}=require('../pilot/postgres.cjs');const {createCollector}=require('../pilot/collector.cjs');
test('SQL-backed collector: persistence, duplicate, rollback, consent and private access',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sf-pilot-'));let db=new PGlite(dir);let releases=0;
 try{
  await db.exec(await readFile(join(__dirname,'../pilot/sql/storage.sql'),'utf8'));
  const grant={pilotId:'SYN',userId:'u1',householdCode:'H1',actorCode:'A',member:true,pilotActive:true,gatesAccepted:true,consent:true,expiresAt:2000,builds:['SYNTHETIC'],currentDay:8};
  await db.query('INSERT INTO sf_pilot_private.pilots(pilot_id,grants) VALUES ($1,$2)', ['SYN',JSON.stringify({u1:grant})]);
  const pool={connect:async()=>({query:(...a)=>db.query(...a),release:()=>{releases++;}})};
  const transaction=createTransaction({pool,readReceipt:async()=>null,verifyReadback:async()=>null});
  const collector=createCollector({authenticate:async()=>({id:'u1'}),transaction,now:()=>1000,testMode:true});
  const event={schema_version:'1.2',event_id:'E1',pilot_id:'SYN',household_code:'H1',actor_code:'A',attempt_id:'A1',day_index:8,build_sha:'SYNTHETIC',seq:1,source:'client',event:'attempt_started',data:{origin:'natural',phase:'product'}};
  const batch={pilot_id:'SYN',stream_id:'S1',events:[event]};
  await collector.ingest('token',batch);assert.equal(releases,1);
  await db.close();db=new PGlite(dir);
  assert.equal((await collector.ingest('token',batch)).accepted[0].duplicate,true);
  const bad={...batch,events:[{...event,event_id:'E2',attempt_id:'A2',seq:2},{...event,event_id:'E3',attempt_id:'A1',seq:3}]};
  await assert.rejects(collector.ingest('token',bad),/ATTEMPT_ALREADY_STARTED/);
  let state=(await db.query('SELECT state FROM sf_pilot_private.pilots')).rows[0].state;
  assert.equal(state.events.length,1);assert.equal(Object.keys(state.attempts).length,1);assert.deepEqual(Object.values(state.sequences),[1]);
  grant.consent=false;await db.query('UPDATE sf_pilot_private.pilots SET grants=$1',[JSON.stringify({u1:grant})]);
  await assert.rejects(collector.ingest('token',batch),/NOT_ADMITTED/);
  assert.equal(releases,4);
  await db.exec('CREATE ROLE pilot_untrusted; SET ROLE pilot_untrusted');
  await assert.rejects(db.query('SELECT * FROM sf_pilot_private.pilots'),/permission denied/);
  await db.exec('RESET ROLE');
 }finally{await db.close();await rm(dir,{recursive:true,force:true});}
});
