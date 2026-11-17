const test=require('node:test');const assert=require('node:assert/strict');
const Q=require('../quick-add/parse.js');
const pick=items=>items.map(({name,qty,unit})=>[name,qty,unit]);

test('shopping list lines with quantities and units',()=>{
  assert.deepEqual(pick(Q.parseList('Молоко 2 л\nхлеб\nЯйца x10\nпомидоры 0,5кг\n- Сыр — 300 г\n3 шт лимон')),[
    ['Молоко',2,'л'],['Хлеб',1,'шт'],['Яйца',10,'шт'],['Помидоры',0.5,'кг'],['Сыр',300,'г'],['Лимон',3,'шт']]);
});
test('our own shared list round-trips',()=>{
  const shared='Купить:\n• Хлеб — 1 шт\n• Масло сливочное — 1 шт\n• Молоко 3,2% — 1 л';
  assert.deepEqual(pick(Q.parseList(shared)),[['Хлеб',1,'шт'],['Масло сливочное',1,'шт'],['Молоко 3,2%',1,'л']]);
});
test('receipt lines: price kept, service lines skipped, weight goods in kg',()=>{
  const receipt=['ТОО "Магазин"','БИН 123456789012','1. Молоко Lactel 2,5% 1л','1 x 659,00 = 659,00','Молоко Lactel 2,5% 1 л 2 x 659,00 = 1 318,00','Огурцы 0,734 x 1290 = 946,86','ИТОГО: 2 264,86','Наличные','ФП 12345'].join('\n');
  const items=Q.parseList(receipt);
  const milk=items.find(i=>i.name.startsWith('Молоко Lactel 2,5% 1 л'));
  assert.equal(milk.qty,2);assert.equal(milk.unit,'шт');assert.equal(milk.price,659);
  const cucumbers=items.find(i=>i.name==='Огурцы');
  assert.deepEqual([cucumbers.qty,cucumbers.unit,cucumbers.price],[0.734,'кг',1290]);
  assert.ok(!items.some(i=>/итого|наличные|фп|бин/i.test(i.name)));
});
test('duplicates merge and junk is ignored',()=>{
  assert.deepEqual(pick(Q.parseList('Хлеб\nхлеб\n12345\n\n   \nhttps://example.com')),[['Хлеб',2,'шт']]);
});
test('only fiscal operator hosts count as receipt links',()=>{
  assert.equal(Q.receiptLink('http://consumer.oofd.kz?i=1&f=2&s=3&t=4'),'https://consumer.oofd.kz/?i=1&f=2&s=3&t=4');
  assert.equal(Q.receiptLink('https://ofd1.kz/t/?i=1'),'https://ofd1.kz/t/?i=1');
  for(const bad of ['https://consumer.oofd.kz.evil.test/x','javascript:alert(1)','https://user:pw@ofd1.kz/','4870000000000','https://example.com'])assert.equal(Q.receiptLink(bad),null,bad);
});
test('rough shelf life only for recognisable products',()=>{
  assert.equal(Q.estimateDays('Хлеб Бородинский'),4);assert.equal(Q.estimateDays('Айран 1 л'),7);assert.equal(Q.estimateDays('Курица охлаждённая'),2);
  assert.equal(Q.estimateDays('Рис басмати'),180);assert.equal(Q.estimateDays('Загадочный соус'),null);
});
