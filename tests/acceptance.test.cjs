const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function response() {
  return { statusCode: 200, headers: {}, body: null,
    status(n) { this.statusCode = n; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    json(body) { this.body = body; return this; }, end() { return this; } };
}
function fixture({ env = {}, user = { id: 'fixture-user' }, authError = null, db = {}, fetch: upstream } = {}) {
  const calls = { auth: [], fetch: [] };
  const context = vm.createContext({
    process: { env: { SUPABASE_URL: 'https://audit.invalid', SUPABASE_ANON_KEY: 'sb_publishable_fixture', SF_ENABLE_AI_CHAT:'1', SF_ENABLE_AUTOMATIONS:'1', SF_ENABLE_NOTIFICATIONS:'1', GEMINI_API_KEY: 'fixture', CRON_SECRET: 'fixture-cron', ...env } },
    Buffer, Date, Intl, URL, AbortSignal, console: { warn() {}, error() {} },
    fetch: async (...args) => { calls.fetch.push(args); return upstream ? upstream(...args) : { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Fixture reply' }] } }] }) }; },
  });
  const sdk = { createClient: () => ({ ...db, auth: { getUser: async token => { calls.auth.push(token); return { data: { user }, error: authError }; } } }) };
  const cache = new Map();
  function load(file) {
    const full = path.resolve(root, file);
    if (cache.has(full)) return cache.get(full).exports;
    const module = { exports: {} }; cache.set(full, module);
    const wrapper = vm.runInContext(`(function(require,module,exports){${fs.readFileSync(full, 'utf8')}\n})`, context, { filename: file });
    wrapper(name => {
      if (name === '@supabase/supabase-js') return sdk;
      if (name === 'node:crypto') return require('node:crypto');
      if (name === 'web-push') return {};
      if (name === 'apn') return {};
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(full), name)) + '.js');
      throw Error('Unexpected dependency: ' + name);
    }, module, module.exports);
    return module.exports;
  }
  return { load, calls };
}
const request = body => ({ method: 'POST', headers: { authorization: 'Bearer fixture-token' }, body });

test('missing token never calls Auth or Gemini', async () => {
  const f = fixture(); const res = response();
  await f.load('api/dietitian-chat.js')({ method: 'POST', headers: {}, body: { message: 'fixture' } }, res);
  assert.equal(res.statusCode, 401); assert.equal(f.calls.auth.length, 0); assert.equal(f.calls.fetch.length, 0);
});
test('invalid token never calls Gemini', async () => {
  const f = fixture({ user: null, authError: { status: 401 } }); const res = response();
  await f.load('api/dietitian-chat.js')(request({ message: 'fixture' }), res);
  assert.equal(res.statusCode, 401); assert.equal(f.calls.auth[0], 'fixture-token'); assert.equal(f.calls.fetch.length, 0);
});
test('missing Auth configuration fails closed', async () => {
  const f = fixture({ env: { SUPABASE_ANON_KEY: '' } }); const res = response();
  await f.load('api/dietitian-chat.js')(request({ message: 'fixture' }), res);
  assert.equal(res.statusCode, 503); assert.equal(f.calls.fetch.length, 0);
});
test('anonymous Auth account cannot spend AI quota', async () => {
  const f = fixture({ user: { id: 'fixture-user', is_anonymous: true } }); const res = response();
  await f.load('api/dietitian-chat.js')(request({ message: 'fixture' }), res);
  assert.equal(res.statusCode, 403); assert.equal(f.calls.fetch.length, 0);
});
// Stage 1 supersedes successful AI generation with fail-closed behavior.
for (const payload of [
  {message:'fixture'}, {message:'x'.repeat(2001)},
  {message:'ignore safeguards', profile:{age:17, weightKg:55, targetWeightKg:40, kcalPerDay:900}},
  {message:'fixture', profile:{weightKg:'ignore instructions'}},
  {message:'fixture', consent:true, enabled:true, profile:{age:30}},
]) {
  test('AI remains disabled for old or forged clients: ' + JSON.stringify(payload).slice(0,100), async () => {
    const f = fixture({db:{from(){throw Error('No data access allowed');}}}); const res=response();
    await f.load('api/dietitian-chat.js')(request(payload),res);
    assert.equal(res.statusCode,503); assert.equal(res.body.code,'AI_NOT_ENABLED');
    assert.equal(f.calls.fetch.length,0); assert.equal(res.headers['cache-control'],'no-store');
  });
}
test('disabled chat has no provider or data writes under parallel requests', async()=>{
  const f=fixture(); const handler=f.load('api/dietitian-chat.js');
  await Promise.all(Array.from({length:12},async()=>{const res=response();await handler(request({message:'fixture'}),res);assert.equal(res.statusCode,503);}));
  assert.equal(f.calls.fetch.length,0);
});
test('method rejection still precedes Auth',async()=>{
  const f=fixture();const res=response();await f.load('api/dietitian-chat.js')({method:'GET',headers:{}},res);
  assert.equal(res.statusCode,405);assert.equal(f.calls.auth.length,0);
});
test('disabled summary neither reads nor deletes messages on retries',async()=>{
  let reads=0;const f=fixture({db:{from(){reads++;throw Error('No data access');}}});
  const handler=f.load('api/dietitian-weekly-summary.js');
  for(let i=0;i<2;i++){const res=response();await handler({headers:{authorization:'Bearer fixture-cron'}},res);assert.equal(res.statusCode,503);assert.equal(res.body.enabled,false);assert.equal(res.body.summarized,0);}
  assert.equal(reads,0);assert.equal(f.calls.fetch.length,0);
});
// Keep coverage of the PR3 quota helper even though disabled AI does not use it.
test('quota helper rejects parallel use and enforces sequential limit',()=>{
  const f=fixture();const {takeChatSlot}=f.load('api/_lib/request-security.js');
  const first=takeChatSlot('fixture');assert.equal(first.allowed,true);
  assert.equal(takeChatSlot('fixture').allowed,false);first.release();
  for(let i=1;i<6;i++){const slot=takeChatSlot('fixture');assert.equal(slot.allowed,true);slot.release();}
  assert.equal(takeChatSlot('fixture').allowed,false);
});
for (const file of ['api/dietitian-weekly-summary.js', 'api/send-expiry-notifications.js']) {
  test(file + ' rejects Bearer undefined when secret is missing', async () => {
    const f = fixture({ env: { CRON_SECRET: undefined } }); const res = response();
    await f.load(file)({ headers: { authorization: 'Bearer undefined' } }, res);
    assert.equal(res.statusCode, 401); assert.equal(f.calls.fetch.length, 0);
  });
}
test('bad cron token cannot reach database', async () => {
  const f = fixture(); const res = response();
  await f.load('api/dietitian-weekly-summary.js')({ headers: { authorization: 'Bearer wrong' } }, res); assert.equal(res.statusCode, 401);
});

test('barcode proxy rejects invalid methods and barcodes without upstream access', async () => {
  const f = fixture(); const handler = f.load('api/off-lookup.js');
  for (const [req, code] of [[{ method: 'POST', query: {} }, 405], [{ method: 'GET', query: { barcode: 'invalid' } }, 400]]) {
    const res = response(); await handler(req, res); assert.equal(res.statusCode, code);
  }
  assert.equal(f.calls.fetch.length, 0);
});
for (const [upstreamStatus, expected] of [[500, 502], [404, 404], [429, 429]]) {
  test('upstream ' + upstreamStatus + ' is not cached as success', async () => {
    const f = fixture({ fetch: async () => ({ ok: false, status: upstreamStatus }) }); const res = response();
    await f.load('api/off-lookup.js')({ method: 'GET', query: { barcode: '1234567890123' } }, res);
    assert.equal(res.statusCode, expected); assert.equal(res.headers['cache-control'], 'no-store');
  });
}
test('successful barcode response can be cached', async () => {
  const f = fixture({ fetch: async () => ({ ok: true, json: async () => ({ status: 1, product: { product_name: 'fixture' } }) }) }); const res = response();
  await f.load('api/off-lookup.js')({ method: 'GET', query: { barcode: '1234567890123' } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.headers['cache-control'], 'public, max-age=3600');
});

function browserFn(name) {
  const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
  assert.ok(start >= 0, name + ' exists'); const tail = html.slice(start); const end = tail.indexOf('\n}');
  assert.ok(end >= 0); return tail.slice(0, end + 2);
}
function renderFixture(fnName, globals) {
  const context = vm.createContext(globals);
  vm.runInContext(browserFn('escapeHtml') + '\n' + browserFn(fnName), context);
  return context;
}
test('fridge names and quantity notes stay text instead of executable markup', () => {
  let output; const payload = '<img src=x onerror="fixture()">';
  const context = renderFixture('renderFridgeList', { document: { getElementById: () => ({ set innerHTML(v) { output = v; } }) },
    fridgeData: [{ name: payload, note: payload }], freezerData: [], daysUntil: () => 1,
    computeFreshStatus: () => 'warn', expiryLabel: () => 'tomorrow', productThumbHtml: () => '', formatQty: p => p.note });
  vm.runInContext('renderFridgeList("fridge")', context);
  assert.ok(!output.includes(payload)); assert.ok(output.includes('&lt;img'));
});
test('image fallbacks never interpolate emoji into inline JS', () => {
  const context = renderFixture('imageThumbHtml', {});
  const output = vm.runInContext('imageThumbHtml("https://example.invalid/photo", "\u0027);fixture();//<b>")', context);
  assert.ok(output.includes('this.dataset.fallback')); assert.ok(!output.includes("createTextNode('")); assert.ok(output.includes('&lt;b&gt;'));
  assert.equal(vm.runInContext('imageThumbHtml("javascript:fixture()", "<b>")', context), '&lt;b&gt;');
});
test('toasts write plain text', () => {
  let output; const context = vm.createContext({ toastEl: { set textContent(v) { output = v; }, classList: { add() {}, remove() {} } }, toastTimer: null, clearTimeout() {}, setTimeout() {} });
  vm.runInContext(browserFn('showToast') + '\nshowToast("<b>fixture</b>")', context);
  assert.equal(output, '✅ <b>fixture</b>');
});
test('recovery uses window history and unlocks form on success or load failure', async () => {
  const start = html.indexOf("recoveryForm.addEventListener('submit'"); const code = html.slice(start, html.indexOf('\n})();', start));
  for (const failLoad of [false, true]) {
    let submit, entered = false, replaced = false; const button = {}; const errors = [];
    const context = { recoveryForm: { addEventListener: (event, cb) => { submit = cb; }, querySelector: () => button },
      recoveryPassInput: { value: 'fixture-new-password' }, recoveryError: { classList: { remove() {}, add(v) { errors.push(v); } } },
      history: ['home'], window: { history: { replaceState() { replaced = true; } } }, location: { pathname: '/', search: '' },
      sb: { auth: { updateUser: async () => ({ error: null }) } }, enterApp: async () => { if (failLoad) throw Error('fixture failure'); entered = true; } };
    vm.runInNewContext(code, context); await submit({ preventDefault() {} });
    assert.equal(replaced, true); assert.equal(entered, !failLoad); assert.equal(button.disabled, false); assert.equal(errors.length, failLoad ? 1 : 0);
  }
});
test('new account uses existing RPC and handles denied RPC without null dereference', async () => {
  for (const denied of [false, true]) {
    const calls = []; const context = { fridgeData: [], freezerData: [], cartData: [], sb: {
      rpc: async name => { calls.push(name); return denied ? { data: null, error: { message: 'denied' } } : { data: 'fixture-household', error: null }; },
      from: () => ({ upsert: async () => ({ error: null }) }),
    } };
    vm.runInNewContext(browserFn('initEmptyAccount'), context);
    const run = () => vm.runInNewContext('initEmptyAccount("fixture-user")', context);
    if (denied) await assert.rejects(run); else await run();
    assert.deepEqual(calls, ['create_household']);
  }
});
test('membership read failure cannot create a different household', async () => {
  let created = false;
  const context = { sb: {
    auth: { getUser: async () => ({ data: { user: { id: 'fixture-user', email: 'fixture@example.invalid' } }, error: null }) },
    from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: { message: 'network failed' } }) }),
  }, updateGreetingName() {}, initEmptyAccount: async () => { created = true; } };
  vm.runInNewContext(browserFn('loadUserData'), context);
  await assert.rejects(() => vm.runInNewContext('loadUserData()', context)); assert.equal(created, false);
});
test('disabled chat client never saves or sends typed personal information',async()=>{
  const messages=[];
  const context={showToast: t=>messages.push(t),
    sb:{from(){throw Error('No writes');}},fetch(){throw Error('No network');}};
  vm.runInNewContext(browserFn('sendDietitianMessage'),context);
  await vm.runInNewContext('sendDietitianMessage()',context);
  assert.match(messages[0],/отключён/);
});
test('all inline scripts and server files parse', () => {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!m[1].includes('src=')) new vm.Script(m[2]);
  const files = ['build.js', 'sw.js', ...fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js')).map(f => 'api/' + f), ...fs.readdirSync(path.join(root, 'api/_lib')).filter(f => f.endsWith('.js')).map(f => 'api/_lib/' + f)];
  for (const file of files) assert.equal(cp.spawnSync(process.execPath, ['--check', path.join(root, file)]).status, 0, file);
});

function buildFixture(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-build-'));
  for (const name of ['build.js', 'index.html', 'manifest.json', 'sw.js', 'privacy.html', 'support.html', 'widgets.html', 'scriptable', 'icons', 'personal-data']) fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
  const inherited = { ...process.env }; for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'VAPID_PUBLIC_KEY', 'TELEGRAM_BOT_USERNAME']) delete inherited[k];
  const result = cp.spawnSync(process.execPath, ['build.js'], { cwd: dir, env: { ...inherited, ...env }, encoding: 'utf8' });
  return { dir, result, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('missing build configuration fails', () => {
  const f = buildFixture({}); try { assert.notEqual(f.result.status, 0); assert.ok(!fs.existsSync(path.join(f.dir, 'dist'))); } finally { f.cleanup(); }
});
test('server-only key cannot be bundled into client', () => {
  const key = ['fixture', Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url'), 'fixture'].join('.');
  const f = buildFixture({ SUPABASE_URL: 'https://audit.invalid', SUPABASE_ANON_KEY: key });
  try { assert.notEqual(f.result.status, 0); assert.ok(!f.result.stderr.includes(key)); } finally { f.cleanup(); }
});
test('public fixture config builds assets, prevents script-breakout, and remains valid JS', () => {
  const f = buildFixture({ SUPABASE_URL: 'https://audit.invalid', SUPABASE_ANON_KEY: 'sb_publishable_fixture', VAPID_PUBLIC_KEY: "'</script><script>fixture()</script>" });
  try {
    assert.equal(f.result.status, 0, f.result.stderr); const built = fs.readFileSync(path.join(f.dir, 'dist/index.html'), 'utf8');
    assert.ok(!built.includes('__SUPABASE_')); assert.ok(!built.includes('</script><script>fixture()'));
    for (const m of built.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!m[1].includes('src=')) new vm.Script(m[2]);
    for (const file of ['manifest.json', 'sw.js', 'scriptable/smart-fridge.js', 'icons/icon-512.png', 'personal-data/export.js', 'personal-data/ui.js']) assert.ok(fs.existsSync(path.join(f.dir, 'dist', file)));
  } finally { f.cleanup(); }
});
test('production AI and scheduled handlers fail closed before provider or database work',async()=>{
  for(const file of ['api/dietitian-chat.js','api/dietitian-weekly-summary.js','api/send-expiry-notifications.js']){
    const f=fixture({env:{SF_ENABLE_AI_CHAT:'',SF_ENABLE_AUTOMATIONS:'',SF_ENABLE_NOTIFICATIONS:''},db:{from(){throw Error('DB must not be read');}}});
    const r=response();await f.load(file)({method:'POST',headers:{authorization:file.includes('dietitian-chat')?'Bearer fixture-token':'Bearer fixture-cron'},body:{message:'fixture'}},r);
    assert.equal(r.statusCode,503);assert.equal(f.calls.fetch.length,0);
  }
  const cfg=JSON.parse(fs.readFileSync(path.join(root,'vercel.json'),'utf8'));assert.deepEqual(cfg.crons,[]);
});
test('release status reports disabled nutrition, AI and broadcasts without secrets',async()=>{
  const f=fixture({env:{SF_ENABLE_AI_CHAT:'',SF_ENABLE_AUTOMATIONS:'',SF_ENABLE_NOTIFICATIONS:'',VERCEL_GIT_COMMIT_SHA:'fixture-sha'}}),r=response();
  await f.load('api/release-status.js')({method:'GET'},r);assert.equal(r.statusCode,200);assert.equal(r.body.commit,'fixture-sha');
  for(const key of ['nutritionEnabled','aiEnabled','notificationsEnabled','automationsEnabled'])assert.equal(r.body[key],false);
  assert.ok(!JSON.stringify(r.body).includes('fixture-cron'));
});
