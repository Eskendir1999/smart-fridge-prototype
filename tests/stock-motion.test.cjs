'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/stock-ui.cjs');

test('pending and confirmed saved states do not force page scrolling', async () => {
  let finish;
  const f = fixture({reply: () => new Promise(resolve => { finish = resolve; })});
  const scrolls = [];
  f.node('stock-save-panel').scrollIntoView = opts => scrolls.push(opts);

  const action = f.run("runStockOperation('add_item',{name:'Milk',qty_num:1})");
  await new Promise(setImmediate);
  assert.equal(f.node('stock-save-message').textContent, 'Сохраняем…');
  assert.equal(f.node('stock-save-panel').dataset.state, 'pending');
  assert.equal(f.node('stock-retry-btn').hidden, true);
  assert.equal(scrolls.length, 0, 'pending must not jump the page');

  finish({data:{operation_id:'op-1',fridge_items:[],cart_items:[]},error:null});
  assert.equal(await action, true);
  assert.match(f.node('stock-save-message').textContent, /Сохранено/);
  assert.equal(f.node('stock-save-panel').dataset.state, 'saved');
  assert.equal(f.node('stock-retry-btn').hidden, true);
  assert.equal(f.node('stock-undo-btn').hidden, false);
  assert.equal(scrolls.length, 0, 'saved/undo availability must not jump the page');
});

test('failed operation reveals an actionable error without changing transaction semantics', async () => {
  const f = fixture({reply:() => { throw new Error('offline'); }});
  const scrolls = [];
  f.node('stock-save-panel').scrollIntoView = opts => scrolls.push(opts);

  assert.equal(await f.run("runStockOperation('add_item',{name:'Milk'})"), false);
  assert.match(f.node('stock-save-message').textContent, /Не удалось подтвердить сохранение/);
  assert.equal(f.node('stock-save-panel').dataset.state, 'error');
  assert.equal(f.node('stock-retry-btn').hidden, false);
  assert.equal(f.node('stock-reset-btn').hidden, true);
  assert.equal(scrolls.length, 1, 'error should be revealed once');
  assert.equal(scrolls[0].block, 'nearest');
  assert.equal(f.calls.filter(x => x[0] === 'rpc').length, 1);
});

test('recovering an already confirmed save does not force scrolling', async () => {
  const f = fixture();
  assert.equal(await f.run("runStockOperation('add_item',{name:'Milk'})"), true);
  const recovered = fixture({storage:f.storage});
  const scrolls = [];
  recovered.node('stock-save-panel').scrollIntoView = opts => scrolls.push(opts);
  recovered.run('recoverStockOperation()');

  assert.equal(recovered.node('stock-save-message').textContent, 'Последнее действие сохранено.');
  assert.equal(recovered.node('stock-save-panel').dataset.state, 'saved');
  assert.equal(recovered.node('stock-undo-btn').hidden, false);
  assert.equal(scrolls.length, 0);
});

test('stock feedback style defines distinct accessible colors and mobile-friendly controls', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  for(const state of ['pending','error','saved']) {
    assert.ok(html.includes('#stock-save-panel[data-state="' + state + '"]'), state + ' has visual treatment');
  }
  assert.match(html, /#stock-save-panel \.secondary-btn\[hidden\]\{ display:none !important; \}/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)\{ #stock-save-panel\{ transition:none !important; \} \}/);
});
