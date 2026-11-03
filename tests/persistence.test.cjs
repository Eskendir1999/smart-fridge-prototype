const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function source(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name);
  const tail = html.slice(start), end = tail.indexOf('\n}');
  return tail.slice(0, end + 2);
}
function fixture() {
  const tables = { fridge_items: [], cart_items: [], food_stats: [], food_events: [] };
  const calls = [], toasts = [], nodes = {}, failures = [];
  let nextId = 0, beforeWrite = null;
  function from(table) {
    let operation = 'select', payload, filters = [];
    const builder = {
      insert(rows) { operation = 'insert'; payload = [].concat(rows); return this; },
      upsert(row) { operation = 'upsert'; payload = [row]; return this; },
      delete() { operation = 'delete'; return this; },
      select() { return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      in(key, values) { filters.push(row => values.includes(row[key])); return this; },
      async run(single = false) {
        calls.push({table, operation, payload});
        if(beforeWrite && operation !== 'select') await beforeWrite(table, operation);
        const at = failures.findIndex(f => f.table === table && f.operation === operation);
        const failure = at < 0 ? null : failures.splice(at, 1)[0].mode;
        if(failure === 'denied') return {data: null, error: {code: '42501'}};
        if(failure === 'zero') return {data: single ? null : [], error: null};
        let data;
        if(operation === 'select') data = tables[table].filter(row => filters.every(f => f(row)));
        if(operation === 'insert') {
          if(payload.some(row => row.id && tables[table].some(r => r.id === row.id))) return {data: null, error: {code: '23505'}};
          data = payload.map(row => ({...row, id: row.id || 'server-' + ++nextId}));
          tables[table].push(...data);
        }
        if(operation === 'delete') {
          data = tables[table].filter(row => filters.every(f => f(row)));
          tables[table] = tables[table].filter(row => !data.includes(row));
        }
        if(operation === 'upsert') { data = payload.map(row => ({...row})); tables[table] = data; }
        if(failure === 'lost') throw Error('response lost after commit');
        return {data: single ? data[0] || null : data.map(row => ({...row})), error: null};
      },
      single() { return this.run(true); },
      then(resolve, reject) { return this.run().then(resolve, reject); },
    };
    return builder;
  }
  const context = vm.createContext({
    sb: {from}, crypto: {randomUUID: () => 'fixture-' + ++nextId},
    currentUserId: 'user', currentHouseholdId: 'house', currentCompartment: 'fridge',
    fridgeData: [], freezerData: [], cartData: [], pendingCartAdds: new Map(), foodWriteBusy: false,
    usedCount: 0, usedWeightKg: 0, wastedCount: 0, currentProduct: null, history: ['fridge', 'product'],
    getArr(name) { return name === 'freezer' ? context.freezerData : context.fridgeData; },
    findCatalog: () => null, TODAY: new Date('2026-11-02'), addDays: () => new Date('2026-11-07'), isoDate: () => '2026-11-07', estimateKg: () => 1,
    updateSummary() {}, renderFridgeList() {}, renderMissingAlert() {}, renderSuggestRow() {}, renderCart() {}, showScreen() {}, closeSheet() {},
    document: {getElementById: id => nodes[id] ||= {disabled: false}}, showToast: (...args) => toasts.push(args),
  });
  const names = ['decimalInput', 'positiveQuantity', 'toDbRow', 'dbInsertRecords', 'dbInsertItems', 'dbDeleteRecord', 'dbDeleteItem', 'dbInsertCart', 'dbDeleteCart', 'dbSaveStats', 'dbLogFoodEvent', 'saveAddedProducts', 'consumeItem', 'consumeCurrentProduct', 'buyCartItem', 'applyWidgetPurchases', 'addMissingToCart', 'saveCustomDish'];
  vm.runInContext(names.map(source).join('\n'), context);
  return {c: context, tables, calls, toasts, nodes, failures, run: code => vm.runInContext(code, context),
    beforeWrite: fn => beforeWrite = fn,
    fail: (table, operation, mode = 'denied') => failures.push({table, operation, mode}),
    product(id = 'product') { const row = {id, household_id:'house', user_id:'user', name:'Молоко', emoji:'🥛', qty_num:1, unit:'л', compartment:'fridge', location:'Полка', expires_on:'2026-11-07'}; tables.fridge_items.push(row); const item = {_id:id, name:row.name, emoji:row.emoji, qtyNum:1, unit:'л', location:row.location, expiresOn:row.expires_on}; context.fridgeData.push(item); return item; },
    purchase(id = 'purchase') { const item = {_id:id, name:'Молоко', emoji:'🛒', qtyNum:1, unit:'л'}; context.cartData.push(item); tables.cart_items.push({id, household_id:'house'}); return item; },
  };
}
function add(f) { return f.run('saveAddedProducts(document.getElementById("add"), [{name:"Тест", emoji:"📦", qtyNum:1, unit:"шт", expiresOn:"2026-11-07"}], "fridge")'); }
for(const mode of ['denied', 'zero']) test('unconfirmed add keeps local list unchanged and unlocks retry: ' + mode, async () => {
  const f = fixture(); f.fail('fridge_items', 'insert', mode);
  assert.equal(await add(f), false); assert.equal(f.c.fridgeData.length, 0);
  assert.equal(f.nodes.add.disabled, false); assert.equal(f.toasts[0][1], true);
});
test('lost add response retries same ID and confirms existing row without duplicate', async () => {
  const f = fixture(); f.fail('fridge_items', 'insert', 'lost');
  assert.equal(await add(f), false); assert.equal(f.tables.fridge_items.length, 1); assert.equal(f.c.fridgeData.length, 0);
  assert.equal(await add(f), true); assert.equal(f.tables.fridge_items.length, 1); assert.equal(f.c.fridgeData.length, 1);
  const writes = f.calls.filter(x => x.operation === 'insert'); assert.equal(writes[0].payload[0].id, writes[1].payload[0].id);
});
test('batch add is one confirmed request, double click cannot create another batch', async () => {
  const f = fixture(); let release;
  f.beforeWrite(() => new Promise(resolve => release = resolve));
  const batch = () => f.run('saveAddedProducts(document.getElementById("add"), [{name:"One", qtyNum:1}, {name:"Two", qtyNum:2}], "fridge")');
  const work = batch(); assert.equal(f.nodes.add.disabled, true);
  assert.equal(await batch(), false); assert.equal(f.c.fridgeData.length, 0);
  await new Promise(resolve => setImmediate(resolve));
  release(); assert.equal(await work, true); assert.equal(f.tables.fridge_items.length, 2);
  assert.equal(f.calls.filter(x => x.operation === 'insert').length, 1);
});
test('late add for an old account cannot populate the new account list', async () => {
  const f = fixture(); f.beforeWrite(async () => { f.c.currentHouseholdId = 'other-house'; });
  assert.equal(await add(f), false); assert.equal(f.c.fridgeData.length, 0);
});
test('conflict recovery requires all expected IDs in the same household', async () => {
  const f = fixture(); f.tables.fridge_items.push({id:'one', household_id:'house'});
  await assert.rejects(f.run('dbInsertRecords("fridge_items", [{id:"one"}, {id:"missing"}])'));
  assert.equal(f.tables.fridge_items.length, 1);
});
test('missing account rejects writes rather than pretending success', async () => {
  const f = fixture(); f.c.currentUserId = null;
  assert.equal(await add(f), false); assert.equal(f.calls.length, 0); assert.equal(f.c.fridgeData.length, 0);
});
for(const mode of ['denied', 'zero']) test('unconfirmed consumption preserves product and counters: ' + mode, async () => {
  const f = fixture(); f.product(); f.fail('fridge_items', 'delete', mode);
  await assert.rejects(f.run('consumeItem(fridgeData[0], "used")'));
  assert.equal(f.c.fridgeData.length, 1); assert.equal(f.c.usedCount, 0);
  assert.equal(f.calls.filter(x => ['food_stats', 'food_events'].includes(x.table)).length, 0); assert.equal(f.c.foodWriteBusy, false);
});
test('consumption waits for deletion and prevents simultaneous second action', async () => {
  const f = fixture(); f.product(); let release;
  f.beforeWrite((table) => table === 'fridge_items' ? new Promise(resolve => release = resolve) : undefined);
  const work = f.run('consumeItem(fridgeData[0], "used")');
  await assert.rejects(f.run('consumeItem(fridgeData[0], "wasted")'));
  assert.equal(f.c.usedCount, 0); assert.equal(f.c.fridgeData.length, 1);
  release(); assert.equal(await work, true); assert.equal(f.c.fridgeData.length, 0); assert.equal(f.c.usedCount, 1);
});
test('journal or stats failure reports partial consumption instead of complete success', async () => {
  for(const table of ['food_stats', 'food_events']) {
    const f = fixture(); f.product(); f.fail(table, table === 'food_stats' ? 'upsert' : 'insert');
    f.c.currentProduct = {list:'fridge', idx:0}; await f.run('consumeCurrentProduct("used")');
    assert.equal(f.c.fridgeData.length, 0); assert.equal(f.c.usedCount, 1);
    assert.equal(f.toasts[0][1], true); assert.match(f.toasts[0][0], /не полностью/);
    assert.equal(f.nodes['use-product-btn'].disabled, false);
  }
});
test('failed destination write keeps purchase and never deletes source', async () => {
  const f = fixture(); f.purchase(); f.fail('fridge_items', 'insert');
  await assert.rejects(f.run('buyCartItem(cartData[0], false)'));
  assert.equal(f.c.cartData.length, 1); assert.equal(f.c.fridgeData.length, 0);
  assert.equal(f.calls.some(x => x.table === 'cart_items' && x.operation === 'delete'), false);
});
test('partial purchase transfer can retry after reload without duplicating destination', async () => {
  const f = fixture(); f.purchase(); f.fail('cart_items', 'delete');
  await assert.rejects(f.run('buyCartItem(cartData[0], false)'));
  assert.equal(f.c.cartData.length, 1); assert.equal(f.tables.fridge_items.length, 1); assert.equal(f.c.fridgeData.length, 1);
  // Reloaded cart object has none of the in-memory operation fields.
  f.c.cartData[0] = {...f.c.cartData[0]}; await f.run('buyCartItem(cartData[0], false)');
  assert.equal(f.tables.fridge_items.length, 1); assert.equal(f.c.fridgeData.length, 1); assert.equal(f.c.cartData.length, 0);
});
test('concurrent transfer requests reuse one in-flight operation', async () => {
  const f = fixture(); f.purchase(); let release;
  f.beforeWrite(table => table === 'fridge_items' ? new Promise(resolve => release = resolve) : undefined);
  const first = f.run('buyCartItem(cartData[0], false)'), second = f.run('buyCartItem(cartData[0], false)');
  await new Promise(resolve => setImmediate(resolve));
  release(); await Promise.all([first, second]);
  assert.equal(f.calls.filter(x => x.table === 'fridge_items' && x.operation === 'insert').length, 1);
  assert.equal(f.tables.fridge_items.length, 1); assert.equal(f.c.cartData.length, 0);
});
test('widget clears confirmed transfers only and keeps failed marks pending', async () => {
  const f = fixture(); f.purchase('bad'); f.purchase('good'); f.fail('fridge_items', 'insert');
  const cleared = []; f.c.bridge = {getPending: async () => ({ids:['bad', 'good']}), clearPending: async ({ids}) => cleared.push(...ids)};
  await f.run('applyWidgetPurchases(bridge)');
  assert.deepEqual(cleared, ['good']); assert.equal(f.c.cartData[0]._id, 'bad'); assert.equal(f.toasts.at(-1)[1], true);
});
test('lost shopping-list write retries stable ID and cannot duplicate item locally', async () => {
  const f = fixture(); f.fail('cart_items', 'insert', 'lost');
  await assert.rejects(f.run('addMissingToCart("Молоко")')); assert.equal(f.c.cartData.length, 0);
  assert.equal(await f.run('addMissingToCart("Молоко")'), true);
  assert.equal(await f.run('addMissingToCart("Молоко")'), false);
  assert.equal(f.tables.cart_items.length, 1); assert.equal(f.c.cartData.length, 1);
});
test('partial dish consumption leaves failed products selected for a clean retry', async () => {
  const f = fixture(); f.product('one'); f.product('two');
  f.nodes['custom-dish-name'] = {value:'Омлет'};
  f.c.document.querySelectorAll = () => [{dataset:{idx:'0'}}, {dataset:{idx:'1'}}];
  let deletes = 0, rebuilt = 0;
  f.beforeWrite((table, op) => { if(table === 'fridge_items' && op === 'delete' && ++deletes === 2) f.fail(table, op); });
  f.c.populateCustomDishIngredients = () => rebuilt++;
  await f.run('saveCustomDish()');
  assert.equal(f.c.fridgeData.length, 1); assert.equal(f.c.fridgeData[0]._id, 'two'); assert.equal(rebuilt, 1);
  assert.match(f.toasts.at(-1)[0], /1 из 2/); assert.equal(f.nodes['save-custom-dish-btn'].disabled, false);
});

test('widget transfer repaint does not schedule another automatic retry', async () => {
  const f = fixture(); f.purchase(); f.fail('fridge_items', 'insert');
  const syncRequests = []; f.c.renderCart = sync => syncRequests.push(sync);
  await assert.rejects(f.run('buyCartItem(cartData[0], true)'));
  assert.deepEqual(syncRequests, [false]);
  assert.match(source('renderCart'), /if\(syncNative\) queueNativeSync\(\)/);
});
test('native synchronization cannot overlap and unlocks after failure', async () => {
  const f = fixture(); let release, attempts = 0;
  Object.assign(f.c, {nativePlugin: () => ({}), userDataLoaded:true, nativeSyncRunning:false, console:{warn() {}},
    applyWidgetPurchases: async () => { attempts++; await new Promise(resolve => release = resolve); throw Error('fixture'); }});
  vm.runInContext(source('syncNativeExtras'), f.c);
  const first = f.run('syncNativeExtras()'); await f.run('syncNativeExtras()');
  assert.equal(attempts, 1); release(); await first; assert.equal(f.c.nativeSyncRunning, false);
});
test('late consumption does not navigate away from another product', async () => {
  const f = fixture(); f.product('one'); f.product('two');
  f.c.currentProduct = {list:'fridge', idx:0}; let release, navigations = 0;
  f.c.showScreen = () => navigations++;
  f.beforeWrite(table => table === 'fridge_items' ? new Promise(resolve => release = resolve) : undefined);
  const pending = f.run('consumeCurrentProduct("used")');
  f.c.currentProduct = {list:'fridge', idx:1};
  release(); await pending; assert.equal(navigations, 0); assert.equal(f.c.fridgeData[0]._id, 'two');
});
