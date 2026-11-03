// Regression scenarios from PR #3, adapted to the transactional stock API.
// The old partial DELETE/journal success and split transfer expectations are
// superseded by stock-transactions.test.cjs and native stock-http.cjs.
const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const {fixture,fn}=require('./helpers/stock-ui.cjs');
function load(f,names){vm.runInContext(names.map(fn).join('\n'),f.c);}
test('batch retry repeats only failed row, leaving confirmed rows unchecked',async()=>{
  let n=0;const f=fixture({reply:request=>++n===2?{error:{message:'offline'}}:{data:{operation_id:request.op_id,fridge_items:[],cart_items:[]}}});
  const boxes=[0,1,2].map(i=>({checked:true,dataset:{manualIdx:String(i)}}));
  Object.assign(f.c,{productCatalog:boxes.map((_,i)=>({name:'item-'+i,emoji:'📦',defaultQty:1,unit:'шт',shelfDays:5})),Date,
    isoDate:()=> '2026-11-08',addDays:d=>d,closeSheet(){}});
  f.c.document.querySelectorAll=()=>boxes.filter(cb=>cb.checked);
  f.node('manual-dest-freezer').classList={contains:()=>false};
  load(f,['toDbRow','catalogStockItem','saveStockItem','addManualProducts']);
  await f.run('addManualProducts()');assert.deepEqual(boxes.map(b=>b.checked),[false,true,true]);
  await f.run('executeStockRequest()');assert.deepEqual(boxes.map(b=>b.checked),[false,false,true]);
  await f.run('addManualProducts()');assert.deepEqual(boxes.map(b=>b.checked),[false,false,false]);
  const requests=f.calls.filter(c=>c[0]==='rpc').map(c=>c[1]);
  assert.deepEqual(requests.map(r=>r.body.name),['item-0','item-1','item-1','item-2']);assert.equal(requests[1].op_id,requests[2].op_id);
});
test('replaying an older custom add does not clear a newly typed product name',async()=>{
  let n=0,closed=0;const f=fixture({reply:r=>++n===1?{error:{message:'offline'}}:{data:{operation_id:r.op_id,fridge_items:[],cart_items:[]}}});
  f.node('manual-custom-name').value='old name';f.node('manual-dest-freezer').classList={contains:()=>false};
  Object.assign(f.c,{findCatalog:()=>null,closeSheet:()=>closed++});load(f,['toDbRow','saveStockItem','addCustomProduct']);
  await f.run('addCustomProduct()');f.node('manual-custom-name').value='new draft';await f.run('executeStockRequest()');
  assert.equal(f.node('manual-custom-name').value,'new draft');assert.equal(closed,0);assert.match(f.node('stock-save-message').textContent,/Новый ввод/);
});
test('widget waits for confirmation and leaves failed and unattempted marks pending',async()=>{
  const cleared=[],calls=[];let failed=true;
  const c=vm.createContext({cartData:[{_id:'one',name:'one'},{_id:'two',name:'two'}],showToast(){},
    WB:{getPending:async()=>({ids:['one','two']}),clearPending:async({ids})=>cleared.push(...ids)},
    buyCartItem:async item=>{calls.push(item._id);return !failed;}});
  vm.runInContext(fn('applyWidgetPurchases'),c);await vm.runInContext('applyWidgetPurchases(WB)',c);assert.deepEqual(cleared,[]);
  failed=false;await vm.runInContext('applyWidgetPurchases(WB)',c);assert.deepEqual(cleared,['one','two']);assert.deepEqual(calls,['one','one','two']);
});
test('widget snapshot repaint cannot schedule its own retry loop',()=>{
  const scheduled=[];const c=vm.createContext({nativeSyncRunning:true,currentProduct:null,fridgeData:[],freezerData:[],cartData:[],history:[],
    renderCart:sync=>{if(sync)scheduled.push('another native sync');},updateSummary(){},renderFridgeList(){},renderSuggestRow(){},renderMissingAlert(){},currentCompartment:'fridge'});
  vm.runInContext(fn('applyStockSnapshot'),c);vm.runInContext('applyStockSnapshot({fridge_items:[],cart_items:[],stats:null})',c);assert.deepEqual(scheduled,[]);
  c.nativeSyncRunning=false;vm.runInContext('applyStockSnapshot({fridge_items:[],cart_items:[],stats:null})',c);assert.equal(scheduled.length,1);
});
test('native synchronization cannot overlap and unlocks after failure',async()=>{
  let release,attempts=0;const c=vm.createContext({nativePlugin:()=>({}),currentUserId:'user',userDataLoaded:true,nativeSyncRunning:false,console:{warn(){}},
    applyWidgetPurchases:async()=>{attempts++;await new Promise(r=>release=r);throw Error('offline');}});
  vm.runInContext(fn('syncNativeExtras'),c);const pending=vm.runInContext('syncNativeExtras()',c);await vm.runInContext('syncNativeExtras()',c);
  assert.equal(attempts,1);release();await pending;assert.equal(c.nativeSyncRunning,false);
});
