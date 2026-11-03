const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID}=require('node:crypto');
const root=path.join(__dirname,'../..');
const user='10000000-0000-4000-8000-000000000001';
const other='10000000-0000-4000-8000-000000000002';
const stranger='10000000-0000-4000-8000-000000000003';
const household='20000000-0000-4000-8000-000000000001';
const otherHousehold='20000000-0000-4000-8000-000000000002';
async function createStockDb({database,beforeStockMigration}={}){
  const db=database||new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key,is_anonymous boolean not null default false);
    create table auth.sessions(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,not_after timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    create function auth.role() returns text language sql stable as $$select current_user::text$$;
    grant usage on schema auth to authenticated,anon;
    grant execute on all functions in schema auth to authenticated,anon;`);
  for(const file of ['supabase-schema.sql','supabase-household-migration.sql','supabase-household-security-migration.sql','supabase-food-log-migration.sql','supabase-family-profiles-migration.sql','supabase-diet-mode-migration.sql','supabase-dietitian-migration.sql',
    ...fs.readdirSync(path.join(root,'supabase/migrations')).filter(f=>!f.includes('_deletion_receipt_cron')).map(f=>'supabase/migrations/'+f)]){
    if(file.startsWith('supabase/migrations/') && beforeStockMigration){await beforeStockMigration(db);beforeStockMigration=null;}
    await db.exec(fs.readFileSync(path.join(root,file),'utf8'));
  }
  await db.exec(`insert into auth.users(id) values('${user}'),('${other}'),('${stranger}');
    insert into public.households(id,invite_code) values('${household}','FIRST1'),('${otherHousehold}','OTHER2');
    insert into public.household_members(user_id,household_id) values('${user}','${household}'),('${other}','${household}'),('${stranger}','${otherHousehold}');
    grant usage on schema public to authenticated,anon;
    insert into auth.sessions(id,user_id) select id,id from auth.users;
    grant select on public.fridge_items,public.cart_items,public.food_stats,public.food_events,public.households,public.household_members to authenticated;`);
  async function rpc(kind,body,{id=randomUUID(),as=user,hh=household,role='authenticated'}={}){
    return db.transaction(async tx=>{
      await tx.exec(`set local role ${role}`);
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[as||'']);
      const r=await tx.query('select public.stock_mutate($1::uuid,$2::uuid,$3::text,$4::jsonb) as result',[id,hh,kind,JSON.stringify(body)]);
      return r.rows[0].result;
    });
  }
  async function add(qty=500,unit='г'){
    const id=randomUUID();
    await rpc('add_item',{name:'Тестовый продукт',emoji:'📦',qty_num:qty,unit,compartment:'fridge',location:'Средняя полка',expires_on:'2026-11-08',expiry_estimated:true},{id});
    return id;
  }
  async function cart(){
    const id=randomUUID();await rpc('add_cart',{name:'Покупка',qty_num:500,unit:'г'},{id});return id;
  }
  return {db,rpc,add,cart};
}
module.exports={createStockDb,user,other,stranger,household,otherHousehold};
