// Browser + local PostgreSQL policies. Auth, SDK transport and remote resources are fixtures.
const {chromium}=require('playwright');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const {createStockDb,user,other,household}=require('./helpers/stock-db.cjs');
const A='30000000-0000-4000-8000-000000000001',B='30000000-0000-4000-8000-000000000002';
(async()=>{
 const f=await createStockDb();const root=path.join(__dirname,'..');
 for(const [id,name,weight,excluded] of [[A,'Личный А',60,['egg']],[B,'Личный Б',90,[]]]){
 await f.db.query(`insert into family_profiles(id,household_id,created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg,excluded_foods) values($1,$2,$3,$3,$4,'male',30,170,$5,$6)`,[id,household,user,name,weight,excluded]);
 await f.db.query("insert into family_measurements(profile_id,log_date,weight) values($1,'2026-11-03',$2)",[id,weight]);
 }
 let actor=user,delayA=false,denyProfiles=false;const calls=[],errors=[],external=[];
 const stub=`window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{user:{id:'${user}',email:'test@example.test'}}}}),getUser:async()=>({data:{user:{id:'${user}'}}}),onAuthStateChange:cb=>{window.authCallback=cb},signOut:async()=>({error:null})},rpc:async()=>({data:null,error:null}),from(table){let filters=[],one=false;const c={select(){return this},eq(k,v){filters.push([k,v]);return this},order(){return this},limit(){return this},maybeSingle(){one=true;return this},single(){one=true;return this},then(ok,bad){return fetch('/fixture/read',{method:'POST',body:JSON.stringify({table,filters})}).then(r=>r.json()).then(r=>({...r,data:one?r.data?.[0]||null:r.data})).then(ok,bad)}};return c}})};`;
 const server=http.createServer(async(req,res)=>{
 try{
 if(req.url==='/fixture/read'){
 let body='';for await(const c of req)body+=c;const {table,filters}=JSON.parse(body);calls.push({table,filters});
 if(table==='family_profiles'&&denyProfiles)return res.end(JSON.stringify({data:null,error:{code:'42703'}}));
 if(table==='family_measurements'&&delayA&&filters.some(([k,v])=>v===A))await new Promise(r=>setTimeout(r,400));
 let rows=[];
 if(['family_profiles','family_measurements'].includes(table)){
 const allowed=['id','profile_id','profile_owner_user_id','household_id'];assert.ok(filters.every(([k])=>allowed.includes(k)));
 rows=await f.db.transaction(async tx=>{await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor,session_id:actor})]);return (await tx.query(`select * from ${table}`+(filters.length?' where '+filters.map(([k],i)=>`${k}=$${i+1}`).join(' and '):''),filters.map(x=>x[1]))).rows;});
 }else if(table==='household_members')rows=[{household_id:household}];else if(table==='households')rows=[{invite_code:'TEST'}];
 res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:rows,error:null}));
 }
 const file=path.join(root,'dist',req.url==='/'?'index.html':req.url.split('?')[0]);
 if(!fs.existsSync(file)){res.statusCode=404;return res.end();}
 res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'application/javascript':'image/png');
 // Test-only enablement on loopback to exercise held-back UI against candidate RLS.
 // Production source/build retain SF_NUTRITION_ENABLED=false.
 const content=fs.readFileSync(file);
 res.end(file.endsWith('index.html')?content.toString().replace('const SF_NUTRITION_ENABLED = false;','const SF_NUTRITION_ENABLED = true;'):content);
 }catch(e){res.end(JSON.stringify({data:null,error:{message:e.message}}));}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
 const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block',reducedMotion:'reduce'});
 await context.route('**/*',route=>{const u=route.request().url();if(u.startsWith('http://127.0.0.1:'))return route.continue();if(u.includes('@supabase/supabase-js'))return route.fulfill({contentType:'application/javascript',body:stub});external.push(u);return route.fulfill({body:''});});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(uid=>localStorage.setItem('sf_onboarding_seen_'+uid,'1'),user);
 const out=process.env.SF_EVIDENCE_DIR||'/tmp/sf-privacy-evidence';fs.mkdirSync(out,{recursive:true});
 try{
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>familyProfiles.length===2);await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}'});
 await page.evaluate(()=>{history=['diet'];showScreen('diet',false)});await page.click(`[data-profile="${A}"]`);await page.waitForFunction(()=>!document.getElementById('screen-diet-member').hidden);
 assert.match(await page.textContent('#meals-container'),/не рекомендован/i);assert.equal(await page.evaluate(()=>weekRequiredItems().length),0);assert.equal(await page.locator('#missing-alert').isVisible(),false);
 await page.evaluate(()=>{renderRecipesList();renderSuggestRow();openRecipe('r5')});assert.match(await page.textContent('#recipes-list'),/не рекоменду|не рекомендован/i);assert.notEqual(await page.evaluate(()=>history.at(-1)),'recipe-detail');
 await page.screenshot({path:path.join(out,'desktop-exclusions.png'),fullPage:true});console.log('PASS privacy browser: exclusions block menu, catalogue, home, direct recipe and generated shopping needs');
 delayA=true;await page.evaluate(([a,b])=>{window.pendingA=openFamilyMember(a);window.pendingB=openFamilyMember(b)},[A,B]);await page.evaluate(()=>Promise.all([pendingA,pendingB]));
 assert.equal(await page.evaluate(()=>currentProfileId),B);assert.equal(await page.evaluate(()=>measurementHistory.at(-1).weight),90);assert.equal(await page.inputValue('#slider-weight'),'90');console.log('PASS privacy browser: delayed profile A cannot replace profile B data');
 await page.evaluate(()=>openRecipe('r5'));assert.equal(await page.evaluate(()=>history.at(-1)),'recipe-detail');
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{history=['dietitian'];showScreen('dietitian',false);loadDietitianScreen()});assert.equal(await page.locator('#dietitian-input').isDisabled(),true);assert.equal(await page.locator('#dietitian-voice-toggle').isVisible(),false);
 assert.equal(calls.some(c=>c.table.startsWith('dietitian_')),false);assert.equal(external.some(u=>/generativelanguage|gemini/.test(u)),false);await page.screenshot({path:path.join(out,'mobile-ai-disabled.png'),fullPage:true});console.log('PASS privacy browser: chat disabled, no account history read and no Gemini request');
 actor=other;await page.evaluate(uid=>{currentUserId=uid;return loadFamilyProfiles()},other);assert.equal(await page.evaluate(()=>familyProfiles.length),0);assert.equal(await page.evaluate(()=>measurementHistory.length),0);assert.equal(await page.textContent('#recipe-ingredients'),'');
 denyProfiles=true;actor=user;await page.evaluate(uid=>{currentUserId=uid;return loadFamilyProfiles()},user);assert.equal(await page.evaluate(()=>familyProfiles.length),0);assert.ok(calls.filter(c=>c.table==='family_profiles').every(c=>c.filters.some(([k])=>k==='profile_owner_user_id')));console.log('PASS privacy browser: same-family user denied; unknown schema fails closed without family fallback');
 await page.evaluate(()=>{localStorage.setItem('sf_diet_settings_old','private');authCallback('SIGNED_OUT',null)});assert.equal(await page.evaluate(()=>localStorage.getItem('sf_diet_settings_old')),null);assert.equal(await page.evaluate(()=>currentUserId),null);
 assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));console.log('PASS privacy browser: logout clears private state/cache; no page errors; mobile fits');
 }finally{await browser.close();await new Promise(r=>server.close(r));await f.db.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
