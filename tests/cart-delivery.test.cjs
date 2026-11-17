const test=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');const vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function grab(name){const i=html.indexOf('function '+name+'(');let d=0,j=html.indexOf('{',i);for(let k=j;k<html.length;k++){if(html[k]==='{')d++;else if(html[k]==='}'&&--d===0)return html.slice(i,k+1);}}
const ctx={};vm.runInNewContext("const ARBUZ_CITY='almaty';"+grab('arbuzSearchUrl')+grab('pluralRu')+';this.arbuzSearchUrl=arbuzSearchUrl;this.pluralRu=pluralRu;',ctx);
test('Arbuz link carries the product name in the search hash',()=>{
  const url=ctx.arbuzSearchUrl(' Молоко 3,2% ');
  assert.ok(url.startsWith('https://arbuz.kz/ru/almaty/search/show#/?'));
  const q=JSON.parse(decodeURIComponent(url.split('#/?')[1]));
  assert.deepEqual(JSON.parse(JSON.stringify(q)),[{component:'search',slug:'where[name][c]',value:'Молоко 3,2%'}]);
});
test('Russian plural forms for the shopping count',()=>{
  const f=['позиция','позиции','позиций'];
  for(const [n,w] of [[1,'позиция'],[2,'позиции'],[5,'позиций'],[11,'позиций'],[21,'позиция'],[22,'позиции'],[112,'позиций'],[0,'позиций']])assert.equal(ctx.pluralRu(n,f),w,String(n));
});
test('cart links open external stores safely',()=>{
  for(const m of html.matchAll(/<a [^>]*href="https:\/\/(magnum|small|arbuz)[^"]*"[^>]*>/g))assert.match(m[0],/rel="noopener"/);
  assert.match(html,/class="cart-arbuz" href="\$\{arbuzSearchUrl\(p\.name\)\}" target="_blank" rel="noopener"/);
});
