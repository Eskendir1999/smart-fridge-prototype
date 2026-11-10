(function(root){
'use strict';
const M=root.SFDinner;
const E=(tag,text,attrs={})=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;};
const button=(text,fn,id)=>{const n=E('button',text,{type:'button',...(id?{id}: {})});n.addEventListener('click',fn);return n;};
const field=(parent,title,input)=>{const label=E('label',title);label.append(input);parent.append(label);return input;};
const factor=unit=>({'г':1000,'кг':1000000,'мл':1000,'л':1000000,'шт':1000})[unit];
const dayPlus=(day,n)=>new Date(Date.parse(day+'T00:00Z')+n*86400000).toISOString().slice(0,10);
root.SFDinnerUI={mount({root:host,session,onSnapshot,stockLocked}){
 let catalog=null,snapshot=null,loadedScope='',loading=false,needsRefresh=false,generation=0,error='',selected=[],portions=1,recipeId=null,step=0,actual=null,drafts={},actualDraft={},purchaseDraft={},queue;
 const scope=()=>{const s=session();return s?.ready?{userId:s.userId,householdId:s.householdId}:null;};
 const key=()=>{const s=scope();return s?s.userId+':'+s.householdId:'';};
 const safe=fn=>async()=>{try{await fn();}catch(e){error=e.message||'Не удалось выполнить действие';render();}};
 queue=root.SFDinnerQueue.create({storage:localStorage,scope,blocked:stockLocked,rpc:req=>session().sb.rpc('dinner_mutate',req),
  onSaved:(data,request)=>{generation++;if(loadedScope!==key()){
    selected=(request.body.profiles||[]).map(p=>p.id).filter(id=>data.profiles.some(p=>p.id===id));
    recipeId=request.body.meals?.[0]?.recipe_id||null;portions=request.body.meals?.[0]?.portions||1;loadedScope=key();
   }snapshot=data;actual=null;actualDraft={};error='';onSnapshot(data);},onChange:()=>render()});
 function context(){if(selected.some(id=>sessionStorage.getItem('sf_restrictions_pending_'+scope().userId+'_'+id)==='1'))throw Error('Сначала подтвердите изменения ограничений профиля.');
  return {householdId:scope().householdId,lots:M.adaptInventory({rows:snapshot.fridge_items,householdId:scope().householdId,confirmed:true}),
  profiles:M.adaptProfiles({rows:snapshot.profiles,householdId:scope().householdId,profileIds:selected,userId:scope().userId}),ingredients:catalog.ingredients};}
 function recipe(){return catalog.recipes.find(r=>r.id===recipeId);}
 function meals(count=1){return Array.from({length:count},(_,i)=>({id:'dinner-'+dayPlus(snapshot.today,i),day:dayPlus(snapshot.today,i),portions,recipe:recipe()}));}
 const wireMeals=ms=>ms.map(m=>({id:m.id,day:m.day,portions:m.portions,recipe_id:m.recipe.id,recipe_version:m.recipe.version}));
 function profiles(){return context().profiles.map(p=>({id:p.id,mode:p.mode,exclusions:p.exclusions}));}
 async function load(){const s=scope();if(!s)return render();const target=key();if(loading){needsRefresh=true;return;}
  loading=true;const seq=++generation;render();try{if(!catalog){const response=await fetch('/dinner/catalog.json');if(!response.ok)throw Error('Каталог временно недоступен');catalog=await response.json();}
   const {data,error:err}=await session().sb.rpc('dinner_mutate',{op_id:null,hh_id:s.householdId,kind:'snapshot',body:{}});
   if(target!==key()||seq!==generation)return;if(err||!data?.today||!Array.isArray(data.profiles))throw Error('Не удалось загрузить подтверждённые запасы. Обновите данные.');
   if(loadedScope!==target){const pending=queue.view().request?.body;loadedScope=target;
    selected=pending?.profiles?.map(p=>p.id).filter(id=>data.profiles.some(p=>p.id===id))||(session().profileId&&data.profiles.some(p=>p.id===session().profileId)?[session().profileId]:[]);
    recipeId=pending?.meals?.[0]?.recipe_id||null;portions=pending?.meals?.[0]?.portions||1;actual=null;drafts={};purchaseDraft={};step=0;}
   snapshot=data;selected=selected.filter(id=>data.profiles.some(p=>p.id===id));error='';
  }catch(e){if(target===key())error=e.message;}finally{loading=false;render();if(needsRefresh){needsRefresh=false;Promise.resolve().then(load);}}}
 function resetCooking(){actual=null;actualDraft={};step=0;}
 function render(){host.replaceChildren();host.classList.add('dinner-panel');host.append(E('h2','Ужин из продуктов дома'),E('p','Проверьте состав и этикетки продуктов. Каталог не подтверждает безопасность при аллергии.'));
  if(!scope()){host.append(E('p','Войдите, чтобы проверить свои запасы.'));return;}
  const q=queue.view(),status=E('p',q.busy?'Сохраняем…':loading?'Проверяем данные…':error||q.message||(q.request?'Результат сохранения пока неизвестен. Повторите ту же операцию.':''),{id:'dinner-status',role:'status','aria-live':'polite'});host.append(status);
  if(q.corrupt)host.append(E('p','Не удалось прочитать сохранённую операцию на устройстве. Сверьте остатки перед дальнейшими изменениями.'));
  if(q.request){if(q.redacted)host.append(E('p','Личный ввод очищен. Проверьте результат предыдущего действия перед новым вводом.'));
   const retry=button(q.request.kind==='resolve'?'Проверить результат':'Повторить сохранение',safe(()=>queue.retry()),'dinner-retry');retry.disabled=q.busy||stockLocked();host.append(retry);
   if(q.rejected)host.append(button('Обновить данные и исправить',safe(async()=>{if(queue.discardRejected()){resetCooking();await load();}}),'dinner-reset'));}
  if(q.lastConsumeId&&!q.request){host.append(button('Отменить расход',safe(()=>queue.start('undo',{operation_id:q.lastConsumeId})),'dinner-undo'));}
  host.append(button('Обновить запасы',safe(load),'dinner-refresh'));
  if(error&&q.message)host.append(E('p',error));
  if(!snapshot||loadedScope!==key()||!catalog){host.append(E('p','Загружаем подтверждённые данные…'));return;}
  const controls=E('fieldset');controls.disabled=loading||queue.pending()||stockLocked();host.append(controls);
  controls.append(E('legend','Мои профили для блюда'));
  if(!snapshot.profile_access_ready)controls.append(E('p','Доступ к личным профилям пока проходит проверку. Запасы и обычный список покупок доступны отдельно.'));
  else if(!snapshot.profiles.length){controls.append(E('p','Для ужина нужен ваш собственный профиль.'));controls.append(button('Создать мой профиль',()=>document.getElementById('my-data-open')?.click(),'dinner-create-profile'));}
  snapshot.profiles.forEach(p=>{const input=E('input',null,{type:'checkbox','data-dinner-profile':p.id});input.checked=selected.includes(p.id);
   input.onchange=()=>{selected=input.checked?[...selected,p.id]:selected.filter(id=>id!==p.id);resetCooking();render();};
   const names={dairy:'молочное',egg:'яйца',fish:'рыба',nuts:'орехи',gluten:'глютен'};
   field(controls,p.name+' · '+(p.diet_mode==='breastfeeding'?'Кормящая мама':'Обычный режим')+' · исключено: '+(p.excluded_foods?.map(x=>names[x]||x).join(', ')||'нет'),input);
  });
  const portion=E('input',null,{type:'number',min:'1',max:'100',step:'1',id:'dinner-portions'});portion.value=portions;
  portion.onchange=()=>{const n=Number(portion.value);if(Number.isInteger(n)&&n>0&&n<=100){portions=n;resetCooking();render();}else{error='Укажите от 1 до 100 целых порций.';render();}};field(controls,'Порции',portion);
  renderLots(controls);
  if(!selected.length){controls.append(E('p','Выберите доступный личный профиль. Ограничения учитываются при каждом расчёте.'));renderCart(controls);return;}
  let ctx,cards;try{ctx=context();cards=M.suggest({...ctx,recipes:catalog.recipes,day:snapshot.today,portions});}catch{controls.append(E('p','Уточните настройки выбранных профилей.'));renderCart(controls);return;}
  if(!cards.length){controls.append(E('p','В этом каталоге нет блюд для выбранных ограничений. Измените состав участников или выберите отдельные блюда.'));renderCart(controls);return;}
  controls.append(E('h3','Подходящие варианты'));
  for(const card of cards){const r=catalog.recipes.find(r=>r.id===card.recipeId),article=E('article',null,{'data-dinner-card':r.id});article.append(E('h4',r.title),E('strong',card.result.label));explain(article,card.result);article.append(button('Выбрать',()=>{recipeId=r.id;resetCooking();render();},'choose-'+r.id));controls.append(article);}
  const allowed=catalog.recipes.filter(r=>!M.evaluateMenu({...ctx,meals:[{id:r.id,recipe:r,day:snapshot.today,portions}]}).blocked.length);
  const selector=E('select',null,{id:'dinner-recipe'});selector.append(E('option','Выберите блюдо',{value:''}));allowed.forEach(r=>selector.append(E('option',r.title,{value:r.id})));selector.value=allowed.some(r=>r.id===recipeId)?recipeId:'';
  selector.onchange=()=>{recipeId=selector.value||null;resetCooking();render();};field(controls,'Блюдо и явная замена',selector);
  if(!allowed.some(r=>r.id===recipeId)){recipeId=null;renderCart(controls);return;}
  const result=M.evaluateMenu({...ctx,meals:meals()});controls.append(E('h3',recipe().title),E('p',portions+' порц. · '+snapshot.today));explain(controls,result);
  for(const [count,label]of [[1,'В покупки на этот ужин'],[7,'Повторить блюдо на 7 дней: в покупки']]){
   const action=button(label,safe(async()=>{await load();const coverage=M.evaluateMenu({...context(),meals:meals(count)});if(coverage.status==='clarify'||coverage.blocked.length)throw Error('Сначала уточните количество и сроки партий.');
    const desired=Object.fromEntries(M.shopping(coverage).map(l=>[l.ingredientId,l.amount])),scope_id='dinner:'+snapshot.today;await queue.start('shopping',{profiles:profiles(),meals:wireMeals(meals(count)),desired,scope_id,expected_scope_revision:snapshot.demand_versions?.[scope_id]||0});}),count===1?'dinner-shopping':'dinner-week-shopping');
   controls.append(action);
  }
  controls.append(E('p','Покупки пересчитываются для выбранного блюда. План и шаги не списывают продукты.'));
  const steps=E('ol');recipe().steps.forEach((text,i)=>{const li=E('li',(i<step?'✓ ':i===step?'→ ':'')+text);steps.append(li);});controls.append(steps);
  if(step<recipe().steps.length)controls.append(button('Следующий шаг',()=>{step++;render();},'dinner-next-step'));
  else{const done=button('Приготовил: проверить расход',safe(async()=>{await load();const fresh=M.evaluateMenu({...context(),meals:meals()});if(fresh.status!=='enough')throw Error('Запасы изменились или требуют уточнения. Сначала проверьте состав.');
    actual=fresh.lines.flatMap(l=>l.allocations);actualDraft={};render();}),'dinner-cooked');controls.append(done);}
  if(actual){const form=E('form',null,{id:'dinner-actual'});form.append(E('h3','Подтвердите фактический расход'));
   actual.forEach(a=>{const l=snapshot.fridge_items.find(l=>l.id===a.lotId),input=E('input',null,{type:'number',min:'0',max:String(a.amount/factor(l.unit)),step:l.unit==='шт'?'1':'0.001','data-actual-lot':l.id});input.value=actualDraft[l.id]??String(a.amount/factor(l.unit));input.oninput=()=>actualDraft[l.id]=input.value;field(form,l.name+' · '+l.unit,input);});
   form.append(E('p','Списывается только указанное количество. Ноль означает, что партия не использована.'));
   const confirm=E('button','Подтвердить расход',{type:'submit',id:'dinner-confirm'});form.append(confirm,button('Отменить до сохранения',()=>{resetCooking();render();},'dinner-cancel'));
   form.onsubmit=async event=>{event.preventDefault();await safe(async()=>{const deltas=actual.map(a=>({id:a.lotId,expected_version:a.expectedVersion,amount:form.querySelector('[data-actual-lot="'+a.lotId+'"]').value})).filter(d=>Number(d.amount)!==0);
    deltas.forEach(d=>actualDraft[d.id]=d.amount);if(!deltas.length)throw Error('Укажите хотя бы одно положительное количество.');await queue.start('consume',{profiles:profiles(),meals:wireMeals(meals()),deltas});})();};controls.append(form);
  }
  renderCart(controls);
 }
 function explain(parent,result){const ul=E('ul');for(const l of result.lines){const name=catalog.ingredients[l.ingredientId]?.name||'Продукт';let text=name+': '+l.label;
   if(l.required!==null)text+='; нужно '+M.formatAmount(l.required,l.dimension)+', подтверждено '+M.formatAmount(l.knownAllocated,l.dimension);
   if(l.missingExact>0)text+=', не хватает '+M.formatAmount(l.missingExact,l.dimension);
   if(l.status==='clarify')text+=' — подтвердите количество, меру, состав и срок партии';ul.append(E('li',text));}parent.append(ul);}
 function renderLots(parent){const details=E('details',null,{id:'dinner-lots'});details.append(E('summary','Проверить количество, состав и сроки запасов'));
  snapshot.fridge_items.forEach(l=>{const form=E('form',null,{'data-lot-form':l.id});form.append(E('h4',l.name));const draft=drafts[l.id]||{};
   const select=E('select',null,{'data-lot-ingredient':l.id});select.append(E('option','Уточните обычный продукт без добавок',{value:''}));Object.entries(catalog.ingredients).forEach(([id,v])=>select.append(E('option',v.name,{value:id})));select.value=draft.ingredient_id??l.ingredient_id??'';field(form,'Продукт',select);
   const number=E('input',null,{type:'number',min:'0',step:'0.001','data-lot-quantity':l.id});number.value=draft.qty_num??l.qty_num;field(form,'Проверьте фактическое количество',number);
   const unit=E('select');['г','кг','мл','л','шт'].forEach(u=>unit.append(E('option',u,{value:u})));unit.value=draft.unit??l.unit;field(form,'Единица',unit);
   const expiry=E('input',null,{type:'date','data-lot-expiry':l.id});expiry.value=draft.expires_on??l.expires_on??'';field(form,l.expiry_estimated?'Срок примерный: сверьте с упаковкой':'Срок с упаковки или известная дата',expiry);
   const preserve=()=>drafts[l.id]={ingredient_id:select.value,qty_num:number.value,unit:unit.value,expires_on:expiry.value};[select,number,unit,expiry].forEach(n=>n.addEventListener('input',preserve));
   if(l.dinner_excluded)form.append(E('p','Эта партия не учитывается в рецептах. Запас и срок не изменены.'));
   form.append(button(l.dinner_excluded?'Вернуть в расчёт':'Не учитывать в рецептах',safe(()=>queue.start('exclude_lot',{id:l.id,expected_version:l.dinner_version,excluded:!l.dinner_excluded})), 'dinner-exclude-'+l.id));
   form.append(E('button','Подтвердить партию',{type:'submit','data-confirm-lot':l.id}));form.onsubmit=async ev=>{ev.preventDefault();preserve();await safe(async()=>{const ok=await queue.start('confirm_lot',{id:l.id,expected_version:l.dinner_version,...drafts[l.id]});if(ok){delete drafts[l.id];render();}})();};details.append(form);
  });parent.append(details);}
 function renderCart(parent){
  if(snapshot.events?.length){const history=E('details',null,{id:'dinner-history'});history.append(E('summary','История расхода и отмен'));
   snapshot.events.forEach(e=>{const entry=E('p',e.kind==='consume'?'Расход: ':'Отмена расхода: ');entry.append(document.createTextNode(e.quantities.map(q=>(catalog.ingredients[q.ingredient_id]?.name||'Продукт')+' '+q.amount+' '+q.unit).join(', ')));history.append(entry);});parent.append(history);}
  const carts=snapshot.cart_items.filter(c=>c.dinner_scope);if(!carts.length)return;const box=E('section',null,{id:'dinner-purchases'});box.append(E('h3','Покупки для ужина'));
  carts.forEach(c=>{const row=E('div');row.append(E('p',c.name+' · '+c.qty_num+' '+c.unit));const expiry=E('input',null,{type:'date','aria-label':'Срок покупки '+c.name});expiry.value=purchaseDraft[c.id]||'';expiry.oninput=()=>purchaseDraft[c.id]=expiry.value;field(row,'Срок с упаковки (можно уточнить позже)',expiry);
   row.append(button('Куплено',safe(()=>queue.start('buy',{id:c.id,expected:c,expires_on:expiry.value})), 'dinner-buy-'+c.id));box.append(row);});parent.append(box);}
 window.addEventListener('sf:inventory',()=>{if(loading)needsRefresh=true;else if(!queue.pending()||!snapshot||loadedScope!==key()||!catalog)load();else render();});
 function clear(){queue.redact();generation++;snapshot=null;loadedScope='';selected=[];recipeId=null;step=0;actual=null;drafts={};actualDraft={};purchaseDraft={};error='';render();}
 // My Data must emit this before sending a deletion, including an uncertain one.
 // Resolve any pending receipt by opaque ID; never keep its deleted profile input.
 window.addEventListener('sf:personal-data-deleting',clear);
 load();return {pending:()=>queue.pending(),refresh:load,clear};
}};
})(globalThis);
