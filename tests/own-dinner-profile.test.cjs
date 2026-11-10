const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {createStockDb,user,other,stranger,household}=require('./helpers/stock-db.cjs');
let f;
test.before(async()=>{f=await createStockDb();});
test.after(async()=>{await f?.db.close();});
const as=(actor,query,args=[])=>f.db.transaction(async tx=>{
 await tx.exec('set local role authenticated');
 await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor,session_id:actor})]);
 return (await tx.query(query,args)).rows[0]?.result;
});
const profile=(actor,action,id=null,name=null,age=null,exclusions=null)=>as(actor,'select public.sf_create_own_dinner_profile($1,$2,$3,$4,$5) result',[action,id,name,age,exclusions]);
const my=(actor,action='read_v2',id=null,scope=null,request=null)=>as(actor,'select public.sf_my_data($1,$2,$3,$4) result',[action,id,scope,request]);
test('acceptance scopes to one household; new owner is server-derived and a deleted profile cannot be recreated by retry',async()=>{
 await assert.rejects(profile(user,'prepare'),{code:'55000'});
 await f.db.query("update sf_private.dinner_release_control set acceptance_household=$1,acceptance_until=clock_timestamp()+interval '20 minutes'",[household]);
 await assert.rejects(profile(stranger,'prepare'),{code:'55000'});
 const legacy=randomUUID();
 await f.db.query("insert into public.family_profiles(id,name,age,created_by) values($1,'Old private',40,$2)",[legacy,user]);
 const {request_id:id}=await profile(user,'prepare');
 await assert.rejects(profile(other,'create',id,'Other',30,[]),{code:'22023'});
 await assert.rejects(profile(user,'create',id,'Too young',17,[]),{code:'22023'});
 await assert.rejects(profile(user,'create',id,'Owner',30,['unknown']),{code:'22023'});
 const saved=await profile(user,'create',id,'Owner',30,['egg']);
 assert.deepEqual(await profile(user,'create',id,'Owner',30,['egg']),saved);
 await assert.rejects(profile(user,'prepare'),{code:'23505'});
 assert.deepEqual((await my(user)).profiles.map(p=>[p.id,p.start_weight_kg,p.height_cm,p.sex]),[[id,null,null,null]]);
 assert.deepEqual((await my(other)).profiles,[]);
 assert.deepEqual((await f.db.query('select profile_owner_user_id from public.family_profiles where id=$1',[legacy])).rows,[{profile_owner_user_id:null}]);
 const receipt=await my(user,'prepare_delete',id,'profile');
 await my(user,'delete',id,'profile',receipt.request_id);
 await assert.rejects(profile(user,'create',id,'Owner',30,['egg']),{code:'22023'});
 assert.deepEqual((await my(user)).profiles,[]);
 assert.notEqual((await profile(user,'prepare')).request_id,id);
 await f.db.exec("update sf_private.dinner_release_control set acceptance_until=clock_timestamp()-interval '1 second'");
 await assert.rejects(profile(user,'prepare'),{code:'55000'});
});
test('stock undo still handles a pre-Dinner receipt and advances lot version',async()=>{
 const id=await f.add();
 const used=randomUUID();
 await f.rpc('used',{id,amount:10,expected_qty:500,expected_unit:'г'},{id:used});
 await f.db.query("update sf_private.stock_operations set before_item=before_item-array['ingredient_id','quantity_source','date_source','dinner_version','dinner_excluded'], after_item=after_item-array['ingredient_id','quantity_source','date_source','dinner_version','dinner_excluded'] where id=$1",[used]);
 // Recreate the migrated state of an untouched legacy lot (the new trigger did not yet exist when it was used).
 await f.db.exec('alter table public.fridge_items disable trigger dinner_version');
 await f.db.query('update public.fridge_items set dinner_version=0 where id=$1',[id]);
 await f.db.exec('alter table public.fridge_items enable trigger dinner_version');
 await f.rpc('undo',{operation_id:used});
 const {rows:[row]}=await f.db.query('select qty_num,dinner_version,quantity_source from public.fridge_items where id=$1',[id]);
 assert.equal(Number(row.qty_num),500);assert.equal(Number(row.dinner_version),1);assert.equal(row.quantity_source,'legacy_unknown');
});
