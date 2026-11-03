'use strict';
// SF pilot contract 1.2. Offline analysis only; no network or implicit collection.
const assert = require('node:assert/strict');
const {validate,field}=require('./contract.js');
function canonical(o){ return JSON.stringify(o, function(k,v){return v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v;}); }
function unique(rows){
 const map=new Map();
 for(const r of rows){validate(r);const old=map.get(r.event_id);if(old)assert.equal(canonical(old),canonical(r),'event_id collision');else map.set(r.event_id,r);}
 return [...map.values()];
}
function completed(rows){
 const r=unique(rows);if(!r.length)return false;assert(r.every(e=>e.pilot_id===r[0].pilot_id&&e.household_code===r[0].household_code&&e.attempt_id===r[0].attempt_id),'mixed attempt');
 if(!r.some(e=>e.event==='attempt_started')||!r.some(e=>e.event==='first_result_confirmed'))return false;
 const cook=r.filter(e=>e.event==='cooking_reported').sort((a,b)=>a.seq-b.seq).at(-1);
 if(!cook||cook.data.outcome!=='cooked')return false;
 const ops=r.filter(e=>e.event==='operation_result'&&e.data.status==='committed');
 // Conservative reference: any committed undo makes this attempt require a new explicit cycle.
 if(ops.some(e=>e.data.kind==='undo_batch'))return false;
 return ops.some(e=>e.data.kind==='consume_batch'&&r.some(f=>f.event==='first_result_confirmed'&&f.seq<e.seq)&&r.some(b=>b.event==='stock_readback'&&b.data.status==='matched'&&b.data.operation_id===e.data.operation_id&&b.data.revision===e.data.revision&&b.seq>e.seq));
}
function success(rows){const r=unique(rows);const o=r.filter(e=>e.event==='cooking_reported').sort((a,b)=>a.seq-b.seq).at(-1);return !!o&&o.data.outcome==='cooked'&&o.data.unexpected_purchase==='no'&&o.data.forced_substitution==='no';}
function balance(B,N,A,M,I){return {total:N*B-A-M-I,weekly:(N*B-A-M-I)*7/10};}

function group(rows,key){const m=new Map();for(const e of rows){const k=key(e);if(!m.has(k))m.set(k,[]);m.get(k).push(e);}return m;}
function one(rows,label){assert(rows.length<=1,'ambiguous '+label);return rows[0];}
function latest(rows,event){return rows.filter(e=>e.event===event).sort((a,b)=>a.seq-b.seq).at(-1);}
function sumTime(rows,category){return rows.filter(e=>e.event==='time_segment'&&e.data.category===category).reduce((n,e)=>n+e.data.duration_sec,0)/60;}
function median(values){const v=[...values].sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;}

// Input is an approved, normalized offline export, NOT an untrusted HTTP request.
// Server authenticity and non-overlapping timer intervals must be audited externally.
function summarize(input,{pilotId,households,serverEvidenceVerified=false,timeEvidenceVerified=false}={}){
 assert(field(pilotId,'id'));assert(Array.isArray(households)&&households.length===5,'five enrolled households required');
 assert(households.every(h=>field(h,'id'))&&new Set(households).size===5);
 const rows=unique(input);assert(rows.every(e=>e.pilot_id===pilotId&&households.includes(e.household_code)),'foreign cohort');
 const operations=new Map();
 for(const e of rows.filter(e=>['operation_result','stock_readback'].includes(e.event))){
  const key=e.household_code+'/'+e.data.operation_id;
  const previous=operations.get(key);assert(!previous||previous===e.attempt_id,'operation reused by another attempt');operations.set(key,e.attempt_id);
 }
 const results=households.map(h=>{
  const r=rows.filter(e=>e.household_code===h);
  const days=group(r.filter(e=>e.event==='day_closed'),e=>e.day_index);
  for(const d of days.values())one(d,'day closure');
  const completeDay=d=>days.get(d)?.[0].data.time_complete===true;
  const fullTime=Array.from({length:10},(_,i)=>i+4).every(completeDay);
  const attempts=group(r.filter(e=>e.attempt_id!==null),e=>e.attempt_id);
  const baseline=[],product=[];
  for(const a of attempts.values()){
   const start=one(a.filter(e=>e.event==='attempt_started'),'attempt start');assert(start,'orphan attempt');
   assert(a.every(e=>e.day_index===start.day_index),'attempt spans days: needs explicit review');
   assert(new Set(a.map(e=>e.seq)).size===a.length,'ambiguous sequence');
   assert(a.every(e=>e.seq>=start.seq),'event precedes start');
   const phase=start.data.phase;
   assert(phase==='baseline'?start.day_index<=3:start.day_index>=4&&start.day_index<=13,'wrong phase day');
   const segment=a.some(e=>e.event==='time_segment'&&e.data.category==='decision');
   if(phase==='baseline'){
    if(completeDay(start.day_index)&&segment&&latest(a,'cooking_reported')?.data.outcome==='cooked')baseline.push(sumTime(a,'decision'));
   }else product.push({rows:a,start,segment});
  }
  const p=product.sort((a,b)=>a.start.day_index-b.start.day_index||a.start.seq-b.start.seq);
  const allProduct=p.flatMap(a=>a.rows);
  // Include daily maintenance/setup independent of an attempted dinner as well.
  const window=r.filter(e=>e.day_index>=4&&e.day_index<=13);
  const A=sumTime(allProduct,'decision'),M=sumTime(window,'maintenance'),I=sumTime(window,'setup');
  const B=baseline.length>=2?median(baseline):null;
  const timeValid=fullTime&&p.every(a=>a.segment)&&timeEvidenceVerified;
  const savings=B!==null&&timeValid?balance(B,p.length,A,M,I):null;
  const first=p[0],f=first?.rows.filter(e=>e.event==='first_result_confirmed').sort((a,b)=>a.seq-b.seq)[0];
  const firstTimed=f&&first.rows.some(e=>e.seq<f.seq&&e.event==='time_segment'&&e.data.category==='decision');
  const firstTime=firstTimed&&timeEvidenceVerified&&completeDay(first.start.day_index) ? first.rows.filter(e=>e.seq<=f.seq&&e.event==='time_segment'&&['setup','decision','maintenance'].includes(e.data.category)).reduce((n,e)=>n+e.data.duration_sec,0)/60:null;
  const assisted=a=>a.some(e=>e.data.assisted===true);
  const cooked=p.filter(a=>latest(a.rows,'cooking_reported')?.data.outcome==='cooked').length;
  const successes=p.filter(a=>success(a.rows)).length;
  const unknown=p.filter(a=>{const o=latest(a.rows,'cooking_reported');return !o||o.data.outcome==='unknown'||(o.data.outcome==='cooked'&&(o.data.unexpected_purchase==='unknown'||o.data.forced_substitution==='unknown'));}).length;
  const cycles=p.filter(a=>completed(a.rows));
  const repeated=cycles.filter(a=>a.start.day_index>=8&&!assisted(a.rows));
  const repeatDays=new Set(repeated.map(a=>a.start.day_index)).size;
  const natural=repeated.some(a=>a.start.data.origin==='natural');
  const audits=r.filter(e=>e.event==='inventory_audit');
  const checks=group(audits,e=>e.data.check_id);for(const a of checks.values())one(a,'audit');
  const auditPlan=[7,13].every(d=>{const a=audits.filter(e=>e.day_index===d);return a.length===5&&a.filter(e=>e.data.direction==='app_to_shelf').length===3&&a.filter(e=>e.data.direction==='shelf_to_app').length===2;})&&audits.length===10;
  const matches=audits.filter(e=>e.data.measurable&&!e.data.false_sufficient&&['presence_match','quantity_match','unit_match','date_match'].every(k=>e.data[k])).length;
  const falseSufficient=audits.some(e=>e.data.false_sufficient);
  const price=one(r.filter(e=>e.event==='price_response'),'price response');
  const paymentSignal=!!price&&['A','B'].includes(price.data.offer)&&price.data.value_episode_confirmed&&price.data.positive_time_balance&&savings!==null&&savings.total>0;
  return {household:h,observed_days:[...days.keys()].filter(d=>d>=4&&d<=13).length,baseline_n:baseline.length,attempts:p.length,
   m1:{minutes:firstTime,pass:first&&!f?false:firstTime===null?null:firstTime<=20&&!assisted(first.rows.filter(e=>e.seq<=f.seq)),reached:!!f},
   m2:{successes,attempts:p.length,cooked,unknown,pass:p.length>0&&successes>=3&&successes/p.length>=.75},
   m3:{minutes:M,per_day:timeValid?M/10:null,pass:timeValid?M/10<=3:null},
   m4:{matches,checked:audits.length,plan_complete:auditPlan,false_sufficient:falseSufficient,pass:auditPlan?matches>=9&&!falseSufficient:null},
   m5:{candidate_cycles:cycles.length,verified_cycles:serverEvidenceVerified?cycles.length:null,repeat_days:repeatDays,natural,pass:serverEvidenceVerified?repeatDays>=2&&natural:null},
   m6:{B,A,M,I,savings,pass:savings? savings.total>0&&savings.weekly>=10:null},
   m7:{offer:price?.data.offer??null,signal:paymentSignal},
   evidence_sufficient:baseline.length>=2&&p.length>=4&&[...days.keys()].filter(d=>d>=4&&d<=13).length>=8};
 });
 const gates={};for(let i=1;i<=6;i++)gates['M'+i]={passed:results.filter(r=>r['m'+i].pass===true).length,unknown:results.filter(r=>r['m'+i].pass===null).length,total:5};
 gates.M7={signals:results.filter(r=>r.m7.signal).length,total:5};
 return {schema_version:'1.2',pilot_id:pilotId,households:results,metrics:gates,server_evidence_verified:serverEvidenceVerified,time_evidence_verified:timeEvidenceVerified,
  pilot_admission:'NOT_EVALUATED',payment_permission:false,
  data_sufficient:results.filter(r=>r.evidence_sufficient).length>=4,
  reliability_alert:results.some(r=>r.m4.false_sufficient)};
}

// Memory-only recorder for a future opt-in integration. No timers, cookies, storage or network.
function createRecorder({enabled=false,consent=false,pilotApproved=false,pilotId,householdCode,maxEvents=2000}={}){
 assert(Number.isInteger(maxEvents)&&maxEvents>0&&maxEvents<=10000);
 let allowed=enabled&&consent&&pilotApproved,rows=[];
 return Object.freeze({
  record(event){if(!allowed)return false;validate(event);assert(event.pilot_id===pilotId&&event.household_code===householdCode,'wrong scope');
   assert(event.source==='client','client recorder cannot supply trusted source');
   const next=unique([...rows,event]);assert(next.length<=maxEvents,'buffer full');rows=JSON.parse(JSON.stringify(next));return true;},
  export(){return allowed?JSON.parse(JSON.stringify(rows)):[];},
  revoke(){allowed=false;rows=[];}
 });
}
module.exports={validate,unique,completed,success,balance,summarize,createRecorder};
