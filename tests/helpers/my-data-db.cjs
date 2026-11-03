const fs=require('node:fs'),path=require('node:path');
const {createStockDb,user,other,stranger,household}=require('./stock-db.cjs');
const A='30000000-0000-4000-8000-000000000001',B='30000000-0000-4000-8000-000000000002',legacy='30000000-0000-4000-8000-000000000003';
async function createMyDataDb(){
 const f=await createStockDb();
 for(const [id,owner,name] of [[A,user,'=OWNER'],[B,other,'OTHER SECRET'],[legacy,null,'UNCLAIMED SECRET']]){
 await f.db.query("insert into family_profiles(id,household_id,created_by,profile_owner_user_id,name,sex,age,height_cm,start_weight_kg) values($1,$2,$3,$4,$5,'male',30,170,70)",[id,household,user,owner,name]);
 await f.db.query("insert into family_measurements(profile_id,log_date,weight) values($1,'2026-11-03',70)",[id]);
 }
 for(const [actor,body] of [[user,'OWNER ARCHIVE'],[other,'OTHER ARCHIVE']]){
 await f.db.query("insert into measurement_logs(user_id,log_date,weight) values($1,'2026-11-01',70)",[actor]);
 await f.db.query("insert into dietitian_messages(user_id,role,content) values($1,'user',$2)",[actor,body]);
 await f.db.query("insert into dietitian_summaries(user_id,week_start,summary) values($1,'2026-11-02',$2)",[actor,body+' SUMMARY']);
 }
 async function data(args={},actor=user,role='authenticated',anonymous=false){return f.db.transaction(async tx=>{
 await tx.exec('set local role '+role);await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor||'']);await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor,session_id:actor,is_anonymous:anonymous})]);
 return (await tx.query('select public.sf_my_data($1,$2,$3,$4) result',[args.action||'read',args.profile_id||null,args.scope||null,args.request_id||null])).rows[0].result;
 });}
 return {...f,data};
}
module.exports={createMyDataDb,user,other,stranger,household,A,B,legacy};
