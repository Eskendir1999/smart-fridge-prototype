'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {createClient}=require('../pilot/client.js');
const {validate}=require('../pilot/analytics.cjs');
function harness(factory=createClient){
 let t=0,n=0,d=4;const listeners=new Set();
 const doc={hidden:false,addEventListener(name,fn){assert.equal(name,'visibilitychange');listeners.add(fn);},removeEventListener(name,fn){listeners.delete(fn);}};
 const c=factory({pilotId:'SYN',householdCode:'H1',buildSha:'SYNTHETIC',dayIndex:()=>d,clock:()=>t,uuid:()=>'E'+(++n),document:doc});
 return {c,listeners,advance(ms){t+=ms;},day(value){d=value;},hide(value){doc.hidden=value;for(const f of listeners)f();},activate(){c.activate({enabled:true,consent:true,pilotApproved:true});},start(){c.record('attempt_started',{origin:'natural',phase:'product'},'A1');}};
}
test('disabled client neither records nor installs listeners',()=>{const h=harness();assert.equal(h.c.record('attempt_started',{},'A1'),false);assert.equal(h.c.startTimer('decision','A1'),false);assert.equal(h.listeners.size,0);assert.equal(h.c.activate({enabled:true,consent:true}),false);});
test('active duration excludes hidden tab and uses common contract',()=>{const h=harness();h.activate();h.start();h.c.startTimer('decision','A1');h.advance(3000);h.hide(true);h.advance(60000);h.hide(false);h.advance(2000);h.c.stopTimer();const rows=h.c.export();assert.equal(rows[1].data.duration_sec,5);rows.forEach(validate);});
test('hidden initial tab accrues no time until visible',()=>{const h=harness();h.hide(true);h.activate();h.start();h.c.startTimer('decision','A1');h.advance(9000);h.hide(false);h.advance(2000);h.c.stopTimer();assert.equal(h.c.export()[1].data.duration_sec,2);});
test('parallel categories and outcome before stop rejected',()=>{const h=harness();h.activate();h.start();h.c.startTimer('decision','A1');assert.throws(()=>h.c.startTimer('maintenance','A1'));assert.throws(()=>h.c.record('first_result_confirmed',{availability:'enough',inventory_checked:true,portions_checked:true,list_checked:true,assisted:false},'A1'));});
test('client cannot supply commit/readback, manual audit or price',()=>{const h=harness();h.activate();h.start();for(const name of ['operation_result','stock_readback','inventory_audit','price_response','day_closed'])assert.throws(()=>h.c.record(name,{},'A1'));});
test('forbidden content never enters export',()=>{const h=harness();h.activate();assert.throws(()=>h.c.record('attempt_started',{origin:'natural',phase:'product',message:'private'},'A1'));assert.equal(h.c.export().length,0);});
test('revoke clears rows, timer and listeners permanently',()=>{const h=harness();h.activate();h.start();h.c.startTimer('decision','A1');h.advance(1000);h.c.revoke();assert.deepEqual(h.c.export(),[]);assert.equal(h.listeners.size,0);assert.equal(h.c.stopTimer(),false);assert.equal(h.c.activate({enabled:true,consent:true,pilotApproved:true}),false);});
test('day crossing does not silently attribute duration',()=>{const h=harness();h.activate();h.start();h.c.startTimer('decision','A1');h.advance(2000);h.day(5);assert.throws(()=>h.c.stopTimer());assert.equal(h.c.export().length,1);h.c.discardTimer();assert.equal(h.c.status().timerActive,false);});
test('export is an immutable snapshot for the caller',()=>{const h=harness();h.activate();h.start();const rows=h.c.export();rows[0].data.origin='assigned';assert.equal(h.c.export()[0].data.origin,'natural');});
test('browser global loads without Node, storage or network APIs',()=>{const context=vm.createContext({});for(const name of ['contract.js','client.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../pilot',name),'utf8'),context);const h=harness(context.SFPilotClient.createClient);h.activate();h.start();h.c.startTimer('decision','A1');h.advance(6000);h.c.stopTimer();assert.equal(h.c.export()[1].data.duration_sec,6);});
test('unknown attempts and duplicate start rejected',()=>{const h=harness();h.activate();assert.throws(()=>h.c.startTimer('decision','missing'));h.start();assert.throws(()=>h.start());});
test('synthetic browser export feeds offline M1/M2 without inventing server completion',()=>{
 const h=harness();h.activate();h.start();h.c.startTimer('setup','A1');h.advance(600000);h.c.stopTimer();h.c.startTimer('decision','A1');h.advance(360000);h.c.stopTimer();
 h.c.record('first_result_confirmed',{availability:'enough',inventory_checked:true,portions_checked:true,list_checked:true,assisted:false},'A1');
 h.c.record('cooking_reported',{outcome:'cooked',unexpected_purchase:'no',forced_substitution:'no',assisted:false},'A1');
 const rows=h.c.export();rows.push({...rows[0],event_id:'MANUAL-DAY',seq:100,attempt_id:null,source:'manual',event:'day_closed',data:{had_home_dinner:'yes',used_app:'yes',time_complete:true,reason:'none'}});
 const r=require('../pilot/analytics.cjs').summarize(rows,{pilotId:'SYN',households:['H1','H2','H3','H4','H5'],timeEvidenceVerified:true}).households[0];
 assert.equal(r.m1.minutes,16);assert.equal(r.m2.successes,1);assert.equal(r.m5.candidate_cycles,0);assert.equal(r.m5.verified_cycles,null);assert.equal(r.m6.savings,null);
});
