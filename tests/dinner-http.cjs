// Real SDK/PostgREST/native PostgreSQL + application UI. All data is disposable.
const {Pool,types}=require('pg');const {spawn}=require('node:child_process');const {once}=require('node:events');const net=require('node:net'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const {randomUUID,randomBytes,createHmac}=require('node:crypto');const {createClient}=require('@supabase/supabase-js');const {chromium}=require('playwright');
const {createStockDb,user,other,stranger,household,otherHousehold}=require('./helpers/stock-db.cjs');
const root=path.join(__dirname,'..'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function main(){
 const base=new URL(process.env.SF_TEST_DATABASE_URL||'http://missing'),binary=process.env.SF_TEST_POSTGREST_BIN;
 if(!['postgres:','postgresql:'].includes(base.protocol)||base.hostname!=='127.0.0.1'||!/^\/sf_stock_test_[a-z0-9_]+$/.test(base.pathname)||!binary||!path.isAbsolute(binary))throw Error('Use disposable localhost sf_stock_test_* and absolute PostgREST binary');
 const admin=new Pool({connectionString:base.href}),name='sf_stock_test_dinner_'+randomBytes(6).toString('hex');let pool,pgrst,exit,server,browser;const checks=[],logs=[],errors=[],requests=[];let transport='normal',myDataDrop=false;
 try{
  await admin.query('create database '+name);const url=new URL(base);url.pathname='/'+name;pool=new Pool({connectionString:url.href,max:12});types.setTypeParser(1082,v=>v);
  const database={exec:s=>pool.query(s),query:(s,a)=>pool.query(s,a),transaction:async fn=>{const c=await pool.connect();try{await c.query('begin');const r=await fn({exec:s=>c.query(s),query:(s,a)=>c.query(s,a)});await c.query('commit');return r;}catch(e){await c.query('rollback');throw e;}finally{c.release();}}};
  const f=await createStockDb({database,enableDinner:true}),profile='30000000-0000-4000-8000-000000000001';
  await pool.query("insert into family_profiles(id,household_id,created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg) values($1,$2,$3,$3,'Профиль для ужина','male',30,170,70)",[profile,household,user]);
  const otherProfile='30000000-0000-4000-8000-000000000002';await pool.query("insert into family_profiles(id,household_id,created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg) values($1,$2,$3,$3,'Other private','male',30,170,70)",[otherProfile,household,other]);
  const apiRole='sf_dinner_api_'+randomBytes(4).toString('hex'),password=randomBytes(24).toString('hex');await pool.query(`create role ${apiRole} login noinherit password '${password}';grant authenticated,anon to ${apiRole}`);
  const apiUrl=new URL(url);apiUrl.username=apiRole;apiUrl.password=password;const apiPort=await port(),apiOrigin='http://127.0.0.1:'+apiPort,secret=randomBytes(32).toString('hex');
  const jwt=as=>{const a=Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),b=Buffer.from(JSON.stringify({role:as?'authenticated':'anon',...(as?{sub:as,session_id:as}:{}),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');return a+'.'+b+'.'+createHmac('sha256',secret).update(a+'.'+b).digest('base64url')};
  pgrst=spawn(binary,[],{env:{...process.env,DYLD_LIBRARY_PATH:process.env.SF_TEST_POSTGREST_LIBRARY_PATH||'',PGRST_DB_URI:apiUrl.href,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:secret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(apiPort),PGRST_DB_POOL:'10'},stdio:['ignore','pipe','pipe']});exit=once(pgrst,'exit');pgrst.stdout.on('data',b=>logs.push(String(b)));pgrst.stderr.on('data',b=>logs.push(String(b)));
  let ready=false;for(let i=0;i<80;i++){try{if((await fetch(apiOrigin)).ok){ready=true;break}}catch{}await pause(100)}assert.ok(ready,logs.join(''));
  const token=jwt(user),anon=jwt(null);
  server=http.createServer(async(req,res)=>{try{
   if(req.url.startsWith('/rest/v1/')){let data='';for await(const c of req)data+=c;let mode='normal';if(req.url==='/rest/v1/rpc/dinner_mutate'&&JSON.parse(data).kind!=='snapshot'){mode=transport;transport='normal';requests.push(JSON.parse(data));}
    if(req.url==='/rest/v1/rpc/sf_my_data'&&JSON.parse(data).action==='delete'&&myDataDrop){mode='drop-after';myDataDrop=false;}
    if(mode==='fail-before'){res.writeHead(503,{'Content-Type':'application/json'});return res.end('{"message":"injected transport"}')}
    const upstream=await fetch(apiOrigin+req.url.slice('/rest/v1'.length),{method:req.method,headers:{...req.headers,host:'127.0.0.1:'+apiPort},...(data?{body:data}:{})}),body=await upstream.text();
    if(mode==='drop-after'&&upstream.ok){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"operation_id":')}
    res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json'});return res.end(body);}
   if(req.url.startsWith('/auth/v1/logout')){res.statusCode=204;return res.end();}
   if(req.url==='/auth/v1/user'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({id:user,email:'fixture@example.test',role:'authenticated',aud:'authenticated'}));}
   if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(fs.readFileSync(path.join(root,'index.html'),'utf8').replaceAll("'__DINNER_ENABLED__'", "'1'").replaceAll("'__SUPABASE_URL__'",JSON.stringify(origin)).replaceAll("'__SUPABASE_ANON_KEY__'",JSON.stringify(anon)));}
   if(/^\/dinner\/(model\.js|queue\.js|ui\.js|catalog\.json|style\.css)$/.test(req.url)){res.setHeader('Content-Type',req.url.endsWith('.json')?'application/json':req.url.endsWith('.css')?'text/css':'application/javascript');return res.end(fs.readFileSync(path.join(root,req.url.slice(1))));}
   if(/^\/personal-data\/(ui|export)\.js$/.test(req.url)){res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(path.join(root,req.url.slice(1))));}
   if(req.url==='/manifest.json'){res.setHeader('Content-Type','application/json');return res.end('{}')};res.statusCode=404;res.end();
  }catch(e){res.statusCode=500;res.end(JSON.stringify({message:e.message}))}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const client=as=>createClient(origin,anon,{accessToken:async()=>jwt(as),auth:{persistSession:false,autoRefreshToken:false}}),a=client(user),b=client(other),c=client(stranger);
  const rpc=(cl,kind,body={},id=randomUUID())=>cl.rpc('dinner_mutate',{op_id:id,hh_id:household,kind,body}),must=async p=>{const r=await p;if(r.error)throw Error(JSON.stringify(r.error));return r.data},row=async id=>(await pool.query('select * from fridge_items where id=$1',[id])).rows[0];
  const today=(await must(rpc(a,'snapshot'))).today,profiles=[{id:profile,mode:'standard',exclusions:[]}],meals=[{id:'today',recipe_id:'cheese-cucumber',recipe_version:1,portions:1,day:today}];
  async function lot(ingredient,qty=500){const id=await f.add(qty);await must(rpc(a,'confirm_lot',{id,expected_version:0,ingredient_id:ingredient,qty_num:qty,unit:'г',expires_on:'2099-01-01'}));return id;}
  const cheese=await lot('cheese'),cucumber=await lot('cucumber');
  const expense=async(amount=20)=>({profiles,meals,deltas:[{id:cheese,expected_version:(await row(cheese)).dinner_version,amount},{id:cucumber,expected_version:(await row(cucumber)).dinner_version,amount:100}]});
  const check=s=>{checks.push(s);console.log('PASS DINNER HTTP: '+s)};
  const conflict=await rpc(c,'consume',await expense());assert.equal(conflict.error.code,'42501');assert.equal((await c.from('dinner_events').select('*')).data.length,0);check('real JWT/PostgREST rejects another household and RLS hides journal');
  const mine=await must(rpc(a,'snapshot')),theirs=await must(rpc(b,'snapshot'));assert.deepEqual(mine.profiles.map(p=>p.id),[profile]);assert.deepEqual(theirs.profiles.map(p=>p.id),[otherProfile]);assert.equal('start_weight_kg' in mine.profiles[0],false);assert.equal((await rpc(b,'consume',await expense())).error.code,'42501');check('owned minimal profiles only; no same-family personal-data fallback');
  // Hold household lock so both independent API sessions are demonstrably waiting.
  const blocker=await pool.connect();await blocker.query('begin');await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[household]);const body=await expense(),op=randomUUID();const concurrent=[rpc(a,'consume',body,op),rpc(a,'consume',body,op)].map(p=>Promise.resolve(p));
  let waiting=0;for(let i=0;i<40;i++){waiting=Number((await pool.query("select count(*) n from pg_locks where locktype='advisory' and not granted")).rows[0].n);if(waiting>=2)break;await pause(50)}assert.ok(waiting>=2,'two API sessions await same lock');await blocker.query('commit');blocker.release();for(const result of await Promise.all(concurrent))assert.equal(result.error,null);assert.equal(Number((await row(cheese)).qty_num),480);assert.equal((await pool.query('select count(*)::int n from dinner_events')).rows[0].n,1);await must(rpc(a,'undo',{operation_id:op}));check('two blocked API sessions replay one batch UUID once; common undo restores all lots');
  // Distinct users race on one opening snapshot: only one whole meal commits.
  const stale=await expense();const race=await Promise.all([rpc(a,'consume',stale),rpc(b,'consume',{...stale,profiles:[{id:otherProfile,mode:'standard',exclusions:[]}]})]);assert.equal(race.filter(r=>!r.error).length,1);assert.equal(race.filter(r=>r.error?.code==='40001').length,1);assert.equal(Number((await row(cheese)).qty_num),480);assert.equal(Number((await row(cucumber)).qty_num),400);check('two family members racing commit one complete batch, never one ingredient each');
  const winner=race[0].data?a:b,winningId=(race[0].data||race[1].data).operation_id;
  const interop=await Promise.all([rpc(winner,'undo',{operation_id:winningId}),b.rpc('stock_mutate',{op_id:randomUUID(),hh_id:household,kind:'used',body:{id:cheese,expected_qty:480,expected_unit:'г',amount:1}})]);
  assert.equal(interop.filter(r=>!r.error).length,1);
  if(!interop[0].error){assert.equal(Number((await row(cheese)).qty_num),500);assert.equal(Number((await row(cucumber)).qty_num),500)}
  else{assert.equal(Number((await row(cheese)).qty_num),479);assert.equal(Number((await row(cucumber)).qty_num),400)}
  check('batch undo versus ordinary stock consumption serializes without overwriting either ingredient');
  const gate=await pool.connect();await gate.query('begin');await gate.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[household]);
  const queued=Promise.resolve(rpc(b,'consume',{...await expense(),profiles:[{id:otherProfile,mode:'standard',exclusions:[]}]}));let queuedCount=0;
  for(let i=0;i<40;i++){queuedCount=Number((await pool.query("select count(*) n from pg_locks where locktype='advisory' and not granted")).rows[0].n);if(queuedCount)break;await pause(50)}assert.ok(queuedCount);
  await pool.query('update household_members set household_id=$1 where user_id=$2',[otherHousehold,other]);await gate.query('commit');gate.release();assert.equal((await queued).error.code,'42501');await pool.query('update household_members set household_id=$1 where user_id=$2',[household,other]);
  check('membership revoked while a dinner request waits prevents the queued write');
  // Restore clean rows for a real interactive browser journey, using test setup only.
  await pool.query('update fridge_items set qty_num=case ingredient_id when $1 then 20 else 500 end',[ 'cheese' ]);
  await pool.query("update fridge_items set quantity_source='legacy_unknown' where id=$1",[cheese]);
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',serviceWorkers:'block'}),sdk=fs.readFileSync(path.join(root,'node_modules/@supabase/supabase-js/dist/umd/supabase.js'),'utf8');
  await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.fulfill({contentType:'application/javascript',body:route.request().url().includes('@supabase/supabase-js')?sdk:''}));
  await context.addInitScript(({token,user})=>{localStorage.setItem('sf_onboarding_seen_'+user,'1');if(!localStorage.getItem('sf_dinner_fixture_seeded')){localStorage.setItem('sf_dinner_fixture_seeded','1');localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture-unused',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:user,email:'fixture@example.test',role:'authenticated',aud:'authenticated'}}));}},{token,user});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.waitForFunction(()=>userDataLoaded&&document.querySelector('[data-dinner-profile]'));
  await page.evaluate(()=>{history=['recipes'];showScreen('recipes',false)});await page.check('[data-dinner-profile="'+profile+'"]');await page.selectOption('#dinner-recipe','cheese-cucumber');
  assert.match(await page.textContent('#recipes-list'),/количество нужно уточнить/);
  await page.click('#dinner-lots summary');await page.fill('[data-lot-quantity="'+cheese+'"]','20');transport='fail-before';await page.click('[data-confirm-lot="'+cheese+'"]');
  await page.waitForFunction(()=>document.querySelector('#dinner-retry')&&!document.querySelector('#dinner-retry').disabled);assert.equal(await page.inputValue('[data-lot-quantity="'+cheese+'"]'),'20');await page.click('#dinner-retry');await page.waitForFunction(()=>document.querySelector('#dinner-status').textContent==='Сохранено.');assert.equal((await row(cheese)).quantity_source,'user');
  await pool.query("update family_profiles set excluded_foods=array['dairy','egg'] where id=$1",[profile]);await page.click('#dinner-refresh');await page.waitForFunction(()=>document.querySelectorAll('[data-dinner-card]').length===1);assert.equal(await page.locator('[data-dinner-card="vegetable-salad"]').count(),1);
  await pool.query("update family_profiles set excluded_foods='{}' where id=$1",[profile]);await page.click('#dinner-refresh');await page.waitForFunction(()=>document.querySelectorAll('[data-dinner-card]').length===3);await page.selectOption('#dinner-recipe','cheese-cucumber');
  await page.fill('#dinner-portions','2');await page.locator('#dinner-portions').blur();assert.match(await page.textContent('#recipes-list'),/не хватает 40 г/);await page.fill('#dinner-portions','1');await page.locator('#dinner-portions').blur();
  await page.evaluate(id=>openProduct('fridge',fridgeData.findIndex(p=>p._id===id)),cucumber);await page.fill('#use-product-qty','50');await page.click('#use-product-btn');await page.waitForFunction(()=>/Сохранено/.test(document.querySelector('#stock-save-message').textContent));
  await page.click('.nav-item[data-nav=recipes]');await page.waitForFunction(id=>document.querySelector('[data-lot-quantity="'+id+'"]').value==='450',cucumber);
  await page.click('#stock-undo-btn');await page.waitForFunction(id=>document.querySelector('[data-lot-quantity="'+id+'"]').value==='500',cucumber);check('ordinary stock use/undo refreshes dinner lots when returning to recipes');
  await page.click('#dinner-week-shopping');await page.waitForFunction(()=>document.querySelector('#dinner-status').textContent==='Сохранено.');let weekly=(await must(rpc(a,'snapshot'))).cart_items;assert.equal(Number(weekly.find(c=>c.ingredient_id==='cheese').qty_num),190);assert.equal(weekly.length,2);
  check('mobile provenance form retains failed input; profile restrictions, portion changes and weekly 190 g demand work');
  assert.match(await page.textContent('#recipes-list'),/не хватает 10 г/);await page.click('#dinner-shopping');await page.waitForFunction(()=>/Сохранено/.test(document.querySelector('#dinner-status').textContent));const cart=(await must(rpc(a,'snapshot'))).cart_items.find(c=>c.dinner_scope);assert.equal(Number(cart.qty_num),10);
  await page.fill('#dinner-purchases input[type=date]','2099-01-01');transport='fail-before';await page.click('#dinner-buy-'+cart.id);
  await page.waitForFunction(()=>document.querySelector('#dinner-retry')&&!document.querySelector('#dinner-retry').disabled);assert.equal(await page.inputValue('#dinner-purchases input[type=date]'),'2099-01-01');await page.click('#dinner-retry');
  await page.waitForFunction(()=>document.querySelector('#dinner-status').textContent==='Сохранено.'&&!document.querySelector('#dinner-purchases'));
  for(let i=0;i<3;i++)await page.click('#dinner-next-step');await page.click('#dinner-cooked');await page.waitForSelector('#dinner-actual');
  const actualInputs=page.locator('[data-actual-lot]');const count=await actualInputs.count();for(let i=0;i<count;i++){const input=actualInputs.nth(i),id=await input.getAttribute('data-actual-lot');if(id===cucumber)await input.fill('100');}
  const eventsBeforeCancel=(await pool.query('select count(*)::int n from dinner_events')).rows[0].n;await page.click('#dinner-cancel');assert.equal((await pool.query('select count(*)::int n from dinner_events')).rows[0].n,eventsBeforeCancel,'cancel adds no event');
  for(let i=0;i<3;i++)await page.click('#dinner-next-step');await page.click('#dinner-cooked');await page.waitForSelector('#dinner-actual');await page.fill('[data-actual-lot="'+cucumber+'"]','100');transport='drop-after';await page.click('#dinner-confirm');await page.waitForFunction(()=>document.querySelector('#dinner-retry')&&!document.querySelector('#dinner-retry').disabled);const lost=requests.at(-1).op_id;assert.equal(Number((await row(cucumber)).qty_num),400);
  await page.reload();await page.waitForFunction(()=>userDataLoaded);await page.evaluate(()=>{history=['recipes'];showScreen('recipes',false)});await page.click('#dinner-retry');await page.waitForFunction(()=>document.querySelector('#dinner-status').textContent==='Сохранено.');assert.equal(requests.at(-1).op_id,lost);assert.equal(Number((await row(cucumber)).qty_num),400);
  await page.click('#dinner-undo');await page.waitForFunction(()=>/отменён/.test(document.querySelector('#dinner-status').textContent));assert.equal(Number((await row(cucumber)).qty_num),500);check('mobile UI → exact 10 g purchase → steps → cancel → partial batch → lost reply/reload → retry → common undo');
  await page.waitForSelector('[data-dinner-profile]');assert.doesNotMatch(await page.textContent('#recipes-list'),/Загружаем подтверждённые данные/);
  const out=process.env.SF_DINNER_EVIDENCE_DIR||'/tmp/sf-dinner-http-evidence';fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'mobile-dinner-undo.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);check('mobile screen recovers after reload, fits and has no uncaught errors');
  await page.selectOption('#dinner-recipe','cheese-cucumber');for(let i=0;i<3;i++)await page.click('#dinner-next-step');await page.click('#dinner-cooked');await page.waitForSelector('#dinner-actual');await page.fill('[data-actual-lot="'+cucumber+'"]','100');transport='drop-after';await page.click('#dinner-confirm');await page.waitForFunction(()=>document.querySelector('#dinner-retry')&&!document.querySelector('#dinner-retry').disabled);const lostOnLogout=requests.at(-1).op_id;
  await page.click('.nav-item[data-nav=home]');await page.click('#home-avatar');await Promise.all([page.waitForEvent('load'),page.click('#logout-btn')]);await page.waitForFunction(()=>currentUserId===null);assert.doesNotMatch(await page.textContent('#recipes-list'),/Профиль для ужина/);assert.equal(await page.locator('#recipes-list input').count(),0);
  const persisted=await page.evaluate(()=>JSON.stringify(Object.entries(localStorage).filter(([k])=>k.startsWith('sf_dinner_v1_'))));assert.ok(!persisted.includes(profile));assert.ok(persisted.includes('resolve'));
  await page.evaluate(({token,user})=>localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture-unused',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:user,email:'fixture@example.test',role:'authenticated',aud:'authenticated'}})),{token,user});await page.reload();await page.waitForFunction(()=>userDataLoaded);await page.click('.nav-item[data-nav=recipes]');await page.click('#dinner-retry');await page.waitForFunction(()=>document.querySelector('#dinner-status').textContent==='Сохранено.');assert.equal(requests.at(-1).kind,'resolve');assert.equal(requests.at(-1).op_id,lostOnLogout);assert.deepEqual(requests.at(-1).body,{});assert.equal(Number((await row(cucumber)).qty_num),400);
  await page.click('#dinner-undo');await page.waitForFunction(()=>/отменён/.test(document.querySelector('#dinner-status').textContent));assert.equal(Number((await row(cucumber)).qty_num),500);check('logout clears personal context and private intent; opaque resolution after login never repeats use');
  // The final owner bridge was installed with the isolated migrations.

  let exported;for(let i=0;i<40;i++){exported=await a.rpc('sf_dinner_my_data');if(exported.error?.code!=='PGRST202')break;await pause(100)}
  assert.equal(exported.error,null);assert.ok(exported.data.operations.some(o=>o.id===lostOnLogout));
  const bExport=await b.rpc('sf_dinner_my_data');assert.equal(bExport.error,null);assert.ok(!bExport.data.operations.some(o=>o.id===lostOnLogout));
  assert.ok(!JSON.stringify(exported.data).includes('Other private'));assert.ok(!JSON.stringify(exported.data).includes('before_lots'));
  check('Integrated own dinner export uses real HTTP; another member cannot export its private context');
  const oldRead=await a.rpc('sf_my_data',{action:'read'});assert.equal(oldRead.error?.message,'client_upgrade_required');
  const combined=await must(a.rpc('sf_my_data',{action:'read_v2'}));assert.equal(combined.export_contract,2);assert.ok(combined.dinner.operations.some(o=>o.id===lostOnLogout));assert.deepEqual(combined.profiles.map(p=>p.id),[profile]);
  await page.evaluate(()=>{history=['profile'];showScreen('profile',false)});await page.click('#my-data-open');await page.waitForFunction(()=>!document.querySelector('#my-data-json').disabled);
  let file=page.waitForEvent('download');await page.click('#my-data-json');let saved=await file;const json=JSON.parse(fs.readFileSync(await saved.path(),'utf8'));assert.ok(json.dinner.operations.some(o=>o.id===lostOnLogout));assert.ok(!JSON.stringify(json).includes('Other private'));
  file=page.waitForEvent('download');await page.click('#my-data-csv');saved=await file;const csv=fs.readFileSync(await saved.path(),'utf8');assert.ok(csv.includes('dinner_operations'));assert.ok(csv.includes('dinner_events'));assert.ok(!csv.includes('Other private'));
  await page.evaluate(()=>{history=['recipes'];showScreen('recipes',false)});
  check('combined My Data v2 exports own dinner JSON/CSV in actual browser; old exporter is refused instead of returning a partial archive');


  // My Data sends this event before a deletion can have an unknown outcome.
  await page.locator('[data-dinner-profile="'+profile+'"]').check();
  await page.selectOption('#dinner-recipe','cheese-cucumber');for(let i=0;i<3;i++)await page.click('#dinner-next-step');await page.click('#dinner-cooked');await page.waitForSelector('#dinner-actual');await page.fill('[data-actual-lot="'+cucumber+'"]','100');transport='drop-after';await page.click('#dinner-confirm');await page.waitForFunction(()=>document.querySelector('#dinner-retry')&&!document.querySelector('#dinner-retry').disabled);const beforeDelete=requests.at(-1).op_id;
  await page.evaluate(()=>{history=['profile'];showScreen('profile',false)});await page.click('#my-data-open');await page.waitForFunction(()=>!document.querySelector('#my-data-json').disabled);
  await page.locator('#my-data-content details').first().locator('summary').click();await page.getByRole('button',{name:'Удалить личный профиль',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#my-data-confirmation').hidden);await page.fill('#my-data-confirm','УДАЛИТЬ');myDataDrop=true;await page.click('#my-data-delete');await page.waitForFunction(()=>document.querySelector('#my-data-status').textContent.includes('не подтверждено'));
  const cleared=await page.evaluate(()=>JSON.stringify(Object.entries(localStorage).filter(([k])=>k.startsWith('sf_dinner_v1_'))));assert.ok(!cleared.includes(profile));assert.ok(cleared.includes('resolve'));assert.doesNotMatch(await page.textContent('#recipes-list'),/Профиль для ужина/);
  await page.click('#my-data-delete');await page.waitForFunction(()=>document.querySelector('#my-data-status').textContent.includes('Удаление из активной базы подтверждено'));
  await page.evaluate(()=>{history=['recipes'];showScreen('recipes',false)});
  const erased=(await pool.query('select payload,profile_context_erased_at from sf_private.dinner_operations where id=$1',[beforeDelete])).rows[0];assert.deepEqual(erased.payload,{});assert.ok(erased.profile_context_erased_at);
  await page.click('#dinner-retry');await page.waitForFunction(()=>document.querySelector('#dinner-status').textContent==='Сохранено.');assert.equal(requests.at(-1).kind,'resolve');assert.equal(requests.at(-1).op_id,beforeDelete);assert.equal(Number((await row(cucumber)).qty_num),400);
  await page.click('#dinner-undo');await page.waitForFunction(()=>/отменён/.test(document.querySelector('#dinner-status').textContent));assert.equal(Number((await row(cucumber)).qty_num),500);
  assert.ok(!JSON.stringify((await a.rpc('sf_dinner_my_data')).data).includes(profile));assert.deepEqual(errors,[]);
  check('Integrated deletion clears browser intent and stored profile context; opaque retry and undo preserve stock');

  // Pause consume after it holds the profile SHARE lock. DELETE must wait and
  // erase the newly committed receipt too, rather than miss its private input.
  await pool.query("insert into family_profiles(id,household_id,created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg) values($1,$2,$3,$3,'Race private','male',30,170,70)",[profile,household,user]);
  const raceDelete=await must(a.rpc('sf_my_data',{action:'prepare_delete',scope:'profile',profile_id:profile}));
  const raceId=randomUUID(),lockKey='dinner-profile-erase-'+raceId;
  await pool.query(`create function public.pause_dinner_privacy() returns trigger language plpgsql as $$begin perform pg_advisory_xact_lock(hashtextextended('${lockKey}',0));return new;end$$;create trigger pause_dinner_privacy before insert on public.dinner_events for each row when(new.id='${raceId}'::uuid) execute function public.pause_dinner_privacy()`);
  const hold=await pool.connect();await hold.query('begin');await hold.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);
  try{
  const inFlight=Promise.resolve(rpc(a,'consume',await expense(),raceId));
  let waits=0;for(let i=0;i<40;i++){waits=Number((await pool.query("select count(*) n from pg_locks where locktype='advisory' and not granted")).rows[0].n);if(waits)break;await pause(50)}assert.ok(waits);
  const deleting=Promise.resolve(a.rpc('sf_my_data',{action:'delete',scope:'profile',profile_id:profile,request_id:raceDelete.request_id}));
  let blockedDeletes=0;for(let i=0;i<40;i++){blockedDeletes=Number((await pool.query("select count(*) n from pg_locks where locktype='transactionid' and not granted")).rows[0].n);if(blockedDeletes)break;await pause(50)}assert.ok(blockedDeletes,'DELETE waits for in-flight profile lock');
  await hold.query('commit');assert.equal((await inFlight).error,null);assert.equal((await deleting).data.removed,1);
  assert.deepEqual((await pool.query('select payload from sf_private.dinner_operations where id=$1',[raceId])).rows[0].payload,{});
  const acknowledged=await rpc(a,'resolve',{},raceId);assert.equal(acknowledged.data.operation_state,'saved');await must(rpc(a,'undo',{operation_id:raceId}));
  check('Integrated simultaneous profile deletion waits for consume, then scrubs its new receipt without losing undo');
  }finally{await hold.query('rollback');hold.release();}

  await pool.query('delete from auth.sessions where id=$1',[user]);assert.equal((await rpc(a,'snapshot')).error?.code,'42501');assert.equal((await a.rpc('sf_dinner_my_data')).error?.code,'42501');assert.equal((await a.rpc('sf_my_data',{action:'read_v2'})).error?.code,'42501');
  await pool.query('insert into auth.sessions(id,user_id) values($1,$1)',[user]);
  check('revoked session rejects dinner snapshot, own dinner export and combined My Data despite a valid signed JWT');
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({checks,postgres:(await pool.query('select version()')).rows[0].version,errors,requests:requests.map(({op_id,kind})=>({op_id,kind}))},null,2));
 }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));if(pgrst&&pgrst.exitCode===null){pgrst.kill('SIGTERM');await exit;}if(pool)await pool.end();await admin.query('drop database if exists '+name+' with(force)');await admin.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
