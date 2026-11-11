const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../dinner/model.js');
const catalog = require('../dinner/catalog.json');
const legacy = require('./fixtures/dinner-catalog.json');
const day = '2026-11-11', householdId = 'fixture-household';
const profile = { id: 'fixture-private-profile', householdId, mode: 'standard', exclusions: [] };
const lot = (id, ingredientId, value, unit = 'g', extras = {}) => ({
  id, householdId, ingredientId, quantity: { value, unit, source: 'measured' },
  expiresOn: day, dateSource: 'label', version: 1, ...extras,
});
const select = (selection, lots = [], profiles = [profile]) =>
  M.selectMeals({ selection, catalog, day, householdId, profiles, lots });

test('web and Telegram share a strict selection and round-trip a link without private context', () => {
  assert.deepEqual(M.mealSelectionFromQuery('?open=dinner'), { meal: 'dinner', cuisine: 'any', portions: 1 });
  const selection = { meal: 'breakfast', cuisine: 'japanese', portions: 2 };
  assert.equal(M.mealSelectionQuery(selection), '?open=dinner&meal=breakfast&cuisine=japanese&portions=2');
  assert.deepEqual(M.mealSelectionFromQuery(M.mealSelectionQuery(selection) + '&profile_id=ignored'), selection);
  for (const query of ['?meal=brunch', '?meal=', '?cuisine=unknown', '?meal=lunch&meal=lunch',
    '?cuisine=any&cuisine=japanese', '?portions=0', '?portions=101', '?portions=2.0', '?portions=02', '?portions=1e1']) {
    assert.throws(() => M.mealSelectionFromQuery(query), /invalid_|duplicate_/);
  }
  assert.throws(() => M.mealSelection({ portions: '2' }), /invalid_portions/);
});

test('meal and cuisine filters never silently fall back and recommendations are capped at three', () => {
  const expected = { breakfast: 'tamagoyaki-rice', lunch: 'salmon-onigiri', dinner: 'shiozake-rice' };
  for (const [meal, recipeId] of Object.entries(expected)) {
    assert.deepEqual(select({ meal, cuisine: 'japanese' }).options.map(r => r.recipeId), [recipeId]);
    const home = select({ meal, cuisine: 'home' });
    assert.ok(home.options.every(r => r.cuisine === 'home'));
    const any = select({ meal, cuisine: 'any' });
    assert.equal(any.options.length, 3);
    assert.ok(any.eligibleRecipeIds.includes(recipeId));
    assert.ok(any.options.every(r => catalog.recipes.find(v => v.id === r.recipeId).mealTypes.includes(meal)));
  }
  assert.equal(M.selectMeals({ catalog: { ...legacy, version: 1 }, selection: { meal: 'breakfast' },
    householdId, day, lots: [], profiles: [profile] }).status, 'no_recipes');
});

test('Japanese breakfast for two gives exact per-item deficits without leaking profiles or lots', () => {
  const result = select({ meal: 'breakfast', cuisine: 'japanese', portions: 2 }, [
    lot('private-lot-id', 'short-grain-rice', '0.05', 'kg'),
    lot('eggs', 'egg', 3, 'pcs'),
    lot('outside', 'egg', 8, 'pcs', { householdId: 'outside' }),
    lot('expired', 'short-grain-rice', 200, 'g', { expiresOn: '2026-11-10' }),
  ]);
  const [option] = result.options;
  assert.equal(option.status, 'buy');
  const rice = option.lines.find(r => r.ingredientId === 'short-grain-rice');
  assert.equal(rice.required, 120000);
  assert.equal(rice.knownAllocated, 50000);
  assert.equal(rice.missingExact, 70000);
  assert.equal(M.formatAmount(rice.missingExact, rice.dimension), '70 г');
  assert.equal(option.lines.find(r => r.ingredientId === 'egg').missingExact, 1000);
  assert.doesNotMatch(JSON.stringify(result), /private-lot-id|fixture-private-profile|fixture-household|allocations|shortfall/);
});

test('an unknown measure or estimated expiry never becomes a made-up exact shortage', () => {
  const result = select({ meal: 'breakfast', cuisine: 'japanese', portions: 2 }, [
    lot('rice', 'short-grain-rice', 50),
    lot('unknown', 'short-grain-rice', null),
    lot('old-estimate', 'egg', 2, 'pcs', { dateSource: 'catalog_estimate', expiresOn: '2026-11-01' }),
    lot('wrong-unit', 'neutral-oil', 100, 'g'),
  ]);
  const [option] = result.options;
  assert.equal(option.status, 'clarify');
  for (const id of ['short-grain-rice', 'egg', 'neutral-oil']) {
    const line = option.lines.find(r => r.ingredientId === id);
    assert.equal(line.missingExact, null);
    assert.equal(line.status, 'clarify');
  }
  assert.equal(option.lines.find(r => r.ingredientId === 'sugar').missingExact, 10000);
});

test('all selected profiles constrain the result; unsupported restrictions never fall back', () => {
  for (const [meal, excluded] of [['breakfast','egg'], ['lunch','fish'], ['dinner','fish']]) {
    assert.equal(select({ meal, cuisine: 'japanese' }, [], [profile,
      { ...profile, id: 'second', exclusions: [excluded] }]).status, 'no_eligible_recipes');
  }
  for (const p of [{ ...profile, exclusions: ['soy'] }, { ...profile, mode: 'breastfeeding' }]) {
    assert.equal(select({ meal: 'breakfast' }, [], [p]).options.length, 0);
  }
});

test('catalogue keeps the existing recipes and uses canonical measures for each ingredient', () => {
  const knownUnits = new Map();
  for (const old of legacy.recipes) {
    const { mealTypes, cuisine, ...current } = catalog.recipes.find(r => r.id === old.id);
    assert.deepEqual(current, old);
  }
  for (const r of catalog.recipes) {
    assert.ok(r.mealTypes.length && r.mealTypes.every(m => Object.hasOwn(M.mealTypes, m)));
    assert.ok(r.cuisine !== 'any' && Object.hasOwn(M.cuisines, r.cuisine));
    assert.ok(r.steps.length && r.ingredients.length);
    for (const { ingredientId, quantity } of r.ingredients) {
      assert.equal(catalog.ingredients[ingredientId].allergensReviewed, true);
      assert.ok(M.amount(quantity)?.value > 0);
      assert.ok(['g', 'ml', 'pcs'].includes(quantity.unit));
      if (knownUnits.has(ingredientId)) assert.equal(knownUnits.get(ingredientId), quantity.unit);
      knownUnits.set(ingredientId, quantity.unit);
    }
  }
});
