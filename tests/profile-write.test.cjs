const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {createStockDb,user,other,stranger}=require('./helpers/stock-db.cjs');
let f;
test.before(async()=>{f=await createStockDb();});
test.after(async()=>{await f?.db.close();});
const as=(actor,query,args=[],claims={})=>f.db.transaction(async tx=>{
 await tx.exec('set local role authenticated');
 await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor,session_id:actor,...claims})]);
 return (await tx.query(query,args)).rows[0]?.result;
});
const write=(actor,action,id,fields={},claims)=>as(actor,'select public.sf_profile_write($1,$2,$3::jsonb) result',[action,id,JSON.stringify(fields)],claims);
const my=actor=>as(actor,"select public.sf_my_data('read') result");
const today=()=>new Date().toISOString().slice(0,10);

test('owner creates and edits own profile; retry is idempotent; household member cannot see or change it',async()=>{
 const id=randomUUID();
 const created=await write(user,'create_profile',id,{name:' Айгерим ',age:34,sex:'female',height_cm:165,start_weight_kg:62,excluded_foods:['nuts']});
 assert.deepEqual(created,{status:'created',profile_id:id});
 assert.deepEqual(await write(user,'create_profile',id,{name:'Айгерим',age:34}),created);
 const mine=(await my(user)).profiles.find(p=>p.id===id);
 assert.equal(mine.name,'Айгерим');assert.deepEqual(mine.excluded_foods,['nuts']);
 assert.equal((await my(other)).profiles.some(p=>p.id===id),false);
 await assert.rejects(write(other,'update_profile',id,{name:'Чужое'}),{code:'42501'});
 await assert.rejects(write(other,'create_profile',id,{name:'Захват'}),{code:'42501'});
 await write(user,'update_profile',id,{target_weight_kg:58,meal_choices:{'1':{d:'x'}}});
 const after=(await my(user)).profiles.find(p=>p.id===id);
 assert.equal(Number(after.target_weight_kg),58);assert.equal(after.name,'Айгерим');assert.deepEqual(after.meal_choices,{'1':{d:'x'}});
});

test('invalid input is refused without partial writes',async()=>{
 const id=randomUUID();
 await write(user,'create_profile',id,{name:'Дана',age:9});
 await assert.rejects(write(user,'update_profile',id,{unknown:1}),{code:'22023'});
 await assert.rejects(write(user,'update_profile',id,{age:'много'}),{code:'22023'});
 await assert.rejects(write(user,'update_profile',id,{age:500}),{code:'22023'});
 await assert.rejects(write(user,'update_profile',id,{excluded_foods:['bread']}),{code:'22023'});
 await assert.rejects(write(user,'update_profile',id,{name:'   '}),{code:'22023'});
 await assert.rejects(write(user,'update_profile',id,{goal:'gain'}),{code:'22023'});
 const p=(await my(user)).profiles.find(x=>x.id===id);
 assert.equal(p.age,9);assert.equal(p.name,'Дана');
});

test('measurements: upsert per day, partial update keeps other fields, delete, foreign profile refused',async()=>{
 const id=randomUUID();
 await write(user,'create_profile',id,{name:'Ерлан',age:40,sex:'male',height_cm:180,start_weight_kg:90});
 const day=today();
 await write(user,'upsert_measurement',id,{log_date:day,weight:89.4,belly:96});
 await write(user,'upsert_measurement',id,{log_date:day,weight:89.1});
 let ms=(await my(user)).measurements.filter(m=>m.profile_id===id);
 assert.equal(ms.length,1);assert.equal(Number(ms[0].weight),89.1);assert.equal(Number(ms[0].belly),96);
 await assert.rejects(write(user,'upsert_measurement',id,{log_date:day,weight:1}),{code:'22023'});
 await assert.rejects(write(user,'upsert_measurement',id,{log_date:'2999-01-01',weight:80}),{code:'22023'});
 await assert.rejects(write(user,'upsert_measurement',id,{log_date:day,weight:80,shoe:42}),{code:'22023'});
 await assert.rejects(write(other,'upsert_measurement',id,{log_date:day,weight:70}),{code:'42501'});
 await assert.rejects(write(other,'delete_measurement',id,{log_date:day}),{code:'42501'});
 assert.equal((await write(user,'delete_measurement',id,{log_date:day})).removed,1);
 ms=(await my(user)).measurements.filter(m=>m.profile_id===id);
 assert.equal(ms.length,0);
});

test('direct table writes stay closed; anonymous and unknown sessions are refused',async()=>{
 await assert.rejects(as(user,"insert into public.family_profiles(name,age,profile_owner_user_id) values('Direct',30,$1) returning id as result",[user]));
 await assert.rejects(write(user,'create_profile',randomUUID(),{name:'Anon'},{is_anonymous:true}),{code:'42501'});
 await assert.rejects(write(stranger,'create_profile',randomUUID(),{name:'NoSession'},{session_id:randomUUID()}),{code:'42501'});
 await assert.rejects(write(user,'drop_everything',randomUUID()),{code:'22023'});
});
