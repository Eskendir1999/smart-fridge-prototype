(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SFDinnerQueue=factory();})(globalThis,function(){
'use strict';
const rejectedCodes=new Set(['40001','42501','22023','P0001','23514','22003','22007','22008','22P02','PGRST202','42703']);
function create({storage,scope,rpc,onSaved=()=>{},onChange=()=>{},blocked=()=>false,uuid=()=>crypto.randomUUID()}){
 let key='',state={},busy=false,epoch=0;
 const notify=()=>{try{onChange();}catch{}};
 const current=()=>{const s=scope();return s?.userId&&s?.householdId?'sf_dinner_v1_'+s.userId+'_'+s.householdId:'';};
 function load(){const next=current();if(next===key)return;epoch++;key=next;state={};busy=false;if(key){try{const raw=storage.getItem(key),saved=JSON.parse(raw||'{}');
   if(!raw){const opaque=JSON.parse(storage.getItem(key+'_pending_id')||'null');if(opaque)saved.request={...opaque,kind:'resolve',body:{}},saved.redacted=true;}
   if(saved.request&&saved.request.hh_id!==scope().householdId)throw Error('Wrong household');state=saved;}catch{state={corrupt:true};}}}
 function view(){load();return {...structuredClone(state),busy};}
 function store(next){if(!key)throw Error('Войдите в аккаунт');storage.setItem(key,JSON.stringify(next));state=next;}
 async function execute(){load();if(busy||!state.request||blocked())return false;const request=structuredClone(state.request),attemptKey=key,attemptEpoch=epoch;
  // Persist the same intent and clear a previous rejection before every attempt.
  storage.setItem(key+'_pending_id',JSON.stringify({op_id:request.op_id,hh_id:request.hh_id}));
  store({...state,rejected:false});busy=true;notify();
  try{const {data,error}=await rpc(request);if(current()!==attemptKey||epoch!==attemptEpoch)return false;
   if(error){if(rejectedCodes.has(error.code))store({...state,rejected:true});throw error;}
   if(data?.operation_id!==request.op_id||data.kind!==request.kind||!Array.isArray(data.fridge_items)||!Array.isArray(data.cart_items)||!Array.isArray(data.profiles))throw Error('No confirmation');
   if(request.kind==='resolve'&&(!['saved','cancelled'].includes(data.operation_state)||!['consume','shopping','buy','confirm_lot','exclude_lot','undo','cancelled'].includes(data.resolved_kind)))throw Error('No resolution');
   const effectiveKind=request.kind==='resolve'?data.resolved_kind:request.kind;
   const lastConsumeId=effectiveKind==='consume'?(data.undone?null:request.op_id):effectiveKind==='undo'?null:state.lastConsumeId;
   // A storage/render failure after a confirmed commit never generates another UUID.
   state={lastConsumeId,message:data.operation_state==='cancelled'?'Предыдущее действие не сохранено и отменено. Проверьте данные перед новым вводом.':effectiveKind==='undo'?'Расход отменён.':'Сохранено.'};
   try{storage.setItem(key,JSON.stringify(state));storage.removeItem?.(key+'_pending_id');}catch{}
   try{onSaved(data,request);}catch{state.message='Сохранено. Обновите страницу, чтобы увидеть остатки.';}
   return true;
  }catch(error){if(current()===attemptKey&&epoch===attemptEpoch)state.message=error?.code==='55000'?'Сохранение временно приостановлено. Запрос сохранён; повторите позже.':state.rejected?'Сервер отклонил действие. Обновите данные и проверьте ввод.':'Результат не подтверждён. Повторите ту же операцию.';return false;}
  finally{if(current()===attemptKey&&epoch===attemptEpoch){busy=false;notify();}}
 }
 async function start(kind,body){load();if(busy||state.request||state.corrupt||blocked())return false;
  const request={op_id:uuid(),hh_id:scope()?.householdId,kind,body:structuredClone(body)};
  storage.setItem(key+'_pending_id',JSON.stringify({op_id:request.op_id,hh_id:request.hh_id}));
  store({...state,request,rejected:false,message:'Сохраняем…'});return execute();
 }
 function discardRejected(){load();if(busy||!state.rejected)return false;store({lastConsumeId:state.lastConsumeId});try{storage.removeItem?.(key+'_pending_id');}catch{}notify();return true;}
 function redact(){
  // Logout can precede snapshot loading. Scrub this feature's private inputs on
  // the shared browser even when its account/household key has not been loaded.
  const keys=new Set(key?[key]:[]);
  if(typeof storage.key==='function')for(let i=0;i<storage.length;i++){const k=storage.key(i);if(k?.startsWith('sf_dinner_v1_')&&!k.endsWith('_pending_id'))keys.add(k);}
  for(const target of keys){let saved;
   try{saved=target===key&&state.request?state:JSON.parse(storage.getItem(target)||'{}');}catch{continue;}
   if(!saved.request)continue;
   const request={op_id:saved.request.op_id,hh_id:saved.request.hh_id,kind:'resolve',body:{}};
   try{storage.setItem(target+'_pending_id',JSON.stringify({op_id:request.op_id,hh_id:request.hh_id}));storage.setItem(target,JSON.stringify({request,lastConsumeId:saved.lastConsumeId,redacted:true}));}
   catch{try{const backup=JSON.parse(storage.getItem(target+'_pending_id')||'null');if(backup?.op_id===request.op_id)storage.removeItem(target);}catch{}}
  }
  epoch++;key='';state={};busy=false;
 }
 return {view,start,retry:execute,discardRejected,redact,pending:()=>{load();return !!state.request||busy||!!state.corrupt;}};
}
return Object.freeze({create});
});
