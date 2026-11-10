'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { amount, date, evaluateMenu, suggest, shopping, adaptInventory, adaptProfiles, formatAmount } = require('../dinner/model.js');
const { ingredients, recipes } = require('./fixtures/dinner-catalog.json');
const TODAY = '2026-11-02';
const profiles = [{ id: 'p1', householdId: 'h1', exclusions: [], mode: 'standard' }];
const qty = (value, unit = 'g', source = 'measured') => ({ value, unit, source });
const lot = (ingredientId, value, unit = 'g', overrides = {}) => ({ id: ingredientId, ingredientId,
  householdId: 'h1', quantity: qty(value, unit), expiresOn: '2026-11-30', dateSource: 'label', version: 1, ...overrides });
const recipe = (id, lines) => ({ id, version: 1, basePortions: 1, allowedModes: ['standard'], ingredients: lines });
const line = (ingredientId, value, unit = 'g') => ({ ingredientId, quantity: qty(value, unit) });
const meal = (r, overrides = {}) => ({ id: r.id, recipe: r, day: TODAY, portions: 1, ...overrides });
const evaluate = (meals, lots, extra = {}) => evaluateMenu({ meals, lots, ingredients, profiles, householdId: 'h1', ...extra });

test('01 regression: omelette without eggs and with zero expired herbs is never enough', () => {
  const omelette = recipe('omelette', [line('egg', 3, 'pcs'), line('milk', 30, 'ml'), line('butter', 5), line('herbs', 5)]);
  const result = evaluate([meal(omelette)], [lot('herbs', 0, 'g', { expiresOn: '2026-11-01' }), lot('milk', 30, 'ml'), lot('butter', 5)]);
  assert.equal(result.status, 'buy');
  assert.equal(result.lines.find(l => l.ingredientId === 'egg').missingExact, 3000);
  assert.equal(result.lines.find(l => l.ingredientId === 'herbs').knownAllocated, 0);
});
test('02 20 g cheese for seven 30 g portions leaves a 190 g weekly deficit', () => {
  const r = recipe('cheese', [line('cheese', 30)]);
  const meals = Array.from({ length: 7 }, (_, i) => meal(r, { id: 'd' + i, day: '2026-11-0' + (i + 2) }));
  const lots = [lot('cheese', 20)];
  const before = structuredClone(lots);
  const result = evaluate(meals, lots);
  assert.deepEqual(shopping(result), [{ ingredientId: 'cheese', dimension: 'mass', amount: 190000, meals: meals.map(m => m.id) }]);
  assert.equal(result.lines.reduce((n, l) => n + l.knownAllocated, 0), 20000);
  assert.deepEqual(lots, before, 'planning is not eating');
});
test('03 portion changes recompute quantities; fractional count requires clarification', () => {
  const r = recipe('cheese', [line('cheese', 200)]);
  assert.equal(evaluate([meal(r)], [lot('cheese', 300)]).status, 'enough');
  const doubled = evaluate([meal(r, { portions: 2 })], [lot('cheese', 300)]);
  assert.equal(doubled.lines[0].missingExact, 100000);
  const fractionalEgg = { ...recipe('egg', [line('egg', 1, 'pcs')]), basePortions: 2 };
  assert.equal(evaluate([meal(fractionalEgg)], [lot('egg', 5, 'pcs')]).status, 'clarify');
});
test('04 explicit recipe variant recalculates ingredients, exclusions and steps', () => {
  const p = [{ id: 'p1', householdId: 'h1', exclusions: ['dairy'], mode: 'standard' }];
  const lots = [lot('egg', 2, 'pcs'), lot('cucumber', 150)];
  assert.equal(evaluate([meal(recipes[0])], lots, { profiles: p }).blocked.length, 1);
  const variant = recipes.find(r => r.id === 'egg-cucumber');
  const result = evaluate([meal(variant)], lots, { profiles: p });
  assert.equal(result.status, 'enough');
  assert.deepEqual(result.lines.map(l => l.ingredientId), ['egg', 'cucumber']);
  assert.match(variant.steps[0], /яйца/);
  assert.equal(evaluate([meal(variant)], lots, { profiles: [{ ...p[0], exclusions: ['egg'] }] }).blocked.length, 1);
});
test('05 every selected profile and ingredient metadata gates recipes before ranking', () => {
  const p = [...profiles, { id: 'p2', householdId: 'h1', exclusions: ['egg'], mode: 'standard' }];
  const r = recipes.find(r => r.id === 'egg-cucumber');
  const result = evaluate([meal(r)], [lot('egg', 2, 'pcs'), lot('cucumber', 150)], { profiles: p });
  assert.deepEqual(result.blocked[0].reasons, ['excluded:p2:egg']);
  assert.equal(result.status, null);
  assert.equal(evaluate([meal(r)], [], { profiles: [{ ...profiles[0], mode: 'breastfeeding' }] }).blocked.length, 1);
  assert.equal(evaluate([meal(r)], [], { ingredients: { ...ingredients, egg: { tags: ['egg'] } } }).blocked.length, 1);
  assert.equal(evaluate([meal(r)], [], { profiles: [] }).blocked.length, 1);
});
test('06 dates and FEFO: expired freezer lot excluded, future menu checks cooking date', () => {
  const r = recipe('cheese', [line('cheese', 30)]);
  const lots = [lot('cheese', 500, 'g', { id: 'expired', expiresOn: '2026-11-01', compartment: 'freezer' }),
    lot('cheese', 20, 'g', { id: 'soon', expiresOn: TODAY }), lot('cheese', 50, 'g', { id: 'later', expiresOn: '2026-11-03' })];
  const result = evaluate([meal(r), meal(r, { id: 'future', day: '2026-11-04' })], lots);
  assert.deepEqual(result.lines[0].allocations.map(a => [a.lotId, a.amount]), [['soon', 20000], ['later', 10000]]);
  assert.equal(result.lines[1].missingExact, 30000);
  assert.ok(result.lines[0].excludedLots.some(l => l.id === 'expired'));
  for (const overrides of [{ dateSource: 'catalog_estimate' }, { dateSource: 'legacy_unknown' }, { expiresOn: null }, { expiresOn: '2026-02-30' }]) {
    assert.equal(evaluate([meal(r)], [lot('cheese', 50, 'g', overrides)]).status, 'clarify');
  }
  assert.equal(date('2026-02-30'), false);
});
test('07 unknown quantity never invents an exact deficit; known sufficient lots remain enough', () => {
  const r = recipe('cheese', [line('cheese', 30)]);
  const unknown = lot('cheese', null, 'g', { id: 'unknown' });
  const result = evaluate([meal(r)], [lot('cheese', 20), unknown]);
  assert.equal(result.status, 'clarify'); assert.equal(result.lines[0].shortfall, 10000);
  assert.equal(result.lines[0].missingExact, null); assert.deepEqual(shopping(result), []);
  assert.ok(result.lines[0].uncertainLots[0].reasons.includes('quantity_unknown_or_invalid'));
  assert.equal(evaluate([meal(r)], [lot('cheese', 30), unknown]).status, 'enough');
  assert.equal(evaluate([meal(r)], [lot('cheese', 100, 'g', { quantity: qty(100, 'g', 'catalog_default') })]).status, 'clarify');
});
test('08 units: kg/g and l/ml convert exactly; pcs/g, ml/g and spoon assumptions fail closed', () => {
  assert.deepEqual(amount(qty('0.2', 'kg')), amount(qty(200, 'g')));
  assert.deepEqual(amount(qty('0.005', 'l')), amount(qty(5, 'ml')));
  for (const invalid of [qty(-1), qty(NaN), qty(Infinity), qty('1oops'), qty('0x10'), qty(1, 'pack'), qty(1, 'tbsp'), qty(0.5, 'pcs')]) assert.equal(amount(invalid), null);
  const r = recipe('tomato', [line('tomato', 150)]);
  for (const unit of ['pcs', 'ml']) assert.equal(evaluate([meal(r)], [lot('tomato', 2, unit)]).status, 'clarify');
});
test('09 up to three explained alternatives; no fallback to blocked dishes and no reservation', () => {
  const lots = [lot('egg', 20, 'pcs'), lot('cheese', 200), lot('cucumber', 1000), lot('tomato', 1000), lot('oil', 100, 'ml')];
  const context = { recipes, day: TODAY, portions: 1, lots, profiles, ingredients, householdId: 'h1' };
  const before = structuredClone(lots);
  const result = suggest(context);
  assert.equal(result.length, 3); assert.ok(result.every(r => r.result.status === 'enough' && r.result.lines.every(l => l.allocations.length)));
  assert.deepEqual(lots, before);
  assert.deepEqual(suggest({ ...context, profiles: [{ ...profiles[0], mode: 'unreviewed_mode' }] }), []);
  assert.equal(suggest({ ...context, recipes: [recipes[0]] }).length, 1);
  assert.throws(() => evaluate([], lots), /meals_required/);
  assert.equal(evaluate([meal(recipe('empty', []))], lots).blocked.length, 1);
  assert.throws(() => evaluate([meal(recipes[0]), meal(recipes[0])], lots), /duplicate_meal_id/);
  assert.throws(() => evaluate([meal(recipes[0])], [...lots, lots[0]]), /duplicate_or_missing_lot_id/);
});
test('10 shopping contains measured deficits, recomputation replaces generated demand', () => {
  const r = recipe('cheese', [line('cheese', 30), line('cheese', 10)]);
  const result = evaluate([meal(r)], [lot('cheese', 20)]);
  assert.deepEqual(shopping(result), [{ ingredientId: 'cheese', dimension: 'mass', amount: 20000, meals: ['cheese'] }]);
  assert.deepEqual(shopping(result), shopping(result), 'same scope yields identical desired demand, never +=');
  assert.deepEqual(shopping(evaluate([meal(r)], [lot('cheese', 40)])), []);
});

test('saved DB rows: strings, Russian units, zero and explicit provenance are preserved', () => {
  const rows = [{ id: 'a', household_id: 'h1', name: 'Сыр', ingredient_id: 'cheese', qty_num: '0.200', unit: 'кг',
    quantity_source: 'measured', expires_on: '2026-11-20', date_source: 'label' },
  { id: 'b', household_id: 'h1', name: 'Сыр', ingredient_id: 'cheese', qty_num: 0, unit: 'г', qtyNum: 500 },
  { id: 'foreign', household_id: 'h2', name: 'Сыр', qty_num: 1000, unit: 'кг' }];
  const before = structuredClone(rows);
  const lots = adaptInventory({ rows, householdId: 'h1', confirmed: true });
  assert.equal(lots.length, 2); assert.equal(lots[1].quantity.value, 0);
  assert.equal(lots[0].quantity.source, 'measured'); assert.equal(lots[0].dateSource, 'label');
  assert.equal(evaluate([meal(recipe('cheese', [line('cheese', 200)]))], lots).status, 'enough');
  assert.deepEqual(rows, before);
  assert.throws(() => adaptInventory({ rows, householdId: 'h1' }), /invalid_inventory_snapshot/);
  assert.throws(() => adaptInventory({ rows: [{ _id: 'old-ui-shape', name: 'Сыр', qtyNum: 500, unit: 'г' }], householdId: 'h1', confirmed: true }), /inventory_household_missing/);
});
test('legacy DB defaults and false expiry flag do not become measured quantities or label dates', () => {
  const lots = adaptInventory({ confirmed: true, householdId: 'h1', rows: [
    { id: 'a', household_id: 'h1', name: 'Твёрдый сыр', ingredient_id: 'cheese', qty_num: 500, unit: 'г', expires_on: '2026-11-20', expiry_estimated: false },
  ] });
  assert.equal(lots[0].quantity.source, 'legacy_unknown'); assert.equal(lots[0].dateSource, 'legacy_unknown');
  const result = evaluate([meal(recipe('cheese', [line('cheese', 30)]))], lots);
  assert.equal(result.status, 'clarify'); assert.equal(result.lines[0].missingExact, null);
});
test('saved UI shape uses _id/qtyNum and explicit sources without quantity or date fallbacks', () => {
  const lots = adaptInventory({ confirmed: true, householdId: 'h1', rows: [
    { _id: 'a', householdId: 'h1', name: 'Сыр', ingredientId: 'cheese', qtyNum: 50, unit: 'г',
      quantitySource: 'user', expiresOn: '2026-11-20', dateSource: 'user' },
    { _id: 'b', householdId: 'h1', name: 'Сыр', ingredientId: 'cheese', qtyNum: null, unit: 'упак', expiresOn: null },
  ] });
  assert.equal(lots[0].id, 'a'); assert.equal(lots[0].dateSource, 'user');
  assert.equal(lots[1].quantity.value, null); assert.equal(lots[1].quantity.unit, null); assert.equal(lots[1].expiresOn, null);
  assert.equal(evaluate([meal(recipe('cheese', [line('cheese', 50)]))], lots).status, 'enough');
});
test('estimated flag wins over contradictory explicit dateSource', () => {
  const [l] = adaptInventory({ confirmed: true, householdId: 'h1', rows: [
    { id: 'a', household_id: 'h1', name: 'Сыр', qty_num: 50, unit: 'г', ingredient_id: 'cheese',
      quantity_source: 'measured', expires_on: '2026-11-20', date_source: 'label', expiry_estimated: true },
  ] });
  assert.equal(l.dateSource, 'catalog_estimate');
  assert.equal(evaluate([meal(recipe('cheese', [line('cheese', 30)]))], [l]).status, 'clarify');
});
test('only exact curated aliases map identities; substring and object prototype never match', () => {
  const rows = ['  ТВЁРДЫЙ   СЫР  ', 'Сыр творожный', 'constructor'].map((name, i) => ({ id: String(i), household_id: 'h1', name, qty_num: 30, unit: 'г' }));
  const lots = adaptInventory({ confirmed: true, householdId: 'h1', rows, aliases: { 'твердый сыр': 'cheese' } });
  assert.equal(lots[0].ingredientId, 'cheese'); assert.equal(lots[1].ingredientId, null); assert.equal(lots[2].ingredientId, null);
  const result = evaluate([meal(recipe('cheese', [line('cheese', 30)]))], lots);
  assert.deepEqual(result.unresolvedLots, ['1', '2']);
  assert.equal(result.status, 'clarify'); assert.deepEqual(shopping(result), []);
});
test('family profile adapter preserves selected members and fails on missing/foreign/ambiguous identity', () => {
  const rows = [{ id: 'p1', household_id: 'h1', diet_mode: 'standard', excluded_foods: ['dairy'] },
    { id: 'p2', household_id: 'h2', diet_mode: 'standard', excluded_foods: [] }];
  const selected = adaptProfiles({ rows, profileIds: ['p1'], householdId: 'h1' });
  assert.deepEqual(selected, [{ id: 'p1', householdId: 'h1', mode: 'standard', exclusions: ['dairy'] }]);
  selected[0].exclusions.push('egg'); assert.deepEqual(rows[0].excluded_foods, ['dairy']);
  for (const profileIds of [[], ['p1', 'p1'], ['p2'], ['missing']]) assert.throws(() => adaptProfiles({ rows, profileIds, householdId: 'h1' }));
  assert.throws(() => adaptProfiles({ rows: [rows[0], rows[0]], profileIds: ['p1'], householdId: 'h1' }), /ambiguous/);
  assert.throws(() => evaluate([meal(recipes[0])], [], { profiles: [{ ...profiles[0], householdId: 'h2' }] }), /invalid_profile_context/);
});
test('missing profile columns and unsupported exclusions block instead of silently assuming standard', () => {
  const selected = adaptProfiles({ rows: [{ id: 'p1', household_id: 'h1' }], profileIds: ['p1'], householdId: 'h1' });
  assert.equal(evaluate([meal(recipes[0])], [], { profiles: selected }).status, null);
  for (const excluded of [['unknown_allergen'], 'dairy', null]) {
    const result = evaluate([meal(recipes[0])], [], { profiles: [{ ...profiles[0], exclusions: excluded }] });
    assert.ok(result.blocked[0].reasons.some(r => r.startsWith('profile_incomplete')));
    assert.throws(() => shopping(result), /blocked_or_invalid_menu/);
  }
});
test('malformed recipe metadata cannot bypass the common eligibility filter', () => {
  for (const allowedModes of ['standard', null, {}]) {
    assert.equal(evaluate([meal({ ...recipes[0], allowedModes })], []).status, null);
  }
  for (const tags of [undefined, {}, ['unknown_allergen']]) {
    assert.equal(evaluate([meal(recipes[0])], [], { ingredients: { ...ingredients, cheese: { allergensReviewed: true, tags } } }).status, null);
  }
});
test('strict quantity parser rejects inherited units, object coercion, unsafe and overprecise values', () => {
  for (const q of [qty(1, '__proto__'), qty(1, 'constructor'), qty({ toString: () => '10' }),
    qty('9007199254740.992'), qty('0.0001'), qty(true), qty('1e3'), qty(' 1 '), qty('1,5')]) assert.equal(amount(q), null);
  assert.equal(amount(qty('9007199254740.991')).value, Number.MAX_SAFE_INTEGER);
  assert.equal(amount(qty('0.001', 'kg')).value, 1000);
});
test('portion arithmetic and duplicate requirement overflow never round down into enough', () => {
  const r = { ...recipe('large', [line('cheese', '9007199254740.991')]), basePortions: 2 };
  const lots = [lot('cheese', '9007199254740.991')];
  assert.equal(evaluate([meal(r)], lots).status, 'clarify', 'half of a milli-unit is not rounded');
  assert.equal(evaluate([meal({ ...r, basePortions: 1 }, { portions: 2 })], lots).status, 'clarify');
  const duplicate = recipe('large', [line('cheese', '9007199254740.991'), line('cheese', 1)]);
  assert.equal(evaluate([meal(duplicate)], lots).status, 'clarify');
  assert.equal(evaluate([meal(r, { portions: 2 })], lots).status, 'enough', 'BigInt multiplication avoids intermediate rounding');
});
test('shopping aggregation rejects overflow across otherwise valid meals', () => {
  const r = recipe('large', [line('cheese', '9007199254740.991')]);
  const result = evaluate([meal(r, { id: 'a' }), meal(r, { id: 'b' })], []);
  assert.throws(() => shopping(result), /quantity_overflow/);
});
test('deterministic FEFO and chronological allocation do not mutate frozen input snapshots', () => {
  const r = recipe('cheese', [line('cheese', 30)]);
  const meals = [meal(r, { id: 'later', day: '2026-11-03' }), meal(r, { id: 'first' })];
  const lots = [lot('cheese', 30, 'g', { id: 'z', expiresOn: '2026-11-03' }), lot('cheese', 30, 'g', { id: 'a', expiresOn: '2026-11-03' })];
  const freeze = object => { if (object && typeof object === 'object') { Object.values(object).forEach(freeze); Object.freeze(object); } return object; };
  freeze(lots); freeze(meals);
  const result = evaluate(meals, lots);
  assert.deepEqual(result.lines.map(l => [l.mealId, l.allocations[0].lotId]), [['first', 'a'], ['later', 'z']]);
  assert.deepEqual(result, evaluate([...meals].reverse(), [...lots].reverse()));
});
test('allocation conserves stock over varied deterministic weekly quantities and portion counts', () => {
  for (let available = 0; available <= 100; available += 7) {
    for (const portions of [1, 2, 3]) {
      const r = recipe('cheese', [line('cheese', 15)]);
      const result = evaluate(Array.from({ length: 7 }, (_, i) => meal(r, { id: 'd' + i, portions })), [lot('cheese', available)]);
      const allocated = result.lines.reduce((n, l) => n + l.knownAllocated, 0);
      const missing = result.lines.reduce((n, l) => n + l.missingExact, 0);
      assert.equal(allocated, Math.min(available, 7 * 15 * portions) * 1000);
      assert.equal(allocated + missing, 7 * 15 * portions * 1000);
    }
  }
});
test('Russian amount presentation keeps dimensions and exact thousandths without density estimates', () => {
  assert.equal(formatAmount(190000, 'mass'), '190 г');
  assert.equal(formatAmount(1234, 'volume'), '1,234 мл');
  assert.equal(formatAmount(2000, 'count'), '2 шт');
  for (const args of [[-1, 'mass'], [NaN, 'mass'], [1500, 'count'], [1000, 'kg']]) assert.throws(() => formatAmount(...args));
});
test('same public module loads in browser scope and CommonJS with matching results', () => {
  const source = fs.readFileSync(path.join(__dirname, '../dinner/model.js'), 'utf8');
  const browser = vm.createContext({ structuredClone });
  vm.runInContext(source, browser);
  const input = { meals: [meal(recipes[0])], lots: [lot('cheese', 20), lot('cucumber', 150)], profiles, ingredients, householdId: 'h1' };
  assert.deepEqual(JSON.parse(JSON.stringify(browser.SFDinner.evaluateMenu(input))), evaluateMenu(input));
  assert.equal(browser.SFDinner.formatAmount(1000, 'mass'), '1 г');
  assert.ok(Object.isFrozen(browser.SFDinner));
});
test('explicit null DB fields cannot resurrect stale camelCase quantities, dates or profile settings', () => {
  const [l] = adaptInventory({ confirmed: true, householdId: 'h1', rows: [
    { id: 'a', household_id: 'h1', ingredient_id: 'cheese', qty_num: null, qtyNum: 500, unit: 'г',
      expires_on: null, expiresOn: '2026-11-30', quantity_source: 'measured', date_source: 'label' },
  ] });
  assert.equal(l.quantity.value, null); assert.equal(l.expiresOn, null);
  assert.equal(evaluate([meal(recipe('cheese', [line('cheese', 30)]))], [l]).status, 'clarify');
  const [p] = adaptProfiles({ householdId: 'h1', profileIds: ['p1'], rows: [
    { id: 'p1', household_id: 'h1', diet_mode: null, mode: 'standard', excluded_foods: null, exclusions: [] },
  ] });
  assert.equal(p.mode, null); assert.equal(p.exclusions, null);
});
test('unmapped zero or expired stock cannot create uncertainty about an otherwise exact deficit', () => {
  const r = recipe('cheese', [line('cheese', 30)]);
  const lots = [lot(null, 0, 'g', { id: 'zero' }), lot(null, 500, 'g', { id: 'expired', expiresOn: '2026-11-01' })];
  const result = evaluate([meal(r)], lots);
  assert.equal(result.status, 'buy'); assert.equal(result.lines[0].missingExact, 30000);
});

test('explicitly excluded unsupported inventory does not invent identity or block exact deficits',()=>{
 const [unsupported]=adaptInventory({confirmed:true,householdId:'h1',rows:[{id:'unknown',household_id:'h1',name:'Продукт вне каталога',qty_num:500,unit:'г',dinner_excluded:true}]});
 assert.equal(unsupported.ingredientId,null);assert.equal(unsupported.quantity.source,'legacy_unknown');
 const result=evaluate([meal(recipe('cheese',[line('cheese',30)]))],[unsupported]);assert.equal(result.status,'buy');assert.equal(result.lines[0].missingExact,30000);
 assert.equal(evaluate([meal(recipe('cheese',[line('cheese',30)]))],[{...unsupported,excludedFromDinner:false}]).status,'clarify');
});
test('private profile projection requires the confirmed actor and explicit stock scope',()=>{
 const own={id:'p',profile_owner_user_id:'u',stock_scope_id:'h1',diet_mode:'standard',excluded_foods:[]};
 assert.equal(adaptProfiles({rows:[own],profileIds:['p'],householdId:'h1',userId:'u'})[0].id,'p');
 for(const row of [{...own,profile_owner_user_id:'b'},{...own,profile_owner_user_id:null},{...own,stock_scope_id:'h2'},{id:'p',household_id:'h1',created_by:'u',diet_mode:'standard',excluded_foods:[]}])
   assert.throws(()=>adaptProfiles({rows:[row],profileIds:['p'],householdId:'h1',userId:'u'}),/missing_or_ambiguous/);
});
