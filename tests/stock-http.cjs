// Opt-in integration suite. Requires a disposable localhost PostgreSQL database
// whose name starts with sf_stock_test_, plus a local PostgREST executable.
const {Pool}=require('pg');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const net=require('node:net');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes,createHmac}=require('node:crypto');
const {createClient}=require('@supabase/supabase-js');
const {createStockDb,user,other,stranger,household,otherHousehold}=require('./helpers/stock-db.cjs');
const root=path.join(__dirname,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function main(){
  const url=new URL(process.env.SF_TEST_DATABASE_URL||'http://missing');
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!/^\/sf_stock_test_[a-z0-9_]+$/.test(url.pathname)){
    throw Error('Refusing database access: use a disposable 127.0.0.1 database named sf_stock_test_*');
  }
  const binary=process.env.SF_TEST_POSTGREST_BIN;
  if(!binary||!path.isAbsolute(binary)||!fs.existsSync(binary))throw Error('Set SF_TEST_POSTGREST_BIN to a local PostgREST executable');
  const pool=new Pool({connectionString:url.href,max:12});
  const database={exec:sql=>pool.query(sql),query:(sql,args)=>pool.query(sql,args),transaction:async fn=>{
    const c=await pool.connect();try{await c.query('begin');const result=await fn({exec:sql=>c.query(sql),query:(sql,args)=>c.query(sql,args)});await c.query('commit');return result;}
    catch(e){await c.query('rollback');throw e;}finally{c.release();}
  }};
  let postgrest,postgrestExit,server,browser;
  const logs=[],requests=[],checks=[];let transportMode='normal';
  const jwtSecret=randomBytes(32).toString('hex');
  const jwt=(as=user,exp=Math.floor(Date.now()/1000)+3600)=>{
    const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const payload=Buffer.from(JSON.stringify({role:as?'authenticated':'anon',...(as?{sub:as}:{}),exp})).toString('base64url');
    return header+'.'+payload+'.'+createHmac('sha256',jwtSecret).update(header+'.'+payload).digest('base64url');
  };
  const check=(name)=>{checks.push(name);console.log('PASS HTTP: '+name);};
  try{
    const f=await createStockDb({database});
    await pool.query(fs.readFileSync(path.join(root,'supabase-family-profiles-migration.sql'),'utf8'));
    await pool.query('grant select,insert,update,delete on public.family_profiles,public.family_measurements to authenticated');
    const apiPassword=randomBytes(24).toString('hex');
    await pool.query(`create role sf_api_test login noinherit password '${apiPassword}'; grant authenticated,anon to sf_api_test;`);
    const apiUrl=new URL(url);apiUrl.username='sf_api_test';apiUrl.password=apiPassword;
    const apiPort=await freePort();const apiOrigin='http://127.0.0.1:'+apiPort;
    postgrest=spawn(binary,[],{env:{...process.env,DYLD_LIBRARY_PATH:process.env.SF_TEST_POSTGREST_LIBRARY_PATH||process.env.DYLD_LIBRARY_PATH||'',PGRST_DB_URI:apiUrl.href,PGRST_DB_SCHEMAS:'public',PGRST_DB_ANON_ROLE:'anon',PGRST_JWT_SECRET:jwtSecret,PGRST_SERVER_HOST:'127.0.0.1',PGRST_SERVER_PORT:String(apiPort),PGRST_DB_POOL:'10'},stdio:['ignore','pipe','pipe']});
    postgrestExit=once(postgrest,'exit');
    postgrest.stdout.on('data',b=>logs.push(String(b)));postgrest.stderr.on('data',b=>logs.push(String(b)));
    let ready=false;
    for(let n=0;n<80;n++){if(postgrest.exitCode!==null||postgrest.signalCode!==null)throw Error('PostgREST exited: '+logs.join(''));try{if((await fetch(apiOrigin)).ok){ready=true;break;}}catch{}await delay(100);}
    assert.ok(ready,'PostgREST did not start');
    const anonKey=jwt(null),browserToken=jwt(user);
    server=http.createServer(async(req,res)=>{
      try{
        if(req.url.startsWith('/rest/v1/')){
          let bytes='';for await(const c of req)bytes+=c;
          const isMutation=req.url==='/rest/v1/rpc/stock_mutate';
          let active='normal';if(isMutation){active=transportMode;transportMode='normal';requests.push(JSON.parse(bytes));}
          if(active==='fail-before'){res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:'injected transport failure'}));}
          const upstream=await fetch(apiOrigin+req.url.slice('/rest/v1'.length),{method:req.method,headers:{...req.headers,host:'127.0.0.1:'+apiPort},...(bytes?{body:bytes}:{})});
          const response=await upstream.text();
          if(active==='drop-after'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"operation_id":');}
          res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('content-type')||'application/json'});return res.end(response);
        }
        if(req.url==='/auth/v1/user'){
          res.setHeader('Content-Type','application/json');if(req.headers.authorization!=='Bearer '+browserToken){res.statusCode=401;return res.end('{}');}
          return res.end(JSON.stringify({id:user,email:'fixture@example.test',role:'authenticated',aud:'authenticated'}));
        }
        if(req.url==='/'){
          const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replaceAll("'__SUPABASE_URL__'",JSON.stringify(origin)).replaceAll("'__SUPABASE_ANON_KEY__'",JSON.stringify(anonKey));
          res.setHeader('Content-Type','text/html');return res.end(html);
        }
        if(req.url==='/manifest.json'){res.setHeader('Content-Type','application/json');return res.end('{}');}
        res.statusCode=404;res.end();
      }catch(e){res.statusCode=500;res.end(JSON.stringify({message:e.message}));}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
    const client=as=>createClient(origin,anonKey,{accessToken:async()=>jwt(as),auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    const a=client(user),b=client(other),c=client(stranger);
    const rpc=(client,kind,body,id=randomUUID())=>client.rpc('stock_mutate',{op_id:id,hh_id:household,kind,body});
    const must=async promise=>{const r=await promise;if(r.error)throw Error(JSON.stringify(r.error));return r.data;};
    const add=async()=>{const id=randomUUID();await must(rpc(a,'add_item',{name:'HTTP test',emoji:'📦',qty_num:500,unit:'г',compartment:'fridge',location:'Средняя полка',expires_on:'2026-11-08',expiry_estimated:true},id));return id;};
    const cart=async()=>{const id=randomUUID();await must(rpc(a,'add_cart',{name:'HTTP purchase',qty_num:500,unit:'г'},id));return id;};
    const buy=id=>({id,expected_qty:500,expected_unit:'г',compartment:'fridge',location:'Средняя полка',expires_on:'2026-11-08'});
    const spend=(id,qty=500,amount=200)=>({id,expected_qty:qty,expected_unit:'г',amount});
    const row=async id=>(await pool.query('select * from fridge_items where id=$1',[id])).rows[0];
    const expected=r=>Object.fromEntries(['name','emoji','qty_num','unit','location','expires_on','expiry_estimated','compartment'].map(k=>[k,k==='qty_num'?Number(r[k]):r[k]]));
    // node-postgres normally converts DATE to Date; keep canonical YYYY-MM-DD JSON.
    require('pg').types.setTypeParser(1082,value=>value);
    const raw=token=>fetch(origin+'/rest/v1/rpc/stock_mutate',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({op_id:randomUUID(),hh_id:household,kind:'add_cart',body:{name:'Denied',qty_num:1,unit:'шт'}})});
    assert.equal((await raw()).status,401);assert.equal((await raw(jwt(user,1))).status,401);
    const forged=browserToken.split('.').slice(0,2).join('.')+'.'+Buffer.from('forged-signature').toString('base64url');assert.equal((await raw(forged)).status,401);
    const forbidden=await rpc(c,'add_cart',{name:'Denied',qty_num:1,unit:'шт'});assert.equal(forbidden.error.code,'42501');
    const visibleId=await add();const own=await a.from('fridge_items').select('id').eq('id',visibleId);assert.equal(own.data[0].id,visibleId);
    const hidden=await c.from('fridge_items').select('*').eq('household_id',household);assert.deepEqual(hidden.data,[]);
    const privateRead=await fetch(apiOrigin+'/stock_operations',{headers:{Authorization:'Bearer '+browserToken,'Accept-Profile':'sf_private'}});assert.equal(privateRead.status,406);
    check('real JWT signature/expiry + anon + household RLS + private-schema boundary');
    // Hold the same household lock, then confirm TWO separate API DB sessions wait
    // before releasing them. This proves actual overlap, rather than timing two calls.
    async function race(start){
      const lock=await pool.connect();let waiting=[];
      try{
        await lock.query('begin');await lock.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[household]);
        const calls=start().map(p=>Promise.resolve(p));let seen=false;
        for(let n=0;n<100;n++){
          waiting=(await pool.query("select distinct l.pid from pg_locks l join pg_stat_activity s on s.pid=l.pid where l.locktype='advisory' and not l.granted and s.usename='sf_api_test'")).rows;
          if(waiting.length>=2){seen=true;break;}await delay(30);
        }
        await lock.query('commit');const results=await Promise.all(calls);assert.ok(seen,'two simultaneous API backend sessions were not observed');return results;
      }finally{await lock.query('rollback');lock.release();}
    }
    let id=await cart(),op=randomUUID();let results=await race(()=>[rpc(a,'buy',buy(id),op),rpc(a,'buy',buy(id),op)]);
    assert.ok(results.every(r=>!r.error));assert.equal((await pool.query('select count(*)::int n from fridge_items where id=$1',[op])).rows[0].n,1);
    check('simultaneous replay with same UUID commits transfer exactly once');
    const membershipLock=await pool.connect(),revokedId=randomUUID();let revoked;
    try{
      await membershipLock.query('begin');await membershipLock.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[household]);
      revoked=Promise.resolve(rpc(a,'add_cart',{name:'Must not write after membership move',qty_num:1,unit:'шт'},revokedId));
      let queued=false;
      for(let n=0;n<100;n++){
        const count=(await pool.query("select count(*)::int n from pg_locks l join pg_stat_activity s on s.pid=l.pid where l.locktype='advisory' and not l.granted and s.usename='sf_api_test'")).rows[0].n;
        if(count){queued=true;break;}await delay(30);
      }
      assert.ok(queued,'request must pass its initial auth check and wait');
      await pool.query('update household_members set household_id=$1 where user_id=$2',[otherHousehold,user]);
      await membershipLock.query('commit');const denied=await revoked;assert.equal(denied.error?.code,'42501');
      assert.equal((await pool.query('select count(*)::int n from cart_items where id=$1',[revokedId])).rows[0].n,0);
    }finally{
      await membershipLock.query('rollback');membershipLock.release();
      await pool.query('update household_members set household_id=$1 where user_id=$2',[household,user]);
    }
    check('membership revoked while request waits cannot write to the previous household');

    id=await cart();results=await race(()=>[rpc(a,'buy',buy(id)),rpc(b,'buy',buy(id))]);
    assert.equal(results.filter(r=>!r.error).length,1);assert.equal(results.find(r=>r.error).error.code,'40001');
    assert.equal((await pool.query('select count(*)::int n from cart_items where id=$1',[id])).rows[0].n,0);
    assert.equal((await pool.query("select count(*)::int n from sf_private.stock_operations where action='buy' and payload->>'id'=$1",[id])).rows[0].n,1);
    assert.ok(await row(results.find(r=>!r.error).data.operation_id));
    check('two members buying the same cart row produce one stock item');
    id=await add();results=await race(()=>[rpc(a,'used',spend(id)),rpc(b,'used',spend(id))]);
    assert.equal(results.filter(r=>!r.error).length,1);assert.equal(Number((await row(id)).qty_num),300);
    check('simultaneous consumption checks expected remainder and keeps 300 g');
    id=await add();let before=expected(await row(id));
    results=await race(()=>[rpc(a,'edit',{id,expected:before,...before,qty_num:450,name:'Edited concurrently'}),rpc(b,'used',spend(id))]);
    assert.equal(results.filter(r=>!r.error).length,1);assert.ok([300,450].includes(Number((await row(id)).qty_num)));
    check('edit versus consumption cannot overwrite the winning transaction');
    id=await add();op=randomUUID();await must(rpc(a,'used',spend(id),op));
    results=await race(()=>[rpc(a,'undo',{operation_id:op}),rpc(b,'used',spend(id,300,50))]);
    assert.equal(results.filter(r=>!r.error).length,1);assert.ok([250,500].includes(Number((await row(id)).qty_num)));
    const usedEvents=(await pool.query("select count(*)::int n from food_events e join sf_private.stock_operations o on e.id=o.event_id where o.payload->>'id'=$1",[id])).rows[0].n;
    assert.equal(usedEvents,Number((await row(id)).qty_num)===500?0:2);
    check('undo versus later consumption preserves data and journal coherently');
    id=await add();before=expected(await row(id));op=randomUUID();const edit={id,expected:before,...before,qty_num:450,compartment:'freezer',location:'Морозилка'};
    await must(rpc(a,'edit',edit,op));await must(rpc(a,'edit',edit,op));assert.equal(Number((await row(id)).qty_num),450);
    await must(rpc(a,'undo',{operation_id:op}));assert.equal(Number((await row(id)).qty_num),500);assert.equal((await row(id)).compartment,'fridge');
    check('real SDK edit, lost-response replay and undo work through PostgREST');
    // Serve the actual Supabase SDK. Only token issuance /auth/user is a fixture;
    // all reads and mutations go through PostgREST and native PostgreSQL.
    const {chromium}=require('playwright');
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined)});
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce',serviceWorkers:'block'});
    const umd=fs.readFileSync(path.join(root,'node_modules/@supabase/supabase-js/dist/umd/supabase.js'),'utf8');
    await context.route('**/*',route=>{
      const address=route.request().url();if(address.startsWith(origin+'/'))return route.continue();
      return route.fulfill({contentType:'application/javascript',body:address.includes('@supabase/supabase-js')?umd:''});
    });
    await context.addInitScript(({token,uid})=>{
      localStorage.setItem('sf_onboarding_seen_'+uid,'1');
      localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:token,refresh_token:'fixture-refresh-unused',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:uid,email:'fixture@example.test',role:'authenticated',aud:'authenticated'}}));
    },{token:browserToken,uid:user});
    const page=await context.newPage();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.goto(origin);await page.waitForFunction(()=>userDataLoaded&&document.getElementById('login-screen').style.display==='none');
    await page.evaluate(id=>{history=['fridge'];openProduct('fridge',fridgeData.findIndex(p=>p._id===id));},id);
    await page.click('#edit-open-btn');await page.fill('#edit-name','Edited with real SDK');await page.fill('#edit-qty-num','450');transportMode='drop-after';await page.click('#save-edit-btn');
    await page.waitForFunction(()=>/Не удалось/.test(document.getElementById('stock-save-message').textContent));assert.equal(await page.inputValue('#edit-name'),'Edited with real SDK');assert.equal(Number((await row(id)).qty_num),450);
    const editOp=requests.at(-1).op_id;await page.reload();await page.waitForFunction(()=>userDataLoaded);await page.click('#stock-retry-btn');
    await page.waitForFunction(()=>/Сохранено/.test(document.getElementById('stock-save-message').textContent));assert.equal(requests.at(-1).op_id,editOp);assert.equal(Number((await row(id)).qty_num),450);
    await page.click('#stock-undo-btn');await page.waitForFunction(()=>/отменено/.test(document.getElementById('stock-save-message').textContent));assert.equal(Number((await row(id)).qty_num),500);
    assert.deepEqual(pageErrors,[]);check('mobile browser → actual SDK → JWT/PostgREST → PostgreSQL; lost edit response + reload + undo');
    await page.evaluate(id=>{history=['fridge'];openProduct('fridge',fridgeData.findIndex(p=>p._id===id));},id);
    await page.click('#edit-open-btn');await page.fill('#edit-name','Draft after another member used stock');
    await must(rpc(b,'used',spend(id)));
    // A background refresh changes inventory objects, but must not rewrite the
    // immutable baseline captured when this form opened.
    await page.evaluate(()=>loadUserData());await page.click('#save-edit-btn');
    await page.waitForFunction(()=>/Сервер отклонил/.test(document.getElementById('stock-save-message').textContent));
    assert.equal(Number((await row(id)).qty_num),300);assert.equal(await page.inputValue('#edit-qty-num'),'500');
    await page.click('#stock-reset-btn');await page.waitForFunction(()=>/Данные обновлены/.test(document.getElementById('stock-save-message').textContent));
    assert.match(await page.textContent('#edit-stock-current'),/300/);assert.equal(await page.inputValue('#edit-name'),'Draft after another member used stock');
    await page.fill('#edit-qty-num','250');await page.click('#save-edit-btn');
    await page.waitForFunction(()=>/Сохранено/.test(document.getElementById('stock-save-message').textContent));assert.equal(Number((await row(id)).qty_num),250);
    await page.click('#stock-undo-btn');await page.waitForFunction(()=>/отменено/.test(document.getElementById('stock-save-message').textContent));assert.equal(Number((await row(id)).qty_num),300);
    assert.deepEqual(pageErrors,[]);check('stale editor + background refresh keeps draft, rejects overwrite, refresh shows 300 g, corrected edit/undo keep later usage');
    const out=process.env.SF_EVIDENCE_DIR||'/tmp/sf-stock-http-evidence';fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'mobile-real-http-undo.png'),fullPage:true});
    fs.writeFileSync(path.join(out,'http-summary.json'),JSON.stringify({checks,postgres:(await pool.query('select version()')).rows[0].version,postgrest:logs[0],pageErrors},null,2));
    fs.writeFileSync(path.join(out,'postgrest.log'),logs.join(''));
  }finally{
    if(browser)await browser.close();
    if(server)await new Promise(r=>server.close(r));
    if(postgrest&&postgrest.exitCode===null&&postgrest.signalCode===null){postgrest.kill('SIGTERM');await postgrestExit;}
    await pool.end();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
