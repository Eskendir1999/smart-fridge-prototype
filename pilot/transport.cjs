'use strict';
// Factory only: no route, listener, environment lookup or automatic collection.
function createAuthenticator(client){
 if(typeof client?.auth?.getUser!=='function')throw new Error('AUTH_ADAPTER_REQUIRED');
 return async token=>{
  try {
   if(typeof token!=='string'||!token||token.length>8192)throw new Error();
   const {data,error}=await client.auth.getUser(token);
   if(error||!data?.user?.id||data.user.is_anonymous===true)throw new Error();
   return {id:data.user.id};
  }catch{throw new Error('UNAUTHENTICATED');}
 };
}
function createHandler({collector,enabled=false,origin,allowRequest}={}){
 if(!collector||typeof collector.ingest!=='function'||typeof collector.confirmOperation!=='function'||typeof allowRequest!=='function')throw new Error('ADAPTER_REQUIRED');
 if(typeof origin!=='string'||new URL(origin).origin!==origin)throw new Error('ORIGIN_REQUIRED');
 const reply=(status,code,data)=>new Response(JSON.stringify(data??{error:code}),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});
 return async request=>{
  if(enabled!==true)return reply(503,'COLLECTION_DISABLED');
  if(request.method!=='POST')return reply(405,'METHOD_NOT_ALLOWED');
  const route=new URL(request.url).pathname;
  if(!['/pilot/events','/pilot/confirm'].includes(route))return reply(404,'NOT_FOUND');
  if(request.headers.get('origin')!==origin)return reply(403,'ORIGIN_DENIED');
  const authorization=request.headers.get('authorization')??'';
  const match=/^Bearer ([^\s]{1,8192})$/.exec(authorization);
  if(!match)return reply(401,'UNAUTHENTICATED');
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??'')||request.headers.has('content-encoding'))return reply(415,'UNSUPPORTED_MEDIA_TYPE');
  // Host adapter must enforce distributed limits using trusted connection metadata.
  try{if(await allowRequest(request)!==true)return reply(429,'RATE_LIMITED');}catch{return reply(503,'UNAVAILABLE');}
  const max=128*1024,declared=request.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>max))return reply(413,'BODY_TOO_LARGE');
  let input;
  try{
   const reader=request.body?.getReader();if(!reader)return reply(400,'INVALID_JSON');
   const chunks=[];let size=0;
   while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();return reply(413,'BODY_TOO_LARGE');}chunks.push(Buffer.from(value));}
   input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch{return reply(400,'INVALID_JSON');}
  try{
   const result=await collector[route==='/pilot/events'?'ingest':'confirmOperation'](match[1],input);
   return reply(200,null,result);
  }catch(error){
   const code=error?.code;
   if(code==='UNAUTHENTICATED')return reply(401,'UNAUTHENTICATED');
   if(['FORBIDDEN','NOT_ADMITTED'].includes(code))return reply(403,'NOT_ADMITTED');
   // No exception messages, payloads, identities or tokens in response/logs.
   if(typeof code==='string'&&/^[A-Z_]+$/.test(code))return reply(400,'EVENT_REJECTED');
   return reply(503,'UNAVAILABLE');
  }
 };
}
module.exports={createAuthenticator,createHandler};
