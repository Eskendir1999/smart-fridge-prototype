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
  f.node('manual-custom-name').value='old name';f.node('manual-custom-qty').value='3';f.node('manual-custom-unit').value='шт';f.node('manual-custom-expiry').value='';f.node('manual-dest-freezer').classList={contains:()=>false};
  Object.assign(f.c,{findCatalog:()=>null,closeSheet:()=>closed++});load(f,['toDbRow','saveStockItem','addCustomProduct']);
  await f.run('addCustomProduct()');f.node('manual-custom-name').value='new draft';await f.run('executeStockRequest()');
  assert.equal(f.node('manual-custom-name').value,'new draft');assert.equal(f.node('manual-custom-qty').value,'3');assert.equal(closed,0);assert.match(f.node('stock-save-message').textContent,/Новый ввод/);
});
