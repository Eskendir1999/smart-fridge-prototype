'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCollector}=require('../pilot/collector.cjs');
const {createClient}=require('../pilot/client.js');
const {summarize}=require('../pilot/analytics.cjs');
function harness(){
 let state={events:[],attempts:{},streams:{},seq:0},queue=Promise.resolve(),writes=0;
 const grant={pilotId:'SYN',userId:'user1',householdCode:'H1',actorCode:'A',member:true,pilotActive:true,gatesAccepted:true,consent:true,expiresAt:2000,builds:['SYNTHETIC'],currentDay:8};
 const receipt={householdCode:'H1',attemptId:'A1',operationId:'O1',status:'committed',kind:'consume_batch',expectedCount:2,appliedCount:2,revision:'R1',buildSha:'SYNTHETIC'};
 let proof={matched:true,operationId:'O1',revision:'R1'},failure=false;
 const transaction=work=>{const job=queue.then(async()=>{const copy=structuredClone(state);const tx={
  async authorize(){return structuredClone(grant);},async getStream(g,id){return copy.streams[id];},async saveStream(g,id,v){copy.streams[id]=v;},
  async findEvent(g,id){return copy.events.find(e=>e.event.event_id===id);},async getAttempt(g,id){return copy.attempts[id];},async createAttempt(g,id,v){copy.attempts[id]=v;},
  async nextSequence(){return ++copy.seq;},async appendEvent(g,e){writes++;if(failure&&writes%2===0)throw Error('storage unavailable');copy.events.push(e);},
  async readReceipt(){return structuredClone(receipt);},async verifyReadback(){return structuredClone(proof);}
 };const result=await work(tx);state=copy;return result;});queue=job.catch(()=>{});return job;};
 const authenticate=async token=>{if(token!=='valid')throw Error('invalid JWT fixture');return {id:'user1'};};
 const service=createCollector({authenticate,transaction,now:()=>1000,testMode:true});
 let n=0,t=0;const client=createClient({pilotId:'SYN',householdCode:'H1',buildSha:'SYNTHETIC',dayIndex:()=>8,uuid:()=>'C'+(++n),clock:()=>t});
 client.activate({enabled:true,consent:true,pilotApproved:true});
 client.record('attempt_started',{origin:'natural',phase:'product'},'A1');
 client.startTimer('decision','A1');t=60000;client.stopTimer();
 client.record('first_result_confirmed',{availability:'enough',inventory_checked:true,portions_checked:true,list_checked:true,assisted:false},'A1');
 client.record('cooking_reported',{outcome:'cooked',unexpected_purchase:'no',forced_substitution:'no',assisted:false},'A1');
 return {service,grant,receipt,client,transaction,authenticate,get writes(){return writes;},get rows(){return state.events.map(x=>x.event);},batch(){return {pilot_id:'SYN',stream_id:'S1',events:client.export()};},confirm(){return service.confirmOperation('valid',{pilot_id:'SYN',attempt_id:'A1',operation_id:'O1'});},failWrites(){failure=true;},resumeWrites(){failure=false;},setProof(v){proof=v;}};
}
test('client -> transactional intake -> verified batch -> offline report on synthetic adapters',async()=>{
 const h=harness();await h.service.ingest('valid',h.batch());await h.confirm();const r=summarize(h.rows,{pilotId:'SYN',households:['H1','H2','H3','H4','H5'],serverEvidenceVerified:true}).households[0];
 assert.equal(r.m2.successes,1);assert.equal(r.m5.verified_cycles,1);assert.equal(r.m6.savings,null);assert.equal(h.rows.filter(e=>e.source==='server').length,2);
});
test('bad authentication prevents writes',async()=>{const h=harness();await assert.rejects(h.service.ingest('expired',h.batch()),/UNAUTHENTICATED/);assert.equal(h.writes,0);});
test('membership, consent and pilot gates are independent barriers',async()=>{for(const key of ['member','consent','pilotActive','gatesAccepted']){const h=harness();h.grant[key]=false;await assert.rejects(h.service.ingest('valid',h.batch()));assert.equal(h.rows.length,0);}});
test('expired admission prevents writes',async()=>{const h=harness();h.grant.expiresAt=999;await assert.rejects(h.service.ingest('valid',h.batch()),/NOT_ADMITTED/);});
test('client supplied identity and actor cannot replace grant',async()=>{for(const key of ['household_code','actor_code']){const h=harness(),b=h.batch();b.events[0][key]=key==='actor_code'?'B':'H2';await assert.rejects(h.service.ingest('valid',b),/SCOPE_MISMATCH/);assert.equal(h.rows.length,0);}});
test('client commit claim rejected before any writes',async()=>{const h=harness(),b=h.batch();b.events[0]={...b.events[0],source:'server',event:'operation_result',data:{operation_id:'O1',kind:'consume_batch',status:'committed',error_code:'none',revision:'R1'}};await assert.rejects(h.service.ingest('valid',b),/CLIENT_SOURCE_FORBIDDEN/);assert.equal(h.writes,0);});
test('simultaneous duplicate batch produces one stored copy',async()=>{const h=harness();await Promise.all([h.service.ingest('valid',h.batch()),h.service.ingest('valid',h.batch())]);assert.equal(h.rows.length,4);});
test('event collision rolls back entire incoming batch',async()=>{const h=harness();await h.service.ingest('valid',h.batch());const b=h.batch();b.events[0].data.origin='assigned';await assert.rejects(h.service.ingest('valid',b),/EVENT_COLLISION/);assert.equal(h.rows.length,4);});
test('failure during second storage write leaves zero events and retries work',async()=>{const h=harness();h.failWrites();await assert.rejects(h.service.ingest('valid',h.batch()));assert.equal(h.rows.length,0);h.resumeWrites();await h.service.ingest('valid',h.batch());assert.equal(h.rows.length,4);});
test('stream order cannot be silently reversed',async()=>{const h=harness(),b=h.batch();b.events.reverse();await assert.rejects(h.service.ingest('valid',b));assert.equal(h.rows.length,0);});
test('scope is checked inside transaction after queue wait',async()=>{const h=harness();let release;const block=h.transaction(()=>new Promise(r=>{release=r;}));await new Promise(r=>setImmediate(r));const pending=h.service.ingest('valid',h.batch());h.grant.consent=false;release();await block;await assert.rejects(pending,/NOT_ADMITTED/);assert.equal(h.rows.length,0);});
test('unapproved build and historical day require review',async()=>{for(const mode of ['build','day']){const h=harness();if(mode==='build')h.grant.builds=[];else h.grant.currentDay=9;await assert.rejects(h.service.ingest('valid',h.batch()),mode==='build'?/BUILD_NOT_ADMITTED/:/DAY_REVIEW_REQUIRED/);}});
test('synthetic build refused outside test mode',async()=>{const h=harness(),s=createCollector({authenticate:h.authenticate,transaction:h.transaction,now:()=>1000});await assert.rejects(s.ingest('valid',h.batch()),/BUILD_NOT_ADMITTED/);});
test('all batch lines must commit, partial stock writes are not a dinner',async()=>{const h=harness();await h.service.ingest('valid',h.batch());h.receipt.appliedCount=1;await assert.rejects(h.confirm(),/BATCH_NOT_COMMITTED/);assert.equal(h.rows.length,4);});
test('receipt must belong to this household and attempt',async()=>{for(const key of ['householdCode','attemptId']){const h=harness();await h.service.ingest('valid',h.batch());h.receipt[key]='other';await assert.rejects(h.confirm(),/RECEIPT_SCOPE_MISMATCH/);}});
test('readback proof must match receipt revision and operation',async()=>{const h=harness();await h.service.ingest('valid',h.batch());h.setProof({matched:true,operationId:'O1',revision:'R2'});await assert.rejects(h.confirm(),/READBACK_NOT_CONFIRMED/);});
test('repeating proof does not double-count server events',async()=>{const h=harness();await h.service.ingest('valid',h.batch());await Promise.all([h.confirm(),h.confirm()]);assert.equal(h.rows.length,6);});
test('revoking consent blocks subsequent receipt import',async()=>{const h=harness();await h.service.ingest('valid',h.batch());h.grant.consent=false;await assert.rejects(h.confirm(),/NOT_ADMITTED/);assert.equal(h.rows.length,4);});
test('request cannot supply a receipt or free text',async()=>{const h=harness();await assert.rejects(h.service.confirmOperation('valid',{pilot_id:'SYN',attempt_id:'A1',operation_id:'O1',receipt:{status:'committed'}}),/INVALID_INPUT/);const b=h.batch();b.events[0].data.message='personal';await assert.rejects(h.service.ingest('valid',b));assert.equal(h.writes,0);});
test('server sequence replaces local sequence and is strictly increasing',async()=>{const h=harness(),b=h.batch();b.events.forEach(e=>e.seq+=500);await h.service.ingest('valid',b);await h.confirm();assert.deepEqual(h.rows.map(e=>e.seq),[1,2,3,4,5,6]);});
test('client cannot preempt server evidence identifiers',async()=>{const h=harness(),b=h.batch();b.events[0].event_id='OP-guessed';await assert.rejects(h.service.ingest('valid',b),/CLIENT_EVENT_ID_RESERVED/);assert.equal(h.writes,0);});
test('changing actor label cannot transfer ownership of an attempt',async()=>{const h=harness();await h.service.ingest('valid',h.batch());h.grant.userId='user2';const s=createCollector({authenticate:async()=>({id:'user2'}),transaction:h.transaction,now:()=>1000,testMode:true});await assert.rejects(s.confirmOperation('valid',{pilot_id:'SYN',attempt_id:'A1',operation_id:'O1'}),/ATTEMPT_SCOPE_MISMATCH/);});
