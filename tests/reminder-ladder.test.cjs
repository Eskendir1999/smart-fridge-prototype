const test=require('node:test');const assert=require('node:assert/strict');
const {expiryLadder,ladderText}=require('../api/_lib/fridge.js');
const today='2026-11-17';
test('ladder picks only D-0 and D-3, per household, without undated items',()=>{
  const items=[{name:'Молоко',household_id:'a',expires_on:'2026-11-17'},{name:'Творог',household_id:'a',expires_on:'2026-11-20'},
    {name:'Сыр',household_id:'a',expires_on:'2026-11-18'},{name:'Кефир',household_id:'b',expires_on:'2026-11-20T00:00:00Z'},
    {name:'Соус',household_id:'a',expires_on:null},{name:'Молоко',household_id:'a',expires_on:'2026-11-17'}];
  assert.deepEqual(JSON.parse(JSON.stringify(expiryLadder(items,today))),{a:{today:['Молоко'],soon:['Творог']},b:{today:[],soon:['Кефир']}});
});
test('ladder text is short and actionable',()=>{
  assert.equal(ladderText({today:['Молоко'],soon:['Творог']}),'Сегодня последний день: Молоко. Через 3 дня: Творог — можно запланировать ужин.');
  assert.equal(ladderText({today:['A','B','C','D','E'],soon:[]}),'Сегодня последний день: A, B, C и ещё 2.');
  assert.equal(ladderText({today:[],soon:[]}),'');
});
