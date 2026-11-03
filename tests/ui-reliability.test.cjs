const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function fn(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name); const tail = html.slice(start); const end = tail.indexOf('\n}');
  assert.ok(end >= 0, name); return tail.slice(0, end + 2);
}
function load(names, values) {
  const context = vm.createContext(values);
  vm.runInContext(names.map(fn).join('\n'), context);
  return context;
}
test('quantity input rejects zero, negatives, non-finite and partially numeric values', () => {
  const c = load(['decimalInput', 'positiveQuantity'], {});
  for (const value of ['', '0', '-1', 'Infinity', '1oops', '0x10']) assert.equal(vm.runInContext(`positiveQuantity(${JSON.stringify(value)})`, c), null, value);
  assert.equal(vm.runInContext('positiveQuantity("1,25")', c), 1.25);
  assert.equal(vm.runInContext('positiveQuantity("1.25")', c), 1.25);
});
function editFixture(reply, quantity = '1.5') {
  const p = { _id: 'fixture-product', name: 'before', qtyNum: 1, unit: 'кг', location: 'Средняя полка', expiresOn: '2026-11-05' };
  const fridge = [p], freezer = [], button = { disabled: false }, calls = [], toasts = [];
  const nodes = { 'save-edit-btn': button, 'edit-name': { value: 'after' }, 'edit-qty-num': { value: quantity }, 'edit-qty-unit': { value: 'кг' }, 'edit-location': { value: 'Морозилка' }, 'edit-exp': { value: '2026-11-06' } };
  const c = load(['decimalInput', 'positiveQuantity', 'toDbRow', 'dbUpdateItem', 'saveProductEdit'], {
    document: { getElementById: id => nodes[id] }, currentUserId: 'fixture-user', foodWriteBusy: false, currentProduct: { list: 'fridge', idx: 0 }, currentCompartment: 'fridge',
    getArr: name => name === 'freezer' ? freezer : fridge,
    sb: { from: () => ({ update(payload) { calls.push(payload); return this; }, eq() { return this; }, select() { return this; }, single: async () => typeof reply === 'function' ? reply() : reply }) },
    updateSummary() {}, renderFridgeList() {}, renderMissingAlert() {}, renderSuggestRow() {}, showToast: (...args) => toasts.push(args), history: ['fridge', 'product', 'edit'], openProduct() {},
  });
  return { c, p, fridge, freezer, button, calls, toasts, run: () => vm.runInContext('saveProductEdit()', c) };
}
for (const reply of [{ error: { message: 'denied' }, data: null }, { error: null, data: null }]) {
  test('failed/zero-row product update keeps local data and does not report success: ' + JSON.stringify(reply), async () => {
    const f = editFixture(reply); await f.run();
    assert.equal(f.p.name, 'before'); assert.equal(f.p.qtyNum, 1); assert.equal(f.fridge.length, 1); assert.equal(f.freezer.length, 0);
    assert.equal(f.button.disabled, false); assert.equal(f.toasts[0][1], true); assert.ok(!f.toasts.some(([text]) => text === 'Сохранено'));
  });
}
test('invalid product quantity never reaches database', async () => {
  const f = editFixture({ data: { id: 'fixture-product' }, error: null }, '-2'); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.p.qtyNum, 1); assert.equal(f.toasts[0][1], true);
});
test('product moves compartments only after confirmed persistence', async () => {
  let finish; const f = editFixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.run(); await new Promise(setImmediate);
  assert.equal(f.p.name, 'before'); assert.equal(f.fridge.length, 1); assert.equal(f.button.disabled, true);
  await f.run(); assert.equal(f.calls.length, 1, 'double click is ignored');
  finish({ data: { id: 'fixture-product' }, error: null }); await pending;
  assert.equal(f.p.name, 'after'); assert.equal(f.p.qtyNum, 1.5); assert.equal(f.fridge.length, 0); assert.equal(f.freezer[0], f.p); assert.equal(f.button.disabled, false);
});
test('late product save does not navigate away from another screen', async () => {
  let finish, opened = 0; const f = editFixture(() => new Promise(resolve => { finish = resolve; }));
  f.c.openProduct = () => opened++;
  const pending = f.run(); await new Promise(setImmediate);
  f.c.currentProduct = null;
  finish({ data: { id: 'fixture-product' }, error: null }); await pending;
  assert.equal(opened, 0); assert.equal(f.c.history.length, 3); assert.equal(f.freezer.length, 1);
});

test('leaving camera stops active tracks and detaches preview', () => {
  let stops = 0, loops = 0; const video = { srcObject: 'fixture-media' };
  const c = load(['stopVisionCamera'], { visionCameraRequest: 0, stream: { getTracks: () => [{ stop() { stops++; } }] }, videoEl: video, stopDetectLoop() { loops++; }, setVisionState() {} });
  vm.runInContext('stopVisionCamera()', c);
  assert.equal(stops, 1); assert.equal(loops, 1); assert.equal(video.srcObject, null); assert.equal(c.stream, null);
});
test('late getUserMedia after leaving is stopped without restarting camera', async () => {
  let finish, stops = 0, detectorStarts = 0; const states = [];
  const c = load(['stopVisionCamera', 'openVisionCamera'], {
    visionCameraRequest: 0, stream: null, videoEl: null, currentFacingMode: 'environment',
    stage: { querySelector: () => ({ textContent: '' }) }, stopDetectLoop() {}, setVisionState: s => states.push(s), ensureModel() {}, startDetectLoop() { detectorStarts++; },
    navigator: { mediaDevices: { getUserMedia: () => new Promise(resolve => { finish = resolve; }) } },
  });
  const pending = vm.runInContext('openVisionCamera("environment")', c);
  vm.runInContext('stopVisionCamera()', c);
  finish({ getTracks: () => [{ stop() { stops++; } }] }); await pending;
  assert.equal(stops, 1); assert.equal(c.stream, null); assert.equal(detectorStarts, 0); assert.ok(!states.includes('live'));
});
test('late detector model does not restart loop after stop', async () => {
  let finish, timers = 0;
  const c = load(['stopDetectLoop', 'startDetectLoop'], {
    detectLoopRequest: 0, detectTimer: null, autoStreak: 0, autoLastClass: null, detectTick: 0, stream: {},
    clearInterval() {}, hideDetectBox() {}, hideMobileBadge() {},
    ensureDetectorModel: () => new Promise(resolve => { finish = resolve; }), ensureModel: () => Promise.resolve(null),
    setInterval() { timers++; },
  });
  const pending = vm.runInContext('startDetectLoop()', c);
  vm.runInContext('stopDetectLoop(); stream = null;', c); finish({}); await pending;
  assert.equal(timers, 0);
});
test('recognition failure clears stale product instead of inventing a result', async () => {
  const nodes = new Map(); const node = id => { if (!nodes.has(id)) nodes.set(id, { value: 'stale fixture', textContent: '' }); return nodes.get(id); };
  const c = load(['showRecognitionUnavailable', 'runRecognition'], {
    stream: null, document: { getElementById: node }, setVisionState() {}, visionResult: { classList: { add() {} } },
    TODAY: new Date('2026-11-02T00:00:00Z'), addDays: d => d, isoDate: () => '2026-11-02', ensureModel: async () => null,
  });
  await vm.runInContext('runRecognition({})', c);
  assert.equal(node('vr-name-input').value, ''); assert.match(node('vr-conf').textContent, /вручную/); assert.equal(node('vr-qty-num').value, 1);
  assert.ok(!html.includes('randomFallbackRecognition')); assert.ok(!html.includes('demoRecognitions'));
});

function profileFixture({ error = null, measuredFailure = false, editing = true, weight = '74.5', age = '30' } = {}) {
  const nodes = { 'ff-save-btn': { disabled: false }, 'ff-name': { value: 'fixture name' }, 'ff-age': { value: age }, 'ff-height': { value: '170.5' }, 'ff-weight': { value: weight }, 'ff-target': { value: '' }, 'ff-baby-age': { value: '' } };
  const button = nodes['ff-save-btn']; const writes = [], measures = [], toasts = [], local = [];
  let measureFails = measuredFailure;
  const get = id => nodes[id] || { classList: { contains: () => false } };
  const c = load(['decimalInput', 'positiveQuantity', 'saveFamilyProfile'], {
    document: { getElementById: get, querySelectorAll: () => [] }, currentHouseholdId: 'fixture-household', currentUserId: 'fixture-user',
    editingProfileId: editing ? 'fixture-profile' : null, familyFormInitialWeight: editing ? 75 : null, dietColumnsMissing: false,
    showToast: (...args) => toasts.push(args), isMissingColumnError: e => e?.code === '42703', saveDietLocal: (...args) => local.push(args),
    loadFamilyProfiles: async () => {}, openFamilyMember: async () => {}, history: ['diet', 'form'],
    saveProfileWeight: async (id, value) => { measures.push({ id, weight: value }); if (measureFails) { measureFails = false; throw Error('fixture measurement failure'); } },
    sb: { from: table => ({
      update(row) { writes.push({ type: 'update', row, table }); return this; }, insert(row) { writes.push({ type: 'insert', row, table }); return this; }, eq() { return this; }, select() { return this; },
      single: async () => ({ error, data: error ? null : { id: 'fixture-profile' } }),
    }) },
  });
  return { c, button, writes, measures, toasts, local, run: () => vm.runInContext('saveFamilyProfile()', c) };
}
test('failed profile update retains form and does not report success', async () => {
  const f = profileFixture({ error: { message: 'denied' } }); await f.run();
  assert.equal(f.measures.length, 0); assert.equal(f.local.length, 0); assert.equal(f.toasts[0][1], true); assert.equal(f.button.disabled, false);
});
test('decimal current weight is saved separately without rewriting start weight', async () => {
  const f = profileFixture(); await f.run();
  assert.equal(f.writes[0].row.height_cm, 170.5); assert.equal(f.writes[0].row.start_weight_kg, undefined);
  assert.equal(f.measures[0].weight, 74.5); assert.ok(f.toasts.some(([message]) => message === 'Профиль обновлён'));
});
test('unchanged weight does not fabricate another measurement', async () => {
  const f = profileFixture({ weight: '75' }); await f.run(); assert.equal(f.measures.length, 0);
});
test('retry after initial measurement failure updates saved profile instead of duplicating it', async () => {
  const f = profileFixture({ editing: false, measuredFailure: true }); await f.run();
  assert.equal(f.c.editingProfileId, 'fixture-profile'); assert.match(f.toasts[0][0], /вес не записан/);
  await f.run(); assert.deepEqual(f.writes.map(x => x.type), ['insert', 'update']); assert.equal(f.measures.length, 2); assert.equal(f.button.disabled, false);
});
test('invalid age or weight cannot be persisted', async () => {
  for (const options of [{ weight: '-1' }, { weight: '0' }, { age: '30.5' }, { age: '120' }]) {
    const f = profileFixture(options); await f.run(); assert.equal(f.writes.length, 0); assert.equal(f.toasts[0][1], true);
  }
});

test('weight-only save keeps body measurements and handles concurrent daily insert', async () => {
  for (const concurrent of [false, true]) {
    let updates = 0, inserts = 0; const row = { id: 'fixture-measurement', neck: 32, chest: 90, belly: 80, hips: 95, weight: 75 };
    const c = load(['saveProfileWeight'], { isoDate: () => '2026-11-02', Date,
      sb: { from: () => ({
        update(payload) { assert.deepEqual(Object.keys(payload), ['weight']); this.payload = payload; return this; },
        eq() { return this; }, select() { return this; },
        async maybeSingle() { updates++; if (concurrent && updates === 1) return { data: null, error: null }; Object.assign(row, this.payload); return { data: { id: row.id }, error: null }; },
        insert() { inserts++; return this; }, async single() { return { data: null, error: { code: '23505' } }; },
      }) },
    });
    await vm.runInContext('saveProfileWeight("fixture-profile", 74.5)', c);
    assert.equal(row.weight, 74.5); assert.equal(row.neck, 32); assert.equal(row.hips, 95); assert.equal(inserts, concurrent ? 1 : 0);
  }
});
