const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const {randomUUID}=require('node:crypto');
const html=fs.readFileSync(require('node:path').join(__dirname,'../../index.html'),'utf8');
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

module.exports={fixture,fn};
