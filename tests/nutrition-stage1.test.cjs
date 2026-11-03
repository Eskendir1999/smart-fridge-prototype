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
for (const profile of [null, {age:17}, {age:18}, {age:30,goal:'lose'}, {age:30,diet_mode:'breastfeeding',goal:'lose'}, {age:null}, {age:120}]) {
  test('no energy target for ' + JSON.stringify(profile), () => {
    const c = context(['calcKcalTarget','dietitianProfile','projectGoalDate'], {profile});
    assert.equal(vm.runInContext('calcKcalTarget(profile, 70)',c),null);
    assert.equal(vm.runInContext('dietitianProfile()',c),null);
    assert.equal(vm.runInContext('projectGoalDate([], 40)',c),null);
  });
}
test('all seven adult days have ordinary meals; old fasting choices cannot revive',()=>{
  const c=context(['isAdultNutritionProfile','daySlots','defaultDishId','resolveDish','weekMenu','sanitizeMealChoices'],{
    mealChoices:{7:{f:'f_fast',b:'f_fast'}},profile:{age:30,goal:'lose'},
    dishBlockReason:()=>null,
  });
  const a=html.indexOf('const dietDays = ['), b=html.indexOf('// Нужны каждый день',a);
  vm.runInContext(html.slice(a,b),c);
  const week=vm.runInContext('weekMenu(profile)',c);
  assert.equal(week.length,7);
  for(const day of week){assert.deepEqual(Array.from(day.slots,x=>x.slot),['b','l','d']);for(const e of day.slots)assert.ok(e.dish.title);}
  assert.equal(week[6].slots[0].dish.id,'b_oat');
  assert.equal(JSON.stringify(vm.runInContext('sanitizeMealChoices(mealChoices)',c)),'{}');
  for(const age of [null,17,0,120,'bad']){c.profile={age};assert.equal(vm.runInContext('weekMenu(profile).flatMap(x=>x.slots).length',c),0);}
});
test('rendering ingredients and labels is independent of current and start weight',()=>{
  const container={innerHTML:'',querySelectorAll:()=>[]};
  const nodes={'meals-container':container,'menu-actions':{style:{}},'menu-reset-day-btn':{style:{}}};
  const c=context(['renderDay','mealCardHtml','ingredientsHtml','scaleQty','escapeHtml'],{
    profile:{age:30,start_weight_kg:80},getCurrentProfile(){return this.profile;},
    document:{getElementById:id=>nodes[id]},mealChoices:{},
    weekMenu:()=>[{slots:[{slot:'l',dish:{id:'x',title:'Тест',desc:'Состав',portion:200,items:[{name:'Филе',qty:'200 г'}]}}]}],
    inventoryNames:()=>[],fridgeMatch:()=>({total:0,hits:0}),isBreastfeeding:()=>false,
    allowedDishes:()=>[],SLOT_META:{l:{name:'Обед',icon:''}},renderDayPills(){},renderVarietyHint(){},
  });
  // Weight slider is deliberately absent: rendering must not read it.
  c.getCurrentProfile=()=>c.profile;
  vm.runInContext('renderDay(1)',c);const before=container.innerHTML;
  c.profile.start_weight_kg=0;c.profile.weight=50;
  vm.runInContext('renderDay(1)',c);assert.equal(container.innerHTML,before);
  assert.match(before,/200 г/);assert.doesNotMatch(before,/г белка/);assert.match(before,/Пищевая ценность не рассчитана/);
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
  const c=context(['loadDietitianScreen'],{dietitianHistory:['legacy'],dietitianInput:{},dietitianSendBtn:{},document:{getElementById:id=>nodes[id]},window:{speechSynthesis:{cancel(){stopped++;}}},sb:{from(){throw Error('Must not read account chat');}}});
  await vm.runInContext('loadDietitianScreen()',c);
  assert.equal(c.dietitianHistory.length,0);assert.equal(c.dietitianInput.disabled,true);assert.equal(c.dietitianSendBtn.disabled,true);assert.equal(stopped,1);
  assert.match(nodes['dietitian-messages'].textContent,/отключён/);
});
test('weight hero ignores previous goal and classification',()=>{
  const nodes={};const c=context(['isAdultNutritionProfile','updateDietHero'],{getCurrentProfile:()=>({age:30,goal:'lose',target_weight_kg:40}),document:{getElementById:id=>nodes[id]||=( {style:{},textContent:''})}});
  vm.runInContext('updateDietHero()',c);
  assert.equal(nodes['hero-kcal'].textContent,'—');assert.equal(nodes['hero-imt'].textContent,'—');
  assert.equal(nodes['member-hero-big'].textContent,'Без назначения диеты');
});
test('recipe UI has no fictional protein or active legacy fasting program',()=>{
  assert.doesNotMatch(html,/г белка|f_fast|разгрузочный день/i);
  assert.doesNotMatch(html,/w \/ Number\(profile.start_weight_kg\)/);
});
