// Real application + isolated PostgreSQL (PGlite). Auth/CDNs/transport are fixtures.
// Run: npm run test:browser. Uses an installed Chrome, or CHROME_PATH.
const {chromium}=require('playwright');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {createStockDb,user,household}=require('./helpers/stock-db.cjs');
(async()=>{
  const f=await createStockDb();await f.add();const cartId=await f.cart();
  let mode='normal',calls=[];const errors=[];
  const stub=`window.supabase={createClient:()=>({
    auth:{getSession:async()=>({data:{session:{user:{id:'${user}',email:'fixture@example.test'}}}}),getUser:async()=>({data:{user:{id:'${user}',email:'fixture@example.test'}}}),onAuthStateChange:()=>{}},
    rpc:async(name,args)=>fetch('/fixture/rpc',{method:'POST',body:JSON.stringify({name,args})}).then(r=>r.json()),
    from(table){let single=false;const chain={select(){return this},eq(){return this},order(){return this},limit(){return this},maybeSingle(){single=true;return this},single(){single=true;return this},then(ok,bad){return fetch('/fixture/read?table='+table).then(r=>r.json()).then(rows=>({data:single?(rows[0]||null):rows,error:null,count:rows.length})).then(ok,bad)}};return chain}
  })};`;
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/fixture/read'){
        const table=url.searchParams.get('table');
        const allowed=['fridge_items','cart_items','food_stats','food_events'];
        let rows=table==='household_members'?[{household_id:household,user_id:user}]:table==='households'?[{invite_code:'FIRST1'}]:[];
        if(allowed.includes(table))rows=(await f.db.query('select * from public.'+table)).rows;
        res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(rows));
      }
      if(url.pathname==='/fixture/rpc'){
        let body='';for await(const c of req)body+=c;const {name,args}=JSON.parse(body);
        if(name!=='stock_mutate') return res.end(JSON.stringify({data:null,error:null}));
        calls.push(args);
        const active=mode;mode='normal';
        if(active==='fail-before')return res.end(JSON.stringify({data:null,error:{message:'fixture unavailable'}}));
        if(active==='pending') await new Promise(r=>setTimeout(r,700));
        const result=await f.rpc(args.kind,args.body,{id:args.op_id,hh:args.hh_id});
        if(active==='drop-after'){res.setHeader('Content-Type','application/json');res.end('{"data":');return;}
        res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:result,error:null}));
      }
      if(url.pathname==='/fixture/supabase.js'){res.setHeader('Content-Type','application/javascript');return res.end(stub);}
      const file=url.pathname==='/'?'dist/index.html':'dist'+url.pathname;
      if(!fs.existsSync(path.join(__dirname,'..',file))){res.statusCode=404;return res.end();}
      res.setHeader('Content-Type',file.endsWith('html')?'text/html':file.endsWith('js')?'application/javascript':file.endsWith('css')?'text/css':file.endsWith('json')?'application/json':'image/png');
      res.end(fs.readFileSync(path.join(__dirname,'..',file)));
    }catch(e){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:null,error:{message:e.message,code:e.code}}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
  const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',async route=>{
    const url=route.request().url();if(url.startsWith('http://127.0.0.1:'))return route.continue();
    if(url.includes('@supabase/supabase-js'))return route.fulfill({contentType:'application/javascript',body:stub});
    return route.fulfill({contentType:'application/javascript',body:''});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(uid=>localStorage.setItem('sf_onboarding_seen_'+uid,'1'),user);
  const visible=async selector=>page.waitForFunction(s=>{const n=document.querySelector(s);return n&&!n.hidden&&getComputedStyle(n).display!=='none'},selector);
  const message=async regex=>page.waitForFunction(source=>new RegExp(source).test(document.getElementById('stock-save-message').textContent),regex.source);
  const state=()=>page.evaluate(()=>({fridge:fridgeData.map(p=>({...p})),cart:cartData.map(p=>({...p}))}));
  const out=process.env.SF_EVIDENCE_DIR||'/tmp/sf-stock-evidence';fs.mkdirSync(out,{recursive:true});
  try{
    await page.goto('http://127.0.0.1:'+port);await page.waitForFunction(()=>userDataLoaded&&document.getElementById('login-screen').style.display==='none');
    await page.waitForSelector('.sf-home-grid');
    assert.ok((await page.locator('#screen-home .sf-home-section-title').textContent()).includes('Есть дома'));
    assert.ok(await page.evaluate(()=>Array.from(document.styleSheets).some(s=>s.href?.includes('/ux/core-flow.css'))));
    await page.evaluate(()=>showScreen('fridge',false));
    await page.fill('#sf-stock-search','__not_a_product__');
    assert.match(await page.textContent('#sf-stock-result'),/Ничего не найдено/);
    await page.fill('#sf-stock-search','');
    await page.evaluate(()=>showScreen('home',false));
    console.log('PASS browser: UX core hierarchy, CSS and stock search');

    await page.evaluate(()=>openProduct('fridge',0));await page.fill('#use-product-qty','200');mode='pending';await page.click('#use-product-btn');await message(/Сохраняем/);
    assert.equal((await state()).fridge[0].qtyNum,500);await message(/Сохранено/);assert.equal((await state()).fridge[0].qtyNum,300);assert.equal(await page.textContent('#product-qty'),'300 г');
    await page.screenshot({path:path.join(out,'desktop-partial-use.png'),fullPage:true});
    await page.click('#stock-undo-btn');await message(/отменено/);assert.equal((await state()).fridge[0].qtyNum,500);
    assert.equal((await f.db.query('select count(*)::int n from food_events')).rows[0].n,0);
    console.log('PASS browser: pending → 300 g → undo → 500 g + empty journal');
    await page.evaluate(()=>{history=['cart'];showScreen('cart',false);renderCart();});mode='fail-before';await page.click('[data-bought="0"]');await message(/Не удалось/);
    assert.equal((await state()).cart.length,1);assert.equal((await state()).fridge.length,1);assert.equal(await page.locator('.cart-check').count(),0);
    await page.screenshot({path:path.join(out,'desktop-server-error.png'),fullPage:true});
    await page.click('#stock-retry-btn');await message(/Сохранено/);assert.equal((await state()).cart.length,0);assert.equal((await state()).fridge.length,2);
    assert.equal(calls.at(-1).op_id,calls.at(-2).op_id);console.log('PASS browser: server failure retains cart; retry transfers once with same ID');
    await page.click('#stock-undo-btn');await message(/отменено/);assert.equal((await state()).cart[0]._id,cartId);
    mode='drop-after';await page.click('[data-bought="0"]');await message(/Не удалось/);const lostId=calls.at(-1).op_id;
    await page.reload();await page.waitForFunction(()=>userDataLoaded);await visible('#stock-retry-btn');await page.click('#stock-retry-btn');await message(/Сохранено/);
    assert.equal(calls.at(-1).op_id,lostId);assert.equal((await state()).fridge.filter(p=>p._id===lostId).length,1);assert.equal((await state()).cart.length,0);
    console.log('PASS browser: lost response + reload + replay creates no duplicate');
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>{populateManualChecklist();openSheet(manualSheet);});
    await page.fill('#manual-custom-name','Неизвестный тестовый продукт');mode='fail-before';await page.click('#manual-custom-add-btn');await message(/Не удалось/);
    assert.equal(await page.inputValue('#manual-custom-name'),'Неизвестный тестовый продукт');
    await page.screenshot({path:path.join(out,'mobile-preserved-input.png'),fullPage:true});
    await page.click('#stock-retry-btn');await message(/Сохранено/);assert.equal(await page.inputValue('#manual-custom-name'),'');
    const unknown=(await state()).fridge.find(p=>p.name==='Неизвестный тестовый продукт');assert.equal(unknown.expiresOn,null);assert.equal(unknown.expiryEstimated,false);
    await page.evaluate(id=>{history=['fridge'];openProduct('fridge',fridgeData.findIndex(p=>p._id===id));},unknown._id);
    assert.match(await page.textContent('#product-exp'),/упаковке/);
    await page.locator('#use-product-btn').click({trial:true});
    await page.locator('#toss-product-btn').click({trial:true});
    await page.waitForFunction(()=>!document.getElementById('manual-sheet').classList.contains('open')&&getComputedStyle(document.getElementById('manual-sheet')).opacity==='0');
    await page.screenshot({path:path.join(out,'mobile-unknown-product.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
    console.log('PASS browser: mobile input retained on failure; unknown product has no invented expiry');
    assert.deepEqual(errors,[]);console.log('PASS browser: no uncaught page errors; mobile width fits');
    fs.writeFileSync(path.join(out,'browser-summary.json'),JSON.stringify({passed:5,errors,requests:calls.map(({op_id,kind})=>({op_id,kind})),viewport:[1280,900,390,844]},null,2));
  }finally{await browser.close();await new Promise(r=>server.close(r));await f.db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
