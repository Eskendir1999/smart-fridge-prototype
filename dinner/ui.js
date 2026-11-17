(function(root){
'use strict';
const M=root.SFDinner;
const E=(tag,text,attrs={})=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;};
const button=(text,fn,id)=>{const n=E('button',text,{type:'button',...(id?{id}: {})});n.addEventListener('click',fn);return n;};
const field=(parent,title,input)=>{const label=E('label',title);label.append(input);parent.append(label);return input;};
const factor=unit=>({'г':1000,'кг':1000000,'мл':1000,'л':1000000,'шт':1000})[unit];
const dayPlus=(day,n)=>new Date(Date.parse(day+'T00:00Z')+n*86400000).toISOString().slice(0,10);
const ALIASES=[['cottage-cheese',['творог']],['butter',['масло слив','сливочн']],['neutral-oil',['подсолнеч','растительн','масло раст']],['oil',['оливков']],
 ['short-grain-rice',['рис круг','круглозёрн','круглозерн']],['long-grain-rice',['рис длин','длиннозёрн','длиннозерн','басмати','рис']],['bell-pepper',['перец болг','болгарск']],
 ['egg',['яйц','яйко']],['cheese',['сыр']],['milk',['молок']],['herbs',['зелен','укроп','петруш','кинз']],['tomato',['помид','томат']],['cucumber',['огур']],
 ['salmon',['лосос','сёмг','семг']],['nori',['нори']],['salt',['соль']],['sugar',['сахар']],['potato',['картоф','картош']],['beef',['говяд','мясо']],
 ['carrot',['морков']],['onion',['лук']],['flour',['мука']],['noodles',['лапш','лагман']],['buckwheat',['греч']]];
// A name-based guess only pre-fills the form; a person still confirms it.
const suggestIngredient=(name,ingredients)=>{const n=String(name||'').toLowerCase().replace(/ё/g,'е');for(const [id,keys]of ALIASES){if(ingredients[id]&&keys.some(k=>n.includes(k.replace(/ё/g,'е'))))return id;}return null;};
root.SFDinnerUI={mount({root:host,session,onSnapshot,stockLocked}){
 let catalog=null,snapshot=null,loadedScope='',loading=false,needsRefresh=false,generation=0,error='',selected=[],selection=M.mealSelection(),selectionNotice='',recipeId=null,step=0,actual=null,drafts={},actualDraft={},purchaseDraft={},queue;
 const scope=()=>{const s=session();return s?.ready?{userId:s.userId,householdId:s.householdId}:null;};
 const key=()=>{const s=scope();return s?s.userId+':'+s.householdId:'';};
 const safe=fn=>async()=>{try{await fn();}catch(e){error=e.message||'Не удалось выполнить действие';render();}};
 queue=root.SFDinnerQueue.create({storage:localStorage,scope,blocked:stockLocked,rpc:req=>session().sb.rpc('dinner_mutate',req),
  onSaved:(data,request)=>{generation++;if(loadedScope!==key()){
    selected=(request.body.profiles||[]).map(p=>p.id).filter(id=>data.profiles.some(p=>p.id===id));
    restoreChoice(request.body);loadedScope=key();
   }snapshot=data;actual=null;actualDraft={};error='';onSnapshot(data);},onChange:()=>render()});
 function context(){if(selected.some(id=>sessionStorage.getItem('sf_restrictions_pending_'+scope().userId+'_'+id)==='1'))throw Error('Сначала подтвердите изменения ограничений профиля.');
  return {householdId:scope().householdId,lots:M.adaptInventory({rows:snapshot.fridge_items,householdId:scope().householdId,confirmed:true}),
  profiles:M.adaptProfiles({rows:snapshot.profiles,householdId:scope().householdId,profileIds:selected,userId:scope().userId}),ingredients:catalog.ingredients};}
 function recipe(){return catalog.recipes.find(r=>r.id===recipeId);}
 function meals(count=1){return Array.from({length:count},(_,i)=>{const day=dayPlus(snapshot.today,i);return {id:selection.meal+'-'+day,day,portions:selection.portions,recipe:recipe()};});}
 const wireMeals=ms=>ms.map(m=>({id:m.id,day:m.day,portions:m.portions,recipe_id:m.recipe.id,recipe_version:m.recipe.version}));
 function profiles(){return context().profiles.map(p=>({id:p.id,mode:p.mode,exclusions:p.exclusions}));}
 function restoreChoice(body){const saved=body?.meals?.[0];if(!saved)return;
  const meal=/^(breakfast|lunch|dinner)-/.exec(saved.id)?.[1]||'dinner';
  selection=M.mealSelection({meal,portions:saved.portions});recipeId=saved.recipe_id||null;}
 async function load(){const s=scope();if(!s)return render();const target=key();if(loading){needsRefresh=true;return;}
  loading=true;const seq=++generation;render();try{if(!catalog){const response=await fetch('/dinner/catalog.json');if(!response.ok)throw Error('Каталог временно недоступен');catalog=await response.json();}
   const {data,error:err}=await session().sb.rpc('dinner_mutate',{op_id:null,hh_id:s.householdId,kind:'snapshot',body:{}});
   if(target!==key()||seq!==generation)return;if(err||!data?.today||!Array.isArray(data.profiles))throw Error('Не удалось загрузить подтверждённые запасы. Обновите данные.');
   if(loadedScope!==target){const pending=queue.view().request?.body;loadedScope=target;
    selected=pending?.profiles?.map(p=>p.id).filter(id=>data.profiles.some(p=>p.id===id))||(session().profileId&&data.profiles.some(p=>p.id===session().profileId)?[session().profileId]:data.profiles.length===1?[data.profiles[0].id]:[]);
    recipeId=null;restoreChoice(pending);actual=null;drafts={};purchaseDraft={};step=0;}
   snapshot=data;selected=selected.filter(id=>data.profiles.some(p=>p.id===id));error='';
  }catch(e){if(target===key())error=e.message;}finally{loading=false;render();if(needsRefresh){needsRefresh=false;Promise.resolve().then(load);}}}
 function resetCooking(){actual=null;actualDraft={};step=0;}
 function changeSelection(patch){selection=M.mealSelection({...selection,...patch});selectionNotice='';error='';recipeId=null;resetCooking();render();}
 function openSelection(search){
  if(queue.pending())return;
  try{changeSelection(M.mealSelectionFromQuery(search));}
  catch{selection=M.mealSelection();recipeId=null;resetCooking();selectionNotice='Параметры ссылки не распознаны. Выберите приём пищи, кухню и порции.';render();}
 }
 const badge=status=>({enough:['Всё есть дома','ok'],buy:['Нужно докупить','buy'],clarify:['Уточните запасы','check']})[status]||['Проверьте','check'];
 function card(parent,c,hero){const article=E('article',null,{'data-dinner-card':c.recipeId,class:'dn-card'+(hero?' dn-hero':'')});const [text,tone]=badge(c.status);
  if(hero)article.append(E('p','Лучший вариант сейчас',{class:'dn-eyebrow'}));
  article.append(E('h4',c.title),E('strong',text,{class:'dn-badge dn-'+tone}));explain(article,c);
  article.append(button(hero?'Готовлю это':'Выбрать',()=>{recipeId=c.recipeId;resetCooking();render();host.querySelector('#dinner-plan')?.scrollIntoView({block:'start',behavior:'smooth'});},'choose-'+c.recipeId));parent.append(article);}
 let lastAnnounced='';
 function announce(detail){const sig=JSON.stringify(detail);if(sig===lastAnnounced)return;lastAnnounced=sig;root.dispatchEvent(new CustomEvent('sf:dinner-best',{detail}));}
 function render(){host.replaceChildren();host.classList.add('dinner-panel');
  const head=E('header',null,{class:'dn-head'});head.append(E('p','Из того, что уже есть дома. Недостающее — одной кнопкой в покупки.',{class:'dn-sub'}));host.append(head);
  if(!scope()){host.append(E('p','Войдите, чтобы увидеть блюда из ваших продуктов.',{class:'dn-note'}));return;}
  const q=queue.view(),status=E('p',q.busy?'Сохраняем…':loading?'Обновляем продукты…':error||q.message||(q.request?'Не знаем, сохранилось ли последнее действие. Повторите — дубля не будет.':''),{id:'dinner-status',role:'status','aria-live':'polite'});host.append(status);
  head.append(button('Обновить',safe(load),'dinner-refresh'));
  if(q.corrupt)host.append(E('p','Не удалось прочитать сохранённое на устройстве действие. Сверьте остатки перед следующими изменениями.',{class:'dn-note'}));
  if(q.request){if(q.redacted)host.append(E('p','Личные данные в незавершённом действии очищены. Сначала проверьте его результат.',{class:'dn-note'}));
   const retry=button(q.request.kind==='resolve'?'Проверить результат':'Повторить',safe(()=>queue.retry()),'dinner-retry');retry.disabled=q.busy||stockLocked();host.append(retry);
   if(q.rejected)host.append(button('Обновить и исправить',safe(async()=>{if(queue.discardRejected()){resetCooking();await load();}}),'dinner-reset'));}
  if(q.lastConsumeId&&!q.request){host.append(button('Отменить списание',safe(()=>queue.start('undo',{operation_id:q.lastConsumeId})),'dinner-undo'));}
  if(error&&q.message)host.append(E('p',error,{class:'dn-note'}));
  if(!snapshot||loadedScope!==key()||!catalog){host.append(E('p','Загружаем ваши продукты…',{class:'dn-note'}));return;}
  const controls=E('fieldset',null,{class:'dn-controls'});controls.disabled=loading||queue.pending()||stockLocked();host.append(controls);
  const filters=E('div',null,{class:'dn-filters'});controls.append(filters);
  for(const [key,label,choices] of [['meal','Приём пищи',M.mealTypes],['cuisine','Кухня',M.cuisines]]){
   const select=E('select',null,{id:'dinner-'+key});Object.entries(choices).forEach(([code,name])=>select.append(E('option',name,{value:code})));
   select.value=selection[key];select.onchange=()=>changeSelection({[key]:select.value});field(filters,label,select);
  }
  const portion=E('input',null,{type:'number',min:'1',max:'100',step:'1',inputmode:'numeric',id:'dinner-portions'});portion.value=selection.portions;
  portion.onchange=()=>{const n=Number(portion.value);if(Number.isInteger(n)&&n>0&&n<=100){selection=M.mealSelection({...selection,portions:n});selectionNotice='';error='';resetCooking();render();}else{error='Порций — от 1 до 100.';render();}};field(filters,'Порции',portion);
  if(selectionNotice)controls.append(E('p',selectionNotice,{role:'status',class:'dn-note'}));
  const who=E('div',null,{class:'dn-who'});controls.append(who);who.append(E('legend','Для кого готовим'));
  if(!snapshot.profile_access_ready)who.append(E('p','Профили пока недоступны. Запасы и покупки работают.',{class:'dn-note'}));
  else if(!snapshot.profiles.length){who.append(E('p','Чтобы учесть, что вы не едите, создайте свой профиль.',{class:'dn-note'}));who.append(button('Создать мой профиль',()=>document.getElementById('my-data-open')?.click(),'dinner-create-profile'));}
  const names={dairy:'без молочного',egg:'без яиц',fish:'без рыбы',nuts:'без орехов',gluten:'без глютена'};
  snapshot.profiles.forEach(p=>{const input=E('input',null,{type:'checkbox','data-dinner-profile':p.id});input.checked=selected.includes(p.id);
   input.onchange=()=>{selected=input.checked?[...selected,p.id]:selected.filter(id=>id!==p.id);resetCooking();render();};
   const extra=[p.diet_mode==='breastfeeding'?'кормящая мама':null,...(p.excluded_foods||[]).map(x=>names[x]||x)].filter(Boolean).join(', ');
   field(who,p.name+(extra?' · '+extra:''),input);
  });
  if(!selected.length){announce({reason:snapshot.profiles.length?'select':'profile',meal:selection.meal});controls.append(E('p','Отметьте, для кого готовим, — учтём ограничения.',{class:'dn-note'}));renderLots(controls);renderCart(controls);return;}
  let ctx,choices;try{ctx=context();choices=M.selectMeals({...ctx,catalog,selection,day:snapshot.today});}catch{controls.append(E('p','Проверьте настройки профилей.',{class:'dn-note'}));renderLots(controls);renderCart(controls);return;}
  if(!choices.options.length){announce({reason:'empty',meal:selection.meal});controls.append(E('p',choices.status==='no_recipes'?'Для этого приёма пищи и кухни пока нет блюд. Выберите другую кухню.':'С учётом ограничений подходящих блюд нет. Попробуйте другую кухню или приём пищи.',{class:'dn-note'}));renderLots(controls);renderCart(controls);return;}
  const [best,...rest]=choices.options;card(controls,best,true);
  announce({title:best.title,status:best.status,recipeId:best.recipeId,meal:selection.meal,missing:best.lines.filter(l=>l.status==='buy').map(l=>catalog.ingredients[l.ingredientId]?.name||'продукт')});
  if(rest.length){const more=E('div',null,{class:'dn-more'});more.append(E('h3','Ещё варианты'));rest.forEach(c=>card(more,c,false));controls.append(more);}
  const eligible=new Set(choices.eligibleRecipeIds),allowed=catalog.recipes.filter(r=>eligible.has(r.id));
  const selector=E('select',null,{id:'dinner-recipe'});selector.append(E('option','Выбрать блюдо из списка',{value:''}));allowed.forEach(r=>selector.append(E('option',r.title,{value:r.id})));selector.value=allowed.some(r=>r.id===recipeId)?recipeId:'';
  selector.onchange=()=>{recipeId=selector.value||null;resetCooking();render();};field(controls,'Или выберите сами',selector);
  if(!allowed.some(r=>r.id===recipeId)){recipeId=null;renderLots(controls);renderCart(controls);return;}
  const plan=E('section',null,{id:'dinner-plan',class:'dn-plan'});controls.append(plan);
  const result=M.evaluateMenu({...ctx,meals:meals()});plan.append(E('h3',recipe().title),E('p',selection.portions+' '+(selection.portions===1?'порция':selection.portions<5?'порции':'порций'),{class:'dn-sub'}));explain(plan,result);
  const actions=E('div',null,{class:'dn-actions'});plan.append(actions);
  for(const [count,label]of [[1,'Докупить недостающее'],[7,'Это блюдо на неделю: в покупки']]){
   const action=button(label,safe(async()=>{await load();const coverage=M.evaluateMenu({...context(),meals:meals(count)});if(coverage.status==='clarify'||coverage.blocked.length)throw Error('Сначала уточните количество и сроки продуктов ниже.');
    const desired=Object.fromEntries(M.shopping(coverage).map(l=>[l.ingredientId,l.amount])),scope_id=selection.meal+':'+snapshot.today;await queue.start('shopping',{profiles:profiles(),meals:wireMeals(meals(count)),desired,scope_id,expected_scope_revision:snapshot.demand_versions?.[scope_id]||0});}),count===1?'dinner-shopping':'dinner-week-shopping');
   actions.append(action);
  }
  plan.append(E('p','Список покупок пересчитывается под выбранное блюдо. Продукты списываются только после «Приготовил».',{class:'dn-note'}));
  const steps=E('ol',null,{class:'dn-steps'});recipe().steps.forEach((text,i)=>{const li=E('li',text,{class:i<step?'done':i===step?'now':''});steps.append(li);});plan.append(steps);
  if(step<recipe().steps.length)plan.append(button('Следующий шаг',()=>{step++;render();},'dinner-next-step'));
  else{const done=button('Приготовил — списать продукты',safe(async()=>{await load();const fresh=M.evaluateMenu({...context(),meals:meals()});if(fresh.status!=='enough')throw Error('Продукты изменились или их нужно уточнить. Проверьте состав.');
    actual=fresh.lines.flatMap(l=>l.allocations);actualDraft={};render();}),'dinner-cooked');plan.append(done);}
  if(actual){const form=E('form',null,{id:'dinner-actual'});form.append(E('h3','Сколько ушло на самом деле'));
   actual.forEach(a=>{const l=snapshot.fridge_items.find(l=>l.id===a.lotId),input=E('input',null,{type:'number',min:'0',max:String(a.amount/factor(l.unit)),step:l.unit==='шт'?'1':'0.001',inputmode:'decimal','data-actual-lot':l.id});input.value=actualDraft[l.id]??String(a.amount/factor(l.unit));input.oninput=()=>actualDraft[l.id]=input.value;field(form,l.name+', '+l.unit,input);});
   form.append(E('p','Спишем ровно столько. 0 — продукт не использовали.',{class:'dn-note'}));
   const confirm=E('button','Списать',{type:'submit',id:'dinner-confirm'});form.append(confirm,button('Отмена',()=>{resetCooking();render();},'dinner-cancel'));
   form.onsubmit=async event=>{event.preventDefault();await safe(async()=>{const deltas=actual.map(a=>({id:a.lotId,expected_version:a.expectedVersion,amount:form.querySelector('[data-actual-lot="'+a.lotId+'"]').value})).filter(d=>Number(d.amount)!==0);
    deltas.forEach(d=>actualDraft[d.id]=d.amount);if(!deltas.length)throw Error('Укажите хотя бы одно количество больше нуля.');await queue.start('consume',{profiles:profiles(),meals:wireMeals(meals()),deltas});})();};plan.append(form);
  }
  renderLots(controls);
  renderCart(controls);
 }
 function explain(parent,result){const ul=E('ul',null,{class:'dn-lines'});for(const l of result.lines){const name=catalog.ingredients[l.ingredientId]?.name||'Продукт';
   const need=l.required!==null?M.formatAmount(l.required,l.dimension):null,have=l.required!==null?M.formatAmount(l.knownAllocated,l.dimension):null;
   let text=l.status==='enough'?'есть':l.status==='buy'?'не хватает '+M.formatAmount(l.missingExact,l.dimension)+(need?' (нужно '+need+', есть '+have+')':''):(need?'есть ли '+need+'?':'уточните количество');
   const li=E('li',null,{class:'dn-line dn-l-'+(l.status||'clarify')});li.append(E('span',name,{class:'dn-line-name'}),E('span',text,{class:'dn-line-state'}));ul.append(li);}parent.append(ul);}
 function renderLots(parent){const details=E('details',null,{id:'dinner-lots'});
  const pendingLots=snapshot.fridge_items.filter(l=>!l.dinner_excluded&&(!l.ingredient_id||l.quantity_source!=='user'));
  const matches=pendingLots.map(l=>({l,id:l.ingredient_id||suggestIngredient(l.name,catalog.ingredients)})).filter(x=>x.id);
  details.append(E('summary',pendingLots.length?'Уточнить продукты для рецептов · '+pendingLots.length:'Продукты для рецептов'));
  if(matches.length){const all=button('Подтвердить совпадения ('+matches.length+')',safe(async()=>{for(const {l,id}of matches){const fresh=snapshot.fridge_items.find(x=>x.id===l.id);if(!fresh)continue;
     const ok=await queue.start('confirm_lot',{id:fresh.id,expected_version:fresh.dinner_version,ingredient_id:id,qty_num:fresh.qty_num,unit:fresh.unit,expires_on:fresh.expiry_estimated?'':(fresh.expires_on||'')});if(!ok)break;}}),'dinner-confirm-matches');
   details.append(E('p','Мы сопоставили названия с продуктами рецептов. Проверьте количество — примерные сроки останутся «уточнить».',{class:'dn-note'}),all);}
  snapshot.fridge_items.forEach(l=>{const form=E('form',null,{'data-lot-form':l.id});form.append(E('h4',l.name));const draft=drafts[l.id]||{};
   const select=E('select',null,{'data-lot-ingredient':l.id});select.append(E('option','Какой это продукт?',{value:''}));Object.entries(catalog.ingredients).forEach(([id,v])=>select.append(E('option',v.name,{value:id})));select.value=draft.ingredient_id??l.ingredient_id??suggestIngredient(l.name,catalog.ingredients)??'';field(form,'Продукт',select);
   const number=E('input',null,{type:'number',min:'0',step:'0.001','data-lot-quantity':l.id});number.value=draft.qty_num??l.qty_num;field(form,'Сколько есть',number);
   const unit=E('select');['г','кг','мл','л','шт'].forEach(u=>unit.append(E('option',u,{value:u})));unit.value=draft.unit??l.unit;field(form,'Единица',unit);
   const expiry=E('input',null,{type:'date','data-lot-expiry':l.id});expiry.value=draft.expires_on??l.expires_on??'';field(form,l.expiry_estimated?'Годен до (примерно — сверьте с упаковкой)':'Годен до',expiry);
   const preserve=()=>drafts[l.id]={ingredient_id:select.value,qty_num:number.value,unit:unit.value,expires_on:expiry.value};[select,number,unit,expiry].forEach(n=>n.addEventListener('input',preserve));
   if(l.dinner_excluded)form.append(E('p','Не участвует в рецептах. Количество и срок не изменены.',{class:'dn-note'}));
   form.append(button(l.dinner_excluded?'Учитывать в рецептах':'Не учитывать в рецептах',safe(()=>queue.start('exclude_lot',{id:l.id,expected_version:l.dinner_version,excluded:!l.dinner_excluded})), 'dinner-exclude-'+l.id));
   form.append(E('button','Сохранить',{type:'submit','data-confirm-lot':l.id}));form.onsubmit=async ev=>{ev.preventDefault();preserve();await safe(async()=>{const ok=await queue.start('confirm_lot',{id:l.id,expected_version:l.dinner_version,...drafts[l.id]});if(ok){delete drafts[l.id];render();}})();};details.append(form);
  });parent.append(details);}
 function renderCart(parent){
  if(snapshot.events?.length){const history=E('details',null,{id:'dinner-history'});history.append(E('summary','Что уже списали'));
   snapshot.events.forEach(e=>{const entry=E('p',e.kind==='consume'?'Списано: ':'Возвращено: ');entry.append(document.createTextNode(e.quantities.map(q=>(catalog.ingredients[q.ingredient_id]?.name||'Продукт')+' '+q.amount+' '+q.unit).join(', ')));history.append(entry);});parent.append(history);}
  const carts=snapshot.cart_items.filter(c=>c.dinner_scope);if(!carts.length)return;const box=E('section',null,{id:'dinner-purchases'});box.append(E('h3','Купить для этих блюд'));
  carts.forEach(c=>{const row=E('div');row.append(E('p',c.name+' · '+c.qty_num+' '+c.unit));const expiry=E('input',null,{type:'date','aria-label':'Срок покупки '+c.name});expiry.value=purchaseDraft[c.id]||'';expiry.oninput=()=>purchaseDraft[c.id]=expiry.value;field(row,'Годен до (можно позже)',expiry);
   row.append(button('Куплено',safe(()=>queue.start('buy',{id:c.id,expected:c,expires_on:expiry.value})), 'dinner-buy-'+c.id));box.append(row);});parent.append(box);}
 window.addEventListener('sf:inventory',()=>{if(loading)needsRefresh=true;else if(!queue.pending()||!snapshot||loadedScope!==key()||!catalog)load();else render();});
 function clear(){queue.redact();generation++;snapshot=null;loadedScope='';selected=[];selection=M.mealSelection();selectionNotice='';recipeId=null;step=0;actual=null;drafts={};actualDraft={};purchaseDraft={};error='';render();}
 // My Data must emit this before sending a deletion, including an uncertain one.
 // Resolve any pending receipt by opaque ID; never keep its deleted profile input.
 window.addEventListener('sf:personal-data-deleting',clear);
 load();return {pending:()=>queue.pending(),refresh:load,clear,openSelection};
}};
})(globalThis);
