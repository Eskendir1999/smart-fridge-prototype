const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
function fn(name){const i=html.search(new RegExp('(?:async )?function '+name+'\\('));assert.ok(i>=0);const tail=html.slice(i);return tail.slice(0,tail.indexOf('\n}')+2);}
function ctx(names,values={}){const c=vm.createContext(values);vm.runInContext(names.map(fn).join('\n'),c);return c;}
test('all legacy recipes fail closed for exclusions, unknown restrictions and missing fields',()=>{
 const c=ctx(['recipeBlockReason'],{getCurrentProfile:()=>null});
 const start=html.indexOf('const recipesData = [');const end=html.indexOf('\n];',start)+3;vm.runInContext(html.slice(start,end),c);
 for(const ex of [['egg'],['dairy','nuts'],['sesame'],[null],null]){
 c.profile={age:30,excluded_foods:ex};assert.equal(vm.runInContext('recipesData.every(r => !!recipeBlockReason(r,profile))',c),true);
 }
 c.profile={age:30,excluded_foods:[]};assert.equal(vm.runInContext('recipesData.every(r => recipeBlockReason(r,profile) === null)',c),true);
});
test('no alternative returns empty dish, never excluded fallback',()=>{
 const c=ctx(['resolveDish'],{defaultDishId:()=> 'bad',mealChoices:{},DISH_BY_ID:{bad:{id:'bad',slot:'b'}},dishBlockReason:()=> 'conflict',allowedDishes:()=>[]});
 assert.equal(vm.runInContext('resolveDish(1,"b",{}).dish',c),null);
});
test('current profile requires confirmed owner, not household or creator',()=>{
 const c=ctx(['getCurrentProfile'],{currentProfileId:'p',currentUserId:'owner',familyProfiles:[{id:'p',created_by:'owner',household_id:'family'}]});assert.equal(vm.runInContext('getCurrentProfile()',c),null);
 c.familyProfiles[0].profile_owner_user_id='other';assert.equal(vm.runInContext('getCurrentProfile()',c),null);
 c.familyProfiles[0].profile_owner_user_id='owner';assert.equal(vm.runInContext('getCurrentProfile().id',c),'p');
});
test('measurement error or profile switch never changes visible history',async()=>{
 for(const mode of ['error','switch']){
 const history=[{date:'2026-11-03',weight:70}];const c=ctx(['mergeMeasurementEntry'],{privateContextVersion:1,measurementHistory:history,showToast:()=>{},dbSaveMeasurement:async()=>{if(mode==='error')throw Error('denied');c.privateContextVersion++;}});
 assert.equal(await vm.runInContext('mergeMeasurementEntry({date:"2026-11-03",weight:80})',c),null);assert.equal(history[0].weight,70);
 }
});
test('a saved measurement updates local history only after confirmation',async()=>{
 let resolve;const c=ctx(['mergeMeasurementEntry'],{privateContextVersion:1,measurementHistory:[],showToast:()=>{},dbSaveMeasurement:()=>new Promise(r=>resolve=r)});
 const pending=vm.runInContext('mergeMeasurementEntry({date:"2026-11-03",weight:80})',c);assert.equal(c.measurementHistory.length,0);resolve();await pending;assert.equal(c.measurementHistory.length,1);
});
test('native personal widget reads are disabled',async()=>{
 const c=ctx(['widgetProfileRows'],{sb:{from(){throw Error('No private reads');}}});assert.equal(await vm.runInContext('widgetProfileRows()',c),null);
 const script=fs.readFileSync(require('node:path').join(__dirname,'../scriptable/smart-fridge.js'),'utf8');assert.doesNotMatch(script,/rest\(['`"]family_(profiles|measurements)/);
});
test('unconfirmed stricter settings suspend recommendations after reload in the same session',()=>{
 const c=ctx(['recipeBlockReason'],{getCurrentProfile:()=>null,currentUserId:'owner',sessionStorage:{getItem:key=>key==='sf_restrictions_pending_owner_p'?'1':null}});
 assert.match(vm.runInContext('recipeBlockReason({id:"r"},{id:"p",excluded_foods:[]})',c),/приостановлены/);
});
