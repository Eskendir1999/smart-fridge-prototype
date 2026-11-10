const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function extract(source,name){const i=source.search(new RegExp('(?:async )?function '+name+'\\('));assert.ok(i>=0,name);const tail=source.slice(i);return tail.slice(0,tail.indexOf('\n}')+2);}
function context(names,values={}){const c=vm.createContext(values);vm.runInContext(names.map(n=>extract(html,n)).join('\n'),c);return c;}
test('production-disabled profiles are cleared without reading the legacy family schema',async()=>{
 let resets=0,renders=0;
 const c=context(['loadFamilyProfiles'],{SF_NUTRITION_ENABLED:false,currentUserId:'fixture',familyProfiles:[{name:'old private'}],resetPrivateContext:()=>resets++,renderFamilyGrid:()=>renders++,sb:{from(){throw Error('No personal read in production');}}});
 await vm.runInContext('loadFamilyProfiles()',c);assert.equal(c.familyProfiles.length,0);assert.equal(resets,1);assert.equal(renders,1);
});
test('native snapshot strips all personal fields even if a caller supplies a profile',()=>{
 const c=context(['buildWidgetSnapshot'],{Date,cartData:[{_id:'cart-id',name:'Shared shopping'}]});
 const snap=vm.runInContext('buildWidgetSnapshot({name:"private",start_weight_kg:70},[{weight:80}])',c);
 for(const k of ['profileName','weightNow','weightStart','weightGoal','startTs','lastWeighTs'])assert.equal(snap[k],null);
 assert.equal(snap.trend.length,0);assert.equal(snap.cart[0].name,'Shared shopping');
});
test('native sync clears prior personal snapshot and never schedules disabled reminders',async()=>{
 let snapshot,purchases=0;
 const c=context(['syncNativeExtras','widgetProfileRows','buildWidgetSnapshot'],{currentUserId:'fixture',userDataLoaded:true,nativeSyncRunning:false,SF_NOTIFICATIONS_ENABLED:false,Date,cartData:[],nativePlugin:()=>({setSnapshot:async v=>snapshot=JSON.parse(v.json)}),applyWidgetPurchases:async()=>purchases++,scheduleNativeReminders(){throw Error('Reminders disabled');},maybeStartMealActivity(){throw Error('Activity disabled');},sb:{from(){throw Error('No personal reads');}},console});
 await vm.runInContext('syncNativeExtras()',c);assert.equal(purchases,1);assert.equal(snapshot.weightNow,null);assert.equal(snapshot.profileName,null);assert.equal(c.nativeSyncRunning,false);
});
test('Scriptable upgrades an installed widget without reading old data or making requests',async()=>{
 const source=fs.readFileSync(path.join(root,'scriptable/smart-fridge.js'),'utf8');
 for(const widgetFamily of ['small','medium','large','accessoryCircular','accessoryInline','accessoryRectangular',null]){
  for(const fail of [false,true]){
   const text=[],removed=[],keys=[];let shown=false,completed=false;
   const deny=()=>{throw Error('No old data or network')};
   const context={
    FileManager:{local:()=>({documentsDirectory:()=>'/fixture',joinPath:(dir,file)=>dir+'/'+file,fileExists:()=>true,
     remove(path){removed.push(path);if(fail)throw Error('disk unavailable');},readString:deny})},
    Keychain:{contains:()=>true,remove(key){keys.push(key);if(fail)throw Error('keychain unavailable');},get:deny},
    Request:deny,fetch:deny,config:{runsInWidget:!!widgetFamily,widgetFamily},
    Font:{semiboldSystemFont:()=>null,systemFont:()=>null},
    ListWidget:class {addText(t){text.push(t);return {};}addSpacer(){}},
    Alert:class {addAction(){}async presentAlert(){shown=true;}},
    Script:{setWidget(w){shown=true;assert.equal(w.url,'https://smart-fridge-prototype.vercel.app');},complete(){completed=true;}}
   };
   await vm.runInNewContext('(async()=>{'+source+'})()',context);
   assert.ok(shown&&completed);
   assert.deepEqual(removed,['/fixture/smartfridge-cache.json']);
   assert.deepEqual(keys,['smartfridge.access','smartfridge.refresh','smartfridge.expires','smartfridge.email']);
   assert.deepEqual(text,widgetFamily ? widgetFamily.startsWith('accessory') ? ['Smart Fridge'] : ['Smart Fridge','Открыть приложение'] : []);
  }
 }
});
test('Telegram household summary queries shared stock only and never exposes weight',async()=>{
 const {statusText,lastWeighIn}=require('../api/_lib/fridge');const tables=[];
 const sb={from(table){tables.push(table);assert.ok(['fridge_items','cart_items'].includes(table));const q={select(){return q},eq(){return q},not(){return q},lte(){return q},order(){return q},limit(){return Promise.resolve({data:table==='cart_items'?[{name:'Shared shopping'}]:[]})}};return q;}};
 assert.equal(await lastWeighIn({from(){throw Error('No personal reads');}},'household'),null);
 const result=await statusText(sb,'household','2026-11-03');assert.match(result,/Shared shopping/);assert.doesNotMatch(result,/вес|замер|кг/i);assert.deepEqual(tables,['fridge_items','cart_items']);
});
test('environment flags cannot revive AI or summaries and status discloses held-back privacy',()=>{
 const module={exports:{}};const c=vm.createContext({module,process:{env:{SF_ENABLE_AI_CHAT:'1',SF_ENABLE_AUTOMATIONS:'1'}}});
 vm.runInContext(fs.readFileSync(path.join(root,'api/release-status.js'),'utf8'),c);let body;
 module.exports({method:'GET'},{setHeader(){},status(){return this},json(v){body=v}});assert.equal(body.aiEnabled,false);assert.equal(body.automationsEnabled,false);assert.equal(body.nutritionEnabled,false);
 assert.ok(!fs.existsSync(path.join(root,'supabase/migrations/profile-privacy.sql')));
});
