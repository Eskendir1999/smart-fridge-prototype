const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
function fn(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const tail = html.slice(start), end = tail.indexOf('\n}');
  return tail.slice(0, end + 2);
}
function context(names, values = {}) {
  const c = vm.createContext(values);
  vm.runInContext(names.map(fn).join('\n'), c);
  return c;
}
// Owner-only nutrition (restored 18.11.2026): calorie norm with safety floors, breastfeeding never below 1800
// and never more than 300 kcal under need, no fasting day while breastfeeding.
function kcalContext(){ return context(['calcBMR','activityMultiplier','calcBreastfeedingKcal','calcKcalTarget','isBreastfeeding','babyAgeMonths'],{dietField:(p,k)=>p[k]}); }
test('calorie norm keeps safety floors', () => {
  const c = kcalContext();
  const run = p => { c.p = p; return vm.runInContext('calcKcalTarget(p, p.w)', c); };
  const man = run({sex:'male',age:34,height_cm:180,activity_level:'moderate',goal:'lose',w:96});
  assert.ok(man > 1500 && man < 3500, String(man));
  assert.equal(run({sex:'female',age:40,height_cm:150,activity_level:'low',goal:'lose',w:42}), 1200);
  assert.equal(run({sex:'male',age:16,height_cm:150,activity_level:'low',goal:'lose',w:40}), 1400);
  const keep = run({sex:'female',age:30,height_cm:165,activity_level:'moderate',goal:'maintain',w:60});
  const lose = run({sex:'female',age:30,height_cm:165,activity_level:'moderate',goal:'lose',w:60});
  assert.equal(keep - lose, 500);
});
test('breastfeeding: +330/+400 kcal, at most 300 under need, never below 1800', () => {
  const c = kcalContext();
  const base = {sex:'female',age:30,height_cm:160,activity_level:'low',diet_mode:'breastfeeding',w:55};
  for (const [baby, extra] of [[3,330],[8,400]]) {
    c.p = {...base, baby_age_months:baby, goal:'maintain'}; const keep = vm.runInContext('calcKcalTarget(p, p.w)', c);
    c.p = {...base, baby_age_months:baby, goal:'lose'}; const lose = vm.runInContext('calcKcalTarget(p, p.w)', c);
    assert.ok(lose >= 1800); assert.ok(keep - lose <= 300); assert.ok(keep > 1800 || extra);
  }
  c.p = {...base, height_cm:145, w:40, goal:'lose', baby_age_months:2};
  assert.equal(vm.runInContext('calcKcalTarget(p, p.w)', c), 1800);
});
test('week menu: fasting day only without breastfeeding; breastfeeding gets snacks', () => {
  const c=context(['isBreastfeeding','dietField','daySlots','defaultDishId','resolveDish','weekMenu','sanitizeMealChoices','babyAgeMonths'],{
    mealChoices:{},dishBlockReason:()=>null,dietColumnsMissing:false,profile:{age:30,goal:'lose'}});
  const a=html.indexOf('const dietDays = ['), b=html.indexOf('// Нужны каждый день',a);
  vm.runInContext(html.slice(a,b),c);
  let week=vm.runInContext('weekMenu(profile)',c);
  assert.equal(week.length,7); assert.deepEqual(Array.from(week[6].slots,x=>x.slot),['f']);
  c.profile={age:30,sex:'female',diet_mode:'breastfeeding',goal:'lose'};
  week=vm.runInContext('weekMenu(profile)',c);
  for(const day of week){ assert.deepEqual(Array.from(day.slots,x=>x.slot),['b','s','l','d']); assert.ok(day.slots.every(e=>e.dish && e.dish.id!=='f_fast')); }
});
test('legacy underage or unknown profile is blocked before measurement query',async()=>{
  for(const age of [17,null,'bad']){
    let queries=0;const notices=[];
    const c=context(['isAdultNutritionProfile','openFamilyMember'],{
      familyProfiles:[{id:'child',age}],showToast:t=>notices.push(t),sb:{from(){queries++;throw Error('No query');}}
    });
    await vm.runInContext('openFamilyMember("child")',c);assert.equal(queries,0);assert.match(notices[0],/только взрослым/);
  }
});
test('disabled chat screen never loads account-wide messages or speaks them',async()=>{
  const nodes=Object.fromEntries(['dietitian-messages','dietitian-summaries-hint','dt-status'].map(id=>[id,{textContent:'legacy'}]));
  let stopped=0;
  const c=context(['dietitianAiAllowed','loadDietitianScreen'],{SF_NUTRITION_ENABLED:false,sessionStorage:{getItem:()=>'1'},dietitianHistory:['legacy'],dietitianInput:{},dietitianSendBtn:{},document:{getElementById:id=>nodes[id]},window:{speechSynthesis:{cancel(){stopped++;}}},sb:{from(){throw Error('Must not read account chat');}}});
  await vm.runInContext('loadDietitianScreen()',c);
  assert.equal(c.dietitianHistory.length,0);assert.equal(c.dietitianInput.disabled,true);assert.equal(c.dietitianSendBtn.disabled,true);assert.equal(stopped,1);
  assert.match(nodes['dietitian-messages'].textContent,/недоступен/);
});
test('dietitian profile sends only coarse whitelisted fields',()=>{
  const c=context(['dietitianProfile'],{getCurrentProfile:()=>({name:'Секрет',target_weight_kg:'62',diet_mode:'breastfeeding'}),document:{getElementById:()=>({value:'68.4'})},
    isBreastfeeding:()=>true,babyAgeMonths:()=>4,profileExclusions:()=>['fish'],calcKcalTarget:()=>2100});
  const out=JSON.parse(JSON.stringify(vm.runInContext('dietitianProfile()',c)));
  assert.deepEqual(out,{weightKg:68.4,targetWeightKg:62,kcalPerDay:2100,dietMode:'breastfeeding',babyAgeMonths:4,excludedFoods:['fish']});
  assert.ok(!('name' in out));
});
