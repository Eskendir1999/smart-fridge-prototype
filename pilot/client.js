(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory(require('./contract.js'));
 else root.SFPilotClient=factory(root.SFPilotContract);
})(typeof globalThis!=='undefined'?globalThis:this,function(contract){
 'use strict';
 if(!contract)throw new Error('Load pilot/contract.js first');
 const allowed=new Set(['attempt_started','first_result_confirmed','cooking_reported']);
 const categories=new Set(['setup','decision','maintenance','research','extra_trip']);
 function check(ok,message){if(!ok)throw new TypeError(message);}
 function createClient({pilotId,householdCode,actorCode='A',buildSha,dayIndex,clock=()=>performance.now(),uuid=()=>crypto.randomUUID(),document:doc=typeof document==='undefined'?null:document,maxEvents=2000}={}){
  check(contract.field(pilotId,'id')&&contract.field(householdCode,'id'),'invalid pseudonymous scope');
  check(['A','B'].includes(actorCode)&&contract.field(buildSha,'sha'),'invalid actor/build');
  check(typeof dayIndex==='function'&&typeof clock==='function'&&typeof uuid==='function','missing clocks/ids');
  check(Number.isInteger(maxEvents)&&maxEvents>0&&maxEvents<=10000,'invalid cap');
  let enabled=false,closed=false,seq=0,rows=[],timer=null,attached=false;
  const attempts=new Set();
  function now(){const n=clock();check(Number.isFinite(n)&&n>=0,'invalid clock');return n;}
  function day(){const n=dayIndex();check(contract.field(n,'day'),'outside pilot days');return n;}
  function append(name,data,attemptId,eventDay){
   check(rows.length<maxEvents,'buffer full: export before continuing');
   const e={schema_version:'1.2',event_id:uuid(),pilot_id:pilotId,household_code:householdCode,actor_code:actorCode,attempt_id:attemptId,day_index:eventDay,build_sha:buildSha,seq:seq+1,source:'client',event:name,data};
   contract.validate(e);check(!rows.some(r=>r.event_id===e.event_id),'id collision');
   rows.push(JSON.parse(JSON.stringify(e)));seq++;return e.event_id;
  }
  function accrue(){if(timer&&timer.since!==null){const n=now();check(n>=timer.since,'clock moved backwards');timer.ms+=n-timer.since;timer.since=null;}}
  function visibility(){if(!enabled||!timer)return;accrue();if(!doc?.hidden)timer.since=now();}
  function revoke(){enabled=false;closed=true;timer=null;rows=[];attempts.clear();if(attached){doc.removeEventListener('visibilitychange',visibility);attached=false;}}
  return Object.freeze({
   activate({enabled:featureEnabled=false,consent=false,pilotApproved=false}={}){
    if(closed)return false;
    if(!(featureEnabled===true&&consent===true&&pilotApproved===true))return false;
    day();enabled=true;
    if(doc&&!attached){doc.addEventListener('visibilitychange',visibility);attached=true;}return true;
   },
   record(name,data,attemptId){
    if(!enabled)return false;
    check(allowed.has(name),'client cannot emit server/manual events');
    check(contract.field(attemptId,'id'),'attempt required');
    if(name==='attempt_started')check(!attempts.has(attemptId),'attempt already started');
    else check(attempts.has(attemptId),'start attempt first');
    // Flush time before recording the first useful result; never report a zero-length gap.
    check(!timer,'stop active timer before recording outcome');
    const id=append(name,data,attemptId,day());if(name==='attempt_started')attempts.add(attemptId);return id;
   },
   startTimer(category,attemptId=null,{assisted=false}={}){
    if(!enabled)return false;
    check(!timer,'only one active category per actor');check(categories.has(category),'invalid category');
    check(typeof assisted==='boolean','invalid assistance flag');
    check(attemptId===null||attempts.has(attemptId),'unknown attempt');
    if(['decision','setup'].includes(category))check(attemptId!==null,'attempt required');
    timer={category,attemptId,assisted,day:day(),ms:0,since:doc?.hidden?null:now()};return true;
   },
   stopTimer(){
    if(!enabled||!timer)return false;
    accrue();check(day()===timer.day,'day changed: discard timer and enter reviewed estimate');
    const id=append('time_segment',{category:timer.category,duration_sec:Math.round(timer.ms/1000),method:'timer',assisted:timer.assisted},timer.attemptId,timer.day);
    timer=null;return id;
   },
   discardTimer(){timer=null;},
   export(){return enabled?JSON.parse(JSON.stringify(rows)):[];},
   revoke,
   status(){return {enabled,closed,eventCount:rows.length,timerActive:timer!==null};}
  });
 }
 return Object.freeze({createClient});
});
