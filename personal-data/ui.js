/* Receives only authenticated RPC snapshots; no family-list fallback or persistent data cache. */
(function(){
 'use strict';
 let generation=0,snapshot=null,busy=false,pending=null;
 const el=id=>document.getElementById(id);
 const profileForm=el('own-profile-form');
 const status=text=>el('my-data-status').textContent=text;
 function reset(){profileForm.reset();profileForm.hidden=true;generation++;snapshot=null;pending=null;busy=false;el('my-data-content').replaceChildren();el('my-data-confirmation').hidden=true;el('my-data-confirm').value='';el('my-data-delete-label').textContent='';status('');updateButtons();}
 function updateButtons(){for(const id of ['my-data-json','my-data-csv'])el(id).disabled=busy||!snapshot||!!pending?.sent;el('my-data-delete').disabled=busy;profileForm.querySelector('button').disabled=busy||!!pending;}
 function download(name,type,text){const u=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
 async function read(){
  const actor=currentUserId,version=++generation;snapshot=null;profileForm.hidden=true;el('my-data-content').replaceChildren();busy=true;updateButtons();status('Загружаем только ваши данные…');
  try{
   const {data,error}=await sb.rpc('sf_my_data',{action:'read_v2'});
   if(actor!==currentUserId||version!==generation)return;
   if(error||!data||data.version!==1||data.export_contract!==2||data.dinner?.version!==1)throw Error('unavailable');
   snapshot=data;profileForm.hidden=typeof SF_DINNER_ENABLED==='undefined'||!SF_DINNER_ENABLED||data.profiles.length!==0;render();status('Данные загружены. Доступ к личным сведениям — только у вашего аккаунта.');return data;
  }catch{if(actor===currentUserId&&version===generation)status('Не удалось загрузить данные. Доступ или схема ещё не готовы. Экспорт недоступен; чужие профили не запрашиваются.');}
  finally{if(actor===currentUserId&&version===generation){busy=false;updateButtons();}}
 }
 profileForm.onsubmit=async event=>{
  event.preventDefault();
  if(busy||pending||!snapshot||profileForm.hidden)return;
  const actor=currentUserId,version=++generation,values=new FormData(profileForm);
  const current=()=>actor===currentUserId&&version===generation;
  busy=true;updateButtons();status('Создаём ваш профиль…');
  try{
   const {data:ticket,error:prepareError}=await sb.rpc('sf_create_own_dinner_profile',{action:'prepare'});
   if(!current())return;
   if(prepareError?.code==='23505'){await read();return;}
   if(prepareError||ticket?.status!=='ready'||!ticket.request_id)throw Error('unavailable');
   const {data,error}=await sb.rpc('sf_create_own_dinner_profile',{
    action:'create',request_id:ticket.request_id,profile_name:values.get('profile_name'),
    profile_age:Number(values.get('profile_age')),exclusions:values.getAll('exclusions')
   });
   if(!current())return;
   if(error||data?.status!=='created'||data.profile_id!==ticket.request_id)throw Error('unconfirmed');
   profileForm.reset();
   const fresh=await read();
   if(actor!==currentUserId||!fresh||snapshot!==fresh)return;
   status('Ваш личный профиль создан. Теперь его можно выбрать в «Ужине».');
   globalThis.sfDinner?.refresh();
  }catch{if(current())status('Сохранение не подтверждено. Обновите данные или повторите попытку.');}
  finally{if(current()){busy=false;updateButtons();}}
 };
 function pendingKey(){return 'sf_data_delete_'+currentUserId;}
 function restorePending(){
  try{
   const saved=JSON.parse(sessionStorage.getItem(pendingKey())||'null');
   if(saved?.actor!==currentUserId||!saved.sent||!['profile','measurements','legacy_ai','legacy_measurements'].includes(saved.scope)||!saved.request_id)return;
   pending=saved;el('my-data-confirmation').hidden=false;el('my-data-confirm').value='';
   el('my-data-delete-label').textContent='Есть неподтверждённый запрос удаления ('+(saved.scope==='legacy_ai'?'архив аккаунта':saved.scope==='legacy_measurements'?'старые замеры аккаунта':saved.scope==='profile'?'личный профиль':'замеры')+'). Повтор использует тот же номер операции и проверяет результат. Чтобы подтвердить повтор, введите УДАЛИТЬ.';
   updateButtons();
  }catch{}
 }
 function render(){
  const box=el('my-data-content');box.replaceChildren();
  for(const p of snapshot.profiles){
   const details=document.createElement('details');const title=document.createElement('summary');title.textContent=p.name+' — мой личный профиль';details.append(title);
   const fields={name:'Имя',sex:'Пол',age:'Возраст',height_cm:'Рост, см',start_weight_kg:'Начальный вес, кг',target_weight_kg:'Прежняя цель веса (не используется)',goal:'Прежний режим (не используется)',activity_level:'Указанная активность',diet_mode:'Указанный режим питания',baby_age_months:'Указанный возраст ребёнка, мес.',excluded_foods:'Исключения',created_at:'Дата создания'};
   const labels={male:'мужской',female:'женский',standard:'общий',breastfeeding:'ГВ',maintain:'поддержание',lose:'снижение',low:'низкая',moderate:'средняя',high:'высокая',dairy:'молочное',egg:'яйца',fish:'рыба',nuts:'орехи',gluten:'глютен'};
   const dl=document.createElement('dl');
   for(const [key,label] of Object.entries(fields)){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;const v=p[key];dd.textContent=v==null?'не указано':Array.isArray(v)?(v.map(x=>labels[x]||x).join(', ')||'не заданы'):(labels[v]||String(v));dd.style.overflowWrap='anywhere';dl.append(dt,dd);}details.append(dl);
   const measurements=document.createElement('p');measurements.textContent='Записей замеров: '+snapshot.measurements.filter(m=>m.profile_id===p.id).length;details.append(measurements);
   for(const [scope,label] of [['measurements','Удалить историю замеров'],['profile','Удалить личный профиль']]){const b=document.createElement('button');b.type='button';b.className='secondary-btn';b.textContent=label;b.onclick=()=>prepare(scope,p.id,p.name);details.append(b);}box.append(details);
  }
  if(!snapshot.profiles.length){const p=document.createElement('p');p.textContent='Подтверждённых личных профилей нет. Старые профили не присваиваются автоматически.';box.append(p);}
  const records=document.createElement('details');const title=document.createElement('summary');title.textContent='Мои замеры';records.append(title);for(const m of snapshot.measurements){const line=document.createElement('p');line.textContent=m.log_date+' · '+(snapshot.profiles.find(p=>p.id===m.profile_id)?.name||'Личный профиль')+' · вес: '+(m.weight??'не указан')+' кг · шея: '+(m.neck??'—')+' · грудь: '+(m.chest??'—')+' · живот: '+(m.belly??'—')+' · бёдра: '+(m.hips??'—')+' см';records.append(line);}box.append(records);
  const dinners=document.createElement('details'),dinnerTitle=document.createElement('summary');dinnerTitle.textContent='Мои действия в «Ужине»: '+snapshot.dinner.operations.length;dinners.append(dinnerTitle);const dinnerNote=document.createElement('p');dinnerNote.textContent='Полные собственные записи входят в JSON и CSV. Личный контекст ужина очищается вместе с профилем; общий журнал запасов и квитанции для безопасного повтора сохраняются.';dinners.append(dinnerNote);for(const o of snapshot.dinner.operations){const line=document.createElement('p');const labels={consume:'Подтверждённый расход',undo:'Отмена расхода',shopping:'Добавление покупок',buy:'Покупка',confirm_lot:'Подтверждение партии',exclude_lot:'Исключение партии',cancelled:'Запрос отменён'};line.textContent=o.created_at+' · '+(labels[o.kind]||'Действие с запасами')+(o.undone?' · отменено':'');dinners.append(line);}box.append(dinners);
  const old=document.createElement('details'),oldTitle=document.createElement('summary');oldTitle.textContent='Старые замеры аккаунта: '+snapshot.legacy_measurements.length;old.append(oldTitle);for(const m of snapshot.legacy_measurements){const line=document.createElement('p');line.textContent=m.log_date+' · вес: '+(m.weight??'—')+' кг · шея: '+(m.neck??'—')+' · грудь: '+(m.chest??'—')+' · живот: '+(m.belly??'—')+' · бёдра: '+(m.hips??'—')+' см';old.append(line);}const oldDelete=document.createElement('button');oldDelete.type='button';oldDelete.className='secondary-btn';oldDelete.textContent='Удалить старые замеры аккаунта';oldDelete.onclick=()=>prepare('legacy_measurements',null,'Старые замеры аккаунта');old.append(oldDelete);box.append(old);
  const archive=document.createElement('details');const heading=document.createElement('summary');heading.textContent='Старый архив аккаунта: '+snapshot.legacy_messages.length+' сообщений, '+snapshot.legacy_summaries.length+' выжимок';archive.append(heading);
  const note=document.createElement('p');note.textContent='Архив не относится автоматически к выбранному профилю. Он не используется AI.';archive.append(note);
  for(const item of [...snapshot.legacy_messages,...snapshot.legacy_summaries]){const p=document.createElement('p');p.textContent=item.created_at+' · '+(item.content??item.summary);p.style.overflowWrap='anywhere';archive.append(p);}
  const b=document.createElement('button');b.type='button';b.className='secondary-btn';b.textContent='Удалить переписку и выжимки';b.onclick=()=>prepare('legacy_ai',null,'Старый архив аккаунта');archive.append(b);box.append(archive);
 }
 async function prepare(scope,profileId,label){
  if(busy)return;
  if(pending?.sent){restorePending();status('Сначала проверьте результат незавершённого удаления. Номер запроса сохранён.');return;}
  const actor=currentUserId,version=++generation;busy=true;pending=null;updateButtons();status('Готовим подтверждение удаления…');
  try{
   const {data,error}=await sb.rpc('sf_my_data',{action:'prepare_delete',scope,profile_id:profileId});
   if(actor!==currentUserId||version!==generation)return;
   if(error||data?.status!=='confirmation_required'||!data.request_id||data.scope!==scope||data.profile_id!==profileId)throw Error('unavailable');
   pending={scope,profile_id:profileId,request_id:data.request_id,expires_at:data.expires_at,actor,sent:false};
   el('my-data-confirmation').hidden=false;el('my-data-confirm').value='';
   el('my-data-delete-label').textContent='Удаление: '+label+'. '+(scope==='profile'?'Исчезнут профиль и все его замеры.':scope==='legacy_ai'?'Исчезнут сообщения и производные выжимки.':'Исчезнут все выбранные замеры.')+' Общий холодильник и покупки сохранятся. Номер запроса действует 90 дней; затем повтор отклоняется.';
   el('my-data-confirm').focus();status('Для удаления введите УДАЛИТЬ.');
  }catch{if(actor===currentUserId&&version===generation)status('Подтверждение не получено. Удаление не отправлялось.');}
  finally{if(actor===currentUserId&&version===generation){busy=false;updateButtons();}}
 }
 async function erase(){
  if(busy||!pending||pending.actor!==currentUserId||el('my-data-confirm').value!=='УДАЛИТЬ')return;
  const request=pending,version=++generation,actor=currentUserId;pending.sent=true;window.dispatchEvent(new Event('sf:personal-data-deleting'));busy=true;updateButtons();status('Удаляем. При потере ответа можно повторить тот же запрос.');
  try { sessionStorage.setItem(pendingKey(),JSON.stringify({...request,sent:true})); } catch {}
  // Invalidate any downloadable snapshot immediately; no stale export while deletion is uncertain.
  snapshot=null;profileForm.hidden=true;el('my-data-content').replaceChildren();
  try{
   const {data,error}=await sb.rpc('sf_my_data',{action:'delete',scope:request.scope,profile_id:request.profile_id,request_id:request.request_id});
   if(version!==generation||actor!==currentUserId)return;
   if(error?.code==='22023'){try{sessionStorage.removeItem(pendingKey());}catch{}pending=null;el('my-data-confirmation').hidden=true;status('Запрос истёк или недействителен. Этот повтор отклонён. Обновите данные; новое удаление потребует нового подтверждения.');return;}
   if(error||(data?.status!=='active_database_deleted'||data.request_id!==request.request_id))throw Error('unconfirmed');
   try { sessionStorage.removeItem(pendingKey()); } catch {}
   pending=null;el('my-data-confirmation').hidden=true;
   resetPrivateContext();familyProfiles=[];
   await read();
   if(actor===currentUserId&&globalThis.sfDinner?.refresh)await globalThis.sfDinner.refresh();
   if(actor===currentUserId)status('Удаление из активной базы подтверждено. Удаление из резервных копий и у внешнего провайдера не подтверждено.');
  }catch{if(version===generation&&actor===currentUserId)status('Удаление не подтверждено. Нажмите «Удалить» ещё раз для безопасной проверки результата.');}
  finally{if(actor===currentUserId){busy=false;updateButtons();}}
 }
 el('my-data-open').onclick=async()=>{reset();history.push('my-data');showScreen('my-data',false);const fresh=await read();if(fresh)restorePending();};
 el('my-data-refresh').onclick=()=>{if(!busy&&!pending)read();};
 for(const kind of ['json','csv'])el('my-data-'+kind).onclick=async()=>{
  if(busy||!snapshot||pending?.sent)return;
  const actor=currentUserId;
  const fresh=await read(); // Recheck ownership with the server for every export.
  if(!fresh||actor!==currentUserId||snapshot!==fresh)return;
  download('smart-fridge-my-data.'+kind,kind==='json'?'application/json;charset=utf-8':'text/csv;charset=utf-8',kind==='json'?JSON.stringify(snapshot,null,2):SFDataExport.csv(snapshot));
 };
 el('my-data-delete').onclick=erase;
 el('my-data-cancel').onclick=()=>{if(busy)return;if(pending?.sent){status('Запрос уже отправлялся. Проверьте его результат тем же номером; отмена не подтверждает сохранность данных.');return;}try { sessionStorage.removeItem(pendingKey()); } catch {}pending=null;el('my-data-confirmation').hidden=true;el('my-data-confirm').value='';};
 window.addEventListener('sf-account-reset',reset);
 document.addEventListener('visibilitychange',()=>{if(document.hidden){reset();}else if(currentUserId&&el('screen-my-data').classList.contains('active')){read().then(fresh=>{if(fresh)restorePending();});}});
})();
