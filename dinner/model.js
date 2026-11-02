/* Pure dinner coverage. No network, persistence or inventory mutations. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SFDinner = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
'use strict';
const units = {
  g: ['mass', 1000], kg: ['mass', 1000000],
  ml: ['volume', 1000], l: ['volume', 1000000], pcs: ['count', 1000],
};
const labels = { enough: 'достаточно', buy: 'докупить', clarify: 'количество нужно уточнить' };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const id = value => typeof value === 'string' && value.trim().length > 0;
const exclusions = new Set(['dairy', 'egg', 'fish', 'nuts', 'gluten']);
const listOfStrings = values => Array.isArray(values) && values.every(id);
const field = (row, primary, alternate, fallback = null) => own(row, primary) ? row[primary] : own(row, alternate) ? row[alternate] : fallback;
function requireInput(ok, code) { if (!ok) throw new TypeError(code); }
function safeAdd(a, b) {
  const sum = a + b;
  requireInput(Number.isSafeInteger(sum), 'quantity_overflow');
  return sum;
}
function amount(quantity) {
  if (!quantity || !own(units, quantity.unit) || quantity.value == null) return null;
  if (!['number', 'string'].includes(typeof quantity.value)) return null;
  const raw = String(quantity.value);
  if (raw.length > 24 || !/^\d+(?:\.\d{1,3})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  const thousandths = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  const [dimension, factor] = units[quantity.unit];
  const exact = thousandths * BigInt(factor / 1000);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const value = Number(exact);
  if (!Number.isSafeInteger(value) || value < 0 || (dimension === 'count' && value % 1000)) return null;
  return { dimension, value };
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = new Date(value + 'T00:00:00Z');
  return Number.isFinite(time.valueOf()) && time.toISOString().slice(0, 10) === value;
}
function blockReasons(recipe, profiles, ingredients) {
  const reasons = [];
  if (!recipe.ingredients.length) reasons.push('recipe_ingredients_required');
  if (!profiles.length) reasons.push('profile_required');
  for (const p of profiles) {
    if (!listOfStrings(p.exclusions) || p.exclusions.some(tag => !exclusions.has(tag))
      || !['standard', 'breastfeeding'].includes(p.mode)) reasons.push('profile_incomplete:' + p.id);
    if (!listOfStrings(recipe.allowedModes) || !recipe.allowedModes.includes(p.mode)) reasons.push('mode:' + p.id);
    for (const line of recipe.ingredients) {
      const ingredient = own(ingredients, line.ingredientId) ? ingredients[line.ingredientId] : null;
      if (!ingredient || ingredient.allergensReviewed !== true || !listOfStrings(ingredient.tags)
        || ingredient.tags.some(tag => !exclusions.has(tag))) {
        reasons.push('ingredient_metadata:' + line.ingredientId); continue;
      }
      if (ingredient.tags.some(tag => Array.isArray(p.exclusions) && p.exclusions.includes(tag))) reasons.push('excluded:' + p.id + ':' + line.ingredientId);
    }
  }
  return [...new Set(reasons)];
}
function classifyLot(lot, day, dimension) {
  const q = amount(lot.quantity);
  if (q && q.value === 0) return 'excluded';
  if (date(lot.expiresOn) && lot.expiresOn < day) return 'expired';
  if (!q || q.dimension !== dimension || !['measured', 'user'].includes(lot.quantity.source)
    || !date(lot.expiresOn) || !['label', 'user'].includes(lot.dateSource)) return 'uncertain';
  return 'usable';
}
function evaluateMenu({ meals, lots, profiles, ingredients, householdId }) {
  requireInput(id(householdId), 'household_required');
  requireInput(Array.isArray(meals) && meals.length <= 100 && Array.isArray(lots) && lots.length <= 500
    && Array.isArray(profiles) && profiles.length <= 30 && ingredients && typeof ingredients === 'object', 'invalid_context');
  if (!meals.length) throw Error('meals_required');
  requireInput(meals.every(m => m && id(m.id) && date(m.day) && Number.isSafeInteger(m.portions) && m.portions > 0 && m.portions <= 1000
    && m.recipe && id(m.recipe.id) && Number.isSafeInteger(m.recipe.version) && m.recipe.version > 0
    && Number.isSafeInteger(m.recipe.basePortions) && m.recipe.basePortions > 0 && m.recipe.basePortions <= 1000
    && Array.isArray(m.recipe.ingredients) && m.recipe.ingredients.length <= 100
    && m.recipe.ingredients.every(l => l && id(l.ingredientId))), 'invalid_meal');
  requireInput(profiles.every(p => p && id(p.id) && p.householdId === householdId)
    && new Set(profiles.map(p => p.id)).size === profiles.length, 'invalid_profile_context');
  if (new Set(meals.map(m => m.id)).size !== meals.length) throw Error('duplicate_meal_id');
  requireInput(lots.every(l => l && typeof l === 'object'), 'invalid_lot');
  const working = structuredClone(lots.filter(l => l.householdId === householdId));
  const ids = working.map(l => l.id);
  if (!ids.every(id) || new Set(ids).size !== ids.length) throw Error('duplicate_or_missing_lot_id');
  const unresolvedLots = working.filter(l => !id(l.ingredientId)).map(l => l.id);
  const remaining = new Map(working.map(l => [l.id, amount(l.quantity)?.value || 0]));
  const lines = [], blocked = [];
  for (const meal of [...meals].sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id))) {
    if (!date(meal.day) || !Number.isInteger(meal.portions) || meal.portions < 1
      || !Number.isInteger(meal.recipe.basePortions) || meal.recipe.basePortions < 1) throw Error('invalid_meal');
    const reasons = blockReasons(meal.recipe, profiles, ingredients);
    if (reasons.length) { blocked.push({ mealId: meal.id, reasons }); continue; }
    // Aggregate duplicate ingredient lines before allocation.
    const requirements = new Map();
    for (const line of meal.recipe.ingredients) {
      const q = amount(line.quantity);
      const numerator = q ? BigInt(q.value) * BigInt(meal.portions) : null;
      const divisor = BigInt(meal.recipe.basePortions);
      const scaled = numerator !== null && numerator % divisor === 0n && numerator / divisor <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(numerator / divisor) : null;
      const valid = q && q.value > 0 && Number.isSafeInteger(scaled) && (q.dimension !== 'count' || scaled % 1000 === 0);
      const key = line.ingredientId + ':' + (q?.dimension || line.quantity?.unit || 'unknown');
      const previous = requirements.get(key);
      const total = valid && previous?.required !== null ? (previous?.required || 0) + scaled : null;
      requirements.set(key, { ingredientId: line.ingredientId, dimension: q?.dimension,
        required: Number.isSafeInteger(total) ? total : null });
    }
    for (const req of requirements.values()) {
      const unresolvedOnDay = working.some(l => !id(l.ingredientId) && amount(l.quantity)?.value !== 0
        && !(date(l.expiresOn) && l.expiresOn < meal.day));
      let shortfall = req.required, uncertain = req.required === null || unresolvedOnDay;
      const allocations = [], excludedLots = [], uncertainLots = [];
      const candidates = working.filter(l => l.ingredientId === req.ingredientId)
        .sort((a, b) => String(a.expiresOn || '9999').localeCompare(String(b.expiresOn || '9999')) || a.id.localeCompare(b.id));
      for (const lot of candidates) {
        const state = classifyLot(lot, meal.day, req.dimension);
        if (state === 'uncertain') {
          uncertain = true;
          const q = amount(lot.quantity), reasons = [];
          if (!q) reasons.push('quantity_unknown_or_invalid');
          if (q && q.dimension !== req.dimension) reasons.push('unit_incompatible');
          if (!['measured', 'user'].includes(lot.quantity?.source)) reasons.push('quantity_source_unconfirmed');
          if (!date(lot.expiresOn)) reasons.push('date_unknown_or_invalid');
          if (!['label', 'user'].includes(lot.dateSource)) reasons.push('date_source_unconfirmed');
          uncertainLots.push({ id: lot.id, reasons }); continue;
        }
        if (state !== 'usable') { excludedLots.push({ id: lot.id, reason: state }); continue; }
        if (shortfall == null || shortfall <= 0) continue;
        const used = Math.min(shortfall, remaining.get(lot.id));
        if (used > 0) {
          remaining.set(lot.id, remaining.get(lot.id) - used); shortfall -= used;
          allocations.push({ lotId: lot.id, amount: used, expectedVersion: lot.version });
        }
      }
      const status = shortfall === 0 ? 'enough' : uncertain ? 'clarify' : 'buy';
      lines.push({ mealId: meal.id, ...req, knownAllocated: allocations.reduce((n, a) => n + a.amount, 0),
        shortfall, missingExact: status === 'buy' ? shortfall : status === 'enough' ? 0 : null,
        status, label: labels[status], allocations, excludedLots, uncertainLots });
    }
  }
  const status = blocked.length ? null : lines.some(l => l.status === 'clarify') ? 'clarify'
    : lines.some(l => l.status === 'buy') ? 'buy' : 'enough';
  return { householdId, profileIds: profiles.map(p => p.id), status, label: labels[status] || null, lines, blocked, unresolvedLots };
}
function suggest({ recipes, day, portions, ...context }) {
  requireInput(Array.isArray(recipes) && recipes.length <= 100 && new Set(recipes.map(r => r.id)).size === recipes.length, 'invalid_recipes');
  return recipes.map(recipe => ({ recipeId: recipe.id, result: evaluateMenu({ ...context,
    meals: [{ id: recipe.id, recipe, day, portions }] }) }))
    .filter(r => !r.result.blocked.length)
    .sort((a, b) => {
      const order = { enough: 0, buy: 1, clarify: 2 };
      const missingCount = r => r.result.lines.filter(l => l.status !== 'enough').length;
      return order[a.result.status] - order[b.result.status] || missingCount(a) - missingCount(b) || a.recipeId.localeCompare(b.recipeId);
    }).slice(0, 3);
}
function shopping(result) {
  requireInput(result && Array.isArray(result.blocked) && !result.blocked.length && Array.isArray(result.lines), 'blocked_or_invalid_menu');
  const totals = new Map();
  for (const line of result.lines.filter(l => l.status === 'buy')) {
    const key = line.ingredientId + ':' + line.dimension;
    const current = totals.get(key) || { ingredientId: line.ingredientId, dimension: line.dimension, amount: 0, meals: [] };
    current.amount = safeAdd(current.amount, line.missingExact); current.meals.push(line.mealId); totals.set(key, current);
  }
  return [...totals.values()];
}
// Reads DB rows or the app's camelCase inventory shape. Provenance is never inferred
// from a catalogue quantity or a default false expiry flag. Input must be a saved snapshot.
function adaptInventory({ rows, householdId, confirmed, aliases = {} }) {
  requireInput(confirmed === true && Array.isArray(rows) && id(householdId), 'invalid_inventory_snapshot');
  requireInput(rows.every(row => row && id(field(row, 'household_id', 'householdId'))), 'inventory_household_missing');
  const unitNames = { 'г': 'g', 'кг': 'kg', 'мл': 'ml', 'л': 'l', 'шт': 'pcs' };
  const normalizeName = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ') : '';
  return rows.filter(row => row && field(row, 'household_id', 'householdId') === householdId).map(row => {
    const name = normalizeName(row.name);
    const linked = field(row, 'ingredient_id', 'ingredientId');
    const ingredientId = id(linked) ? linked : own(aliases, name) && id(aliases[name]) ? aliases[name] : null;
    const unit = own(unitNames, row.unit) ? unitNames[row.unit] : own(units, row.unit) ? row.unit : null;
    const explicitDateSource = field(row, 'date_source', 'dateSource');
    return {
      id: field(row, 'id', '_id'), householdId, ingredientId, originalName: row.name ?? '',
      quantity: { value: field(row, 'qty_num', 'qtyNum'), unit,
        source: field(row, 'quantity_source', 'quantitySource', 'legacy_unknown') },
      expiresOn: field(row, 'expires_on', 'expiresOn'),
      dateSource: row.expiry_estimated === true || row.expiryEstimated === true ? 'catalog_estimate'
        : ['label', 'user', 'catalog_estimate', 'legacy_unknown'].includes(explicitDateSource) ? explicitDateSource : 'legacy_unknown',
      compartment: row.compartment, version: row.version ?? null,
    };
  });
}
function adaptProfiles({ rows, profileIds, householdId }) {
  requireInput(Array.isArray(rows) && Array.isArray(profileIds) && profileIds.length > 0 && profileIds.every(id)
    && new Set(profileIds).size === profileIds.length && id(householdId), 'invalid_profile_selection');
  return profileIds.map(profileId => {
    const matches = rows.filter(p => p && p.id === profileId && field(p, 'household_id', 'householdId') === householdId);
    requireInput(matches.length === 1, 'profile_missing_or_ambiguous');
    const row = matches[0];
    // Missing diet columns/local-only settings must be reconciled by the integration layer.
    return { id: profileId, householdId, mode: field(row, 'diet_mode', 'mode'),
      exclusions: structuredClone(field(row, 'excluded_foods', 'exclusions')) };
  });
}
function formatAmount(value, dimension) {
  requireInput(Number.isSafeInteger(value) && value >= 0 && ['mass', 'volume', 'count'].includes(dimension)
    && (dimension !== 'count' || value % 1000 === 0), 'invalid_amount');
  const whole = Math.floor(value / 1000), fraction = String(value % 1000).padStart(3, '0').replace(/0+$/, '');
  return String(whole) + (fraction ? ',' + fraction : '') + ' ' + { mass: 'г', volume: 'мл', count: 'шт' }[dimension];
}
return Object.freeze({ amount, date, evaluateMenu, suggest, shopping, adaptInventory, adaptProfiles, formatAmount });
});
