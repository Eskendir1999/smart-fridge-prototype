const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {randomUUID}=require('node:crypto');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
function fn(name){const start=html.search(new RegExp('(?:async )?function '+name+'\\('));const tail=html.slice(start);return tail.slice(0,tail.indexOf('\n}')+2);}
function fixture({reply,storage=new Map()}={}){
  const nodes=new Map(),messages=[],calls=[];
  const node=id=>{if(!nodes.has(id))nodes.set(id,{style:{},textContent:'',hidden:false,disabled:false,closest:()=>null});return nodes.get(id);};
  const c=vm.createContext({currentUserId:'fixture-user',currentHouseholdId:'fixture-household',crypto:{randomUUID},
    document:{getElementById:node},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    showToast:(...args)=>messages.push(args),applyStockSnapshot:data=>calls.push(['apply',data]),
    sb:{rpc:async(name,request)=>{calls.push(['rpc',JSON.parse(JSON.stringify(request))]);return reply?reply(request):{data:{operation_id:request.op_id,fridge_items:[],cart_items:[]},error:null};}}});
  vm.runInContext("let stockRequest=null,stockBusy=false,stockSavedId=null,stockOnSaved=null,stockScope='',stockRejected=false;"+
    ['stockStorageKey','stockPanel','recoverStockOperation','executeStockRequest','runStockOperation'].map(fn).join('\n'),c);
  return {c,nodes,node,calls,messages,storage,run:body=>vm.runInContext(body,c)};
}
test('pending keeps data unchanged, duplicate click makes no second RPC, success follows confirmation',async()=>{
  let finish;const f=fixture({reply:()=>new Promise(r=>finish=r)});let saved=0;f.c.onSaved=()=>saved++;
  const pending=f.run("runStockOperation('add_item',{name:'A'},onSaved)");
  await new Promise(setImmediate);assert.equal(f.node('stock-save-message').textContent,'Сохраняем…');assert.equal(saved,0);
  assert.equal(await f.run("runStockOperation('add_item',{name:'A'})"),false);assert.equal(f.calls.length,1);
  finish({data:{operation_id:f.calls[0][1].op_id,fridge_items:[],cart_items:[]}});assert.equal(await pending,true);assert.equal(saved,1);
  assert.match(f.node('stock-save-message').textContent,/Сохранено/);
});
test('network failure preserves exact request across reload; retry reuses ID and original payload',async()=>{
  const f=fixture({reply:()=>{throw new Error('offline')}});let cleared=0;f.c.clear=()=>cleared++;
  assert.equal(await f.run("runStockOperation('add_item',{name:'Original',qty_num:500},clear)"),false);
  assert.equal(cleared,0);assert.equal(f.node('stock-retry-btn').hidden,false);assert.ok(!/Сохранено/.test(f.node('stock-save-message').textContent));
  const g=fixture({storage:f.storage});g.run('recoverStockOperation()');assert.equal(await g.run('executeStockRequest()'),true);
  assert.deepEqual(g.calls[0][1],f.calls[0][1]);assert.equal(g.calls[0][1].body.name,'Original');
});
test('unknown/no-row response is not a confirmed save',async()=>{
  for(const reply of [{data:null,error:null},{data:{},error:null},{data:null,error:{message:'failure'}}]){
    const f=fixture({reply:()=>reply});assert.equal(await f.run("runStockOperation('used',{})"),false);assert.equal(f.calls.length,1);assert.ok(!/Сохранено/.test(f.node('stock-save-message').textContent));
  }
});
test('failed local persistence makes no request to the server',async()=>{
  const f=fixture();f.c.localStorage.setItem=()=>{throw Error('quota');};assert.equal(await f.run("runStockOperation('used',{})"),false);assert.equal(f.calls.length,0);
});
test('late response from another account never changes current data',async()=>{
  let finish;const f=fixture({reply:()=>new Promise(r=>finish=r)});const pending=f.run("runStockOperation('used',{})");
  await new Promise(setImmediate);f.c.currentUserId='another-user';finish({data:{operation_id:'op',fridge_items:[],cart_items:[]}});
  assert.equal(await pending,false);assert.equal(f.calls.filter(x=>x[0]==='apply').length,0);
});
test('definitive database rejection exposes reset; ambiguous network error does not',async()=>{
  const f=fixture({reply:()=>({error:{code:'40001',message:'stale'}})});await f.run("runStockOperation('used',{})");assert.equal(f.node('stock-reset-btn').hidden,false);
  const g=fixture({reply:()=>{throw Error('offline')}});await g.run("runStockOperation('used',{})");assert.equal(g.node('stock-reset-btn').hidden,true);
});
test('retry clears prior definitive rejection before a potentially lost response, including persisted state',async()=>{
  let attempts=0;const f=fixture({reply:()=>{if(++attempts===1)return {error:{code:'40001',message:'stale'}};throw Error('response lost');}});
  await f.run("runStockOperation('used',{})");assert.equal(f.node('stock-reset-btn').hidden,false);
  await f.run('executeStockRequest()');assert.equal(f.node('stock-reset-btn').hidden,true);
  const g=fixture({storage:f.storage});g.run('recoverStockOperation()');assert.equal(g.node('stock-reset-btn').hidden,true);assert.equal(g.node('stock-retry-btn').hidden,false);
});
test('late rejection from old account cannot make a new ambiguous request discardable',async()=>{
  const replies=[];const f=fixture({reply:()=>new Promise(r=>replies.push(r))});
  const first=f.run("runStockOperation('used',{name:'old'})");await new Promise(setImmediate);
  f.c.currentUserId='new-account';const second=f.run("runStockOperation('used',{name:'new'})");await new Promise(setImmediate);
  replies[0]({error:{code:'40001',message:'old stale request'}});assert.equal(await first,false);
  assert.equal(f.run('stockRejected'),false);assert.equal(f.run('stockBusy'),true);
  replies[1]({error:{message:'ambiguous failure'}});assert.equal(await second,false);assert.equal(f.node('stock-reset-btn').hidden,true);
});
