'use strict';
// Server-side domain service, intentionally NOT an exposed HTTP endpoint.
// All durable state and authorization must be supplied by a transactional DB adapter.
const {createHash}=require('node:crypto');
const {validate,field}=require('./contract.js');
const clientTypes=new Set(['attempt_started','first_result_confirmed','time_segment','cooking_reported']);
function fail(code){const e=new Error(code);e.code=code;throw e;}
function requireThat(ok,code){if(!ok)fail(code);}
function exact(value,keys){requireThat(value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort()),'INVALID_INPUT');}
function canonical(value){return JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
function fingerprint(value){return createHash('sha256').update(canonical(value)).digest('hex');}
function createCollector({authenticate,transaction,now=()=>Date.now(),testMode=false}={}){
 requireThat(typeof authenticate==='function'&&typeof transaction==='function','ADAPTER_REQUIRED');
 async function withScope(token,pilotId,work){
  requireThat(typeof token==='string'&&token.length>0&&token.length<=8192,'UNAUTHENTICATED');
  requireThat(field(pilotId,'id'),'INVALID_PILOT');
  let user;try{user=await authenticate(token);}catch{fail('UNAUTHENTICATED');}
  requireThat(user&&typeof user.id==='string'&&user.id.length>0,'UNAUTHENTICATED');
  // Adapter holds membership, consent, pilot and event locks until commit/rollback.
  return transaction(async tx=>{
   const grant=await tx.authorize(user.id,pilotId);
   requireThat(grant&&grant.pilotId===pilotId&&grant.userId===user.id&&grant.member===true,'FORBIDDEN');
   requireThat(grant.pilotActive===true&&grant.gatesAccepted===true&&grant.consent===true&&Number.isFinite(grant.expiresAt)&&grant.expiresAt>now(),'NOT_ADMITTED');
   requireThat(field(grant.householdCode,'id')&&['A','B'].includes(grant.actorCode)&&Array.isArray(grant.builds),'INVALID_GRANT');
   return work(tx,grant);
  });
 }
 async function ingest(token,input){
  exact(input,['pilot_id','stream_id','events']);
  requireThat(field(input.stream_id,'id')&&Array.isArray(input.events)&&input.events.length>0&&input.events.length<=100,'INVALID_BATCH');
  requireThat(Buffer.byteLength(JSON.stringify(input))<=128*1024,'BATCH_TOO_LARGE');
  // Reject forbidden content before calling any storage adapter.
  for(const e of input.events){validate(e);requireThat(e.source==='client'&&clientTypes.has(e.event),'CLIENT_SOURCE_FORBIDDEN');requireThat(!/^(OP-|RB-)/.test(e.event_id),'CLIENT_EVENT_ID_RESERVED');}
  return withScope(token,input.pilot_id,async(tx,g)=>{
   const accepted=[];let stream=await tx.getStream(g,input.stream_id);
   requireThat(!stream||(stream.actorCode===g.actorCode&&stream.userId===g.userId),'STREAM_OWNER_MISMATCH');
   let last=stream?.lastSeq??-1;
   for(const raw of input.events){
    requireThat(raw.pilot_id===g.pilotId&&raw.household_code===g.householdCode&&raw.actor_code===g.actorCode,'SCOPE_MISMATCH');
    requireThat(g.builds.includes(raw.build_sha)&&(testMode||raw.build_sha!=='SYNTHETIC'),'BUILD_NOT_ADMITTED');
    requireThat(Number.isInteger(g.currentDay)&&raw.day_index===g.currentDay,'DAY_REVIEW_REQUIRED');
    const digest=fingerprint({stream:input.stream_id,event:raw});
    const prior=await tx.findEvent(g,raw.event_id);
    if(prior){requireThat(prior.digest===digest,'EVENT_COLLISION');accepted.push({event_id:raw.event_id,seq:prior.event.seq,duplicate:true});continue;}
    requireThat(raw.seq>last,'STREAM_ORDER_CONFLICT');
    if(raw.attempt_id!==null){
     const attempt=await tx.getAttempt(g,raw.attempt_id);
     if(raw.event==='attempt_started'){
      requireThat(!attempt,'ATTEMPT_ALREADY_STARTED');
      requireThat(raw.data.phase==='product'&&raw.day_index>=4&&raw.day_index<=13,'PHASE_REVIEW_REQUIRED');
      await tx.createAttempt(g,raw.attempt_id,{userId:g.userId,actorCode:g.actorCode,day:raw.day_index});
     }else requireThat(attempt&&attempt.userId===g.userId&&attempt.actorCode===g.actorCode&&attempt.day===raw.day_index,'ATTEMPT_SCOPE_MISMATCH');
    }
    const event={...raw,seq:await tx.nextSequence(g),source:'client'};
    await tx.appendEvent(g,{digest,event});last=raw.seq;
    accepted.push({event_id:event.event_id,seq:event.seq,duplicate:false});
   }
   await tx.saveStream(g,input.stream_id,{userId:g.userId,actorCode:g.actorCode,lastSeq:last});
   return {accepted};
  });
 }
 async function confirmOperation(token,input){
  exact(input,['pilot_id','attempt_id','operation_id']);
  requireThat(field(input.attempt_id,'id')&&field(input.operation_id,'id'),'INVALID_OPERATION');
  return withScope(token,input.pilot_id,async(tx,g)=>{
   const attempt=await tx.getAttempt(g,input.attempt_id);
   requireThat(attempt&&attempt.userId===g.userId&&attempt.actorCode===g.actorCode&&attempt.day===g.currentDay,'ATTEMPT_SCOPE_MISMATCH');
   const receipt=await tx.readReceipt(g,input.operation_id);
   requireThat(receipt&&receipt.householdCode===g.householdCode&&receipt.attemptId===input.attempt_id&&receipt.operationId===input.operation_id,'RECEIPT_SCOPE_MISMATCH');
   requireThat(receipt.status==='committed'&&['consume_batch','undo_batch'].includes(receipt.kind)&&Number.isSafeInteger(receipt.expectedCount)&&receipt.expectedCount>0&&receipt.appliedCount===receipt.expectedCount,'BATCH_NOT_COMMITTED');
   requireThat(field(receipt.revision,'id')&&g.builds.includes(receipt.buildSha)&&(testMode||receipt.buildSha!=='SYNTHETIC'),'INVALID_RECEIPT');
   const proof=await tx.verifyReadback(g,receipt);
   requireThat(proof&&proof.matched===true&&proof.operationId===receipt.operationId&&proof.revision===receipt.revision,'READBACK_NOT_CONFIRMED');
   // Stable event IDs based on operation, independent of retries or client-provided IDs.
   const key=fingerprint({pilot:g.pilotId,household:g.householdCode,operation:receipt.operationId});
   const output=[];
   for(const [event,data] of [
    ['operation_result',{operation_id:receipt.operationId,kind:receipt.kind,status:'committed',error_code:'none',revision:receipt.revision}],
    ['stock_readback',{operation_id:receipt.operationId,revision:receipt.revision,status:'matched'}]
   ]){
    const record={schema_version:'1.2',event_id:(event==='operation_result'?'OP-':'RB-')+key,pilot_id:g.pilotId,household_code:g.householdCode,actor_code:'system',attempt_id:input.attempt_id,day_index:attempt.day,build_sha:receipt.buildSha,source:'server',event,data};
    const digest=fingerprint(record),existing=await tx.findEvent(g,record.event_id);
    if(existing){requireThat(existing.digest===digest,'RECEIPT_COLLISION');output.push(existing.event);continue;}
    const saved={...record,seq:await tx.nextSequence(g)};validate(saved);await tx.appendEvent(g,{digest,event:saved});output.push(saved);
   }
   return {events:output};
  });
 }
 return Object.freeze({ingest,confirmOperation});
}
module.exports={createCollector};
