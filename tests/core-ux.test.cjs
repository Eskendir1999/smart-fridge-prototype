const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'ux/core-flow.css'),'utf8');
const js=fs.readFileSync(path.join(root,'ux/core-flow.js'),'utf8');
const build=fs.readFileSync(path.join(root,'build.js'),'utf8');

test('UI enhancement parses without executing or modifying the app',()=>{
  assert.doesNotThrow(()=>new vm.Script(js,{filename:'ux/core-flow.js'}));
  assert.ok(html.includes('<script src="/ux/core-flow.js" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="/ux/core-flow.css">'));
});
test('build copies both UX assets',()=>{
  assert.ok(build.includes("'ux', 'core-flow.js'"));
  assert.ok(build.includes("'ux', 'core-flow.css'"));
});
test('UX layer has no mutation, checkout or dinner API',()=>{
  assert.doesNotMatch(js,/\bstock_mutate\s*\(|\brunStockOperation\s*\(|\bsaveStockItem\s*\(|\bSFDinner\b|\.rpc\s*\(/);
  assert.ok(js.includes("querySelector('.nav-item[data-nav=\"cart\"],.side-item[data-nav=\"cart\"]')?.click()"));
});
test('new nodes preserve identifiers used by existing stock and cart handlers',()=>{
  for(const id of ['summary-section','expiring-row','low-stock-section','home-meals-row','fridge-list','suggest-row','manual-custom-name','manual-custom-add-btn','stock-save-panel']){
    assert.ok(html.includes('id="'+id+'"'),id);
  }
  assert.ok(js.includes('MutationObserver'));
  assert.ok(js.includes('row.hidden=!hit'));
});
test('mobile usability and reduced motion are explicitly handled',()=>{
  assert.match(css,/@media\(max-width:767px\)/);
  assert.match(css,/safe-area-inset-bottom/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(js,/aria-live/);
  assert.match(css,/min-height:48px/);
});

test('the manual form requests quantity and honest optional expiration',()=>{
  for(const id of ['manual-custom-qty','manual-custom-unit','manual-custom-expiry','manual-custom-error'])assert.ok(html.includes('id="'+id+'"'));
  assert.match(html,/const raw=\(quantityField\?\.value/);
  assert.match(html,/qtyNum:quantity/);
  assert.match(html,/expiresOn:dateField\?\.value\|\|null/);
});
test('unavailable nutrition is not presented as enabled',()=>{
  assert.match(js,/SF_NUTRITION_ENABLED/);
  assert.match(js,/button\.disabled=true/);
  assert.match(js,/meals\.hidden=!nutritionEnabled/);
  assert.match(js,/decide\.hidden=!dinnerOn/);
  assert.doesNotMatch(js,/Пока недоступно/);
});
test('login has a sign-in / sign-up switch where Enter uses the visible button',()=>{
  const page=require('fs').readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
  for(const id of ['login-mode-in','login-mode-up','signup-btn','login-forgot-btn'])assert.ok(page.includes('id="'+id+'"'),id);
  assert.match(page,/#login-form\[data-mode="in"\] \.login-signup/);
  assert.match(page,/form\.insertBefore\(first,second\)/);
  assert.match(page,/pass\.autocomplete=mode==='up'\?'new-password':'current-password'/);
});
