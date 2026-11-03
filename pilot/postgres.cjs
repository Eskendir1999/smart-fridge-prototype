'use strict';
// Small-pilot adapter. pool: node-postgres Pool; no connection is created here.
// One row lock serializes the pilot (five households); not a general analytics store.
function createTransaction({pool,readReceipt,verifyReadback,maxEvents=10000}={}){
 if(typeof pool?.connect!=='function'||typeof readReceipt!=='function'||typeof verifyReadback!=='function'||!Number.isSafeInteger(maxEvents)||maxEvents<1)throw Error('ADAPTER_REQUIRED');
 return async work=>{
  const db=await pool.connect();let locked=null,state=null,grants=null,releaseError;
  const key=(g,id)=>JSON.stringify([g.householdCode,id]);
  function scope(g){if(!locked||g.pilotId!==locked)throw Error('SCOPE_NOT_LOCKED');}
  try{
   await db.query('BEGIN');
   await db.query("SET LOCAL lock_timeout = '5s'");
   await db.query("SET LOCAL statement_timeout = '10s'");
   const tx={
    async authorize(userId,pilotId){
     if(locked)throw Error('SCOPE_ALREADY_LOCKED');
     const r=await db.query('SELECT grants, state FROM sf_pilot_private.pilots WHERE pilot_id=$1 FOR UPDATE',[pilotId]);
     if(!r.rows.length)return null;
     locked=pilotId;state=r.rows[0].state;grants=r.rows[0].grants;
     return Object.hasOwn(grants,userId)?structuredClone(grants[userId]):null;
    },
    async getStream(g,id){scope(g);return state.streams[key(g,id)];},
    async saveStream(g,id,v){scope(g);state.streams[key(g,id)]=v;},
    async getAttempt(g,id){scope(g);return state.attempts[key(g,id)];},
    async createAttempt(g,id,v){scope(g);const k=key(g,id);if(Object.hasOwn(state.attempts,k))throw Error('ATTEMPT_EXISTS');state.attempts[k]=v;},
    async findEvent(g,id){scope(g);return state.events.find(x=>x.event.household_code===g.householdCode&&x.event.event_id===id);},
    async nextSequence(g){scope(g);const k=key(g,'sequence');return state.sequences[k]=(state.sequences[k]??0)+1;},
    async appendEvent(g,record){scope(g);if(state.events.length>=maxEvents)throw Error('STORAGE_LIMIT');if(record.event.pilot_id!==locked||record.event.household_code!==g.householdCode)throw Error('STORAGE_SCOPE');state.events.push(record);},
    async readReceipt(g,id){scope(g);return readReceipt(db,g,id);},
    async verifyReadback(g,receipt){scope(g);return verifyReadback(db,g,receipt);}
   };
   const result=await work(tx);
   if(locked)await db.query('UPDATE sf_pilot_private.pilots SET state=$2::jsonb WHERE pilot_id=$1',[locked,JSON.stringify(state)]);
   await db.query('COMMIT');return result;
  }catch(error){try{await db.query('ROLLBACK');}catch{ /* release destroys uncertain connection below */ }
   // pg release(error) removes the connection rather than returning uncertain state.
   releaseError=error;throw error;
  }finally{db.release(releaseError);}
 };
}
module.exports={createTransaction};
