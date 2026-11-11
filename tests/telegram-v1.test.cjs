const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createStockDb, user, other, stranger, household, otherHousehold } = require('./helpers/stock-db.cjs');
const { handleUpdate } = require('../api/telegram-webhook');

test('Telegram link claims, permission checks, duplicate updates and snapshots are atomic and family-scoped', async () => {
  const { db, rpc } = await createStockDb();
  try{
    let updateId = 10;
    const as = (actor, sql, args = [], role = actor ? 'authenticated' : 'service_role', session = actor) =>
      db.transaction(async tx => {
        await tx.exec('set local role ' + role);
        if(actor) await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, session_id: session })]);
        return (await tx.query(sql,args)).rows;
      });
    const token = async actor => (await as(actor,'select generate_telegram_link_token() as token'))[0].token;
    const update = async (chat, action, code = null, id = ++updateId) =>
      (await as(null,'select sf_telegram_update($1,$2,$3,$4) as reply',[id,chat,action,code]))[0].reply;
    await assert.rejects(as(user,'select sf_telegram_update(1,123,\'buy\')'),{code:'42501'});
    await assert.rejects(as(null,'select sf_telegram_update(1,123,\'buy\')',[],'anon'),{code:'42501'});
    await assert.rejects(as(user,'select generate_telegram_link_token()',[],'authenticated',other),{code:'42501'});
    await rpc('add_cart',{name:'Shared A',qty_num:2,unit:'шт'},{as:user,hh:household});
    await rpc('add_cart',{name:'Shared B',qty_num:3,unit:'шт'},{as:stranger,hh:otherHousehold});
    await rpc('add_item',{name:'Expires A',qty_num:1,unit:'шт',compartment:'fridge',expires_on:'2026-01-01'},{as:user,hh:household});
    assert.equal((await update(101,'buy')).status,'not_linked');

    const obsolete = await token(user);
    const a = await token(user);
    assert.notEqual(a,obsolete);
    const stored=(await db.query('select link_token, link_token_expires_at > now() + interval \'4 minutes\' as fresh from telegram_links where user_id=$1',[user])).rows[0];
    assert.equal(stored.link_token,createHash('sha256').update(a).digest('hex'));
    assert.equal(stored.fresh,true);
    await assert.rejects(as(user,'select link_token from telegram_links'),{code:'42501'});
    assert.deepEqual(await as(other,'select chat_id from telegram_links where user_id=$1',[user]),[]);
    assert.equal((await update(101,'link',obsolete)).status,'invalid_link');
    assert.equal((await update(101,'link',a,1000)).status,'linked');
    assert.equal((await update(101,'link',a,1000)).status,'duplicate');
    assert.equal((await update(102,'link',a)).status,'invalid_link');
    await assert.rejects(token(user),{code:'22023'});

    const expired = await token(other);
    await db.query('update telegram_links set link_token_expires_at=now()-interval \'1 second\' where user_id=$1',[other]);
    assert.equal((await update(101,'link',expired)).status,'invalid_link');
    const peer = await token(other);
    assert.equal((await update(101,'link',peer)).status,'invalid_link');
    const b = await token(stranger);
    assert.equal((await update(102,'link',b)).status,'linked');
    assert.equal((await update(101,'buy')).cart[0].name,'Shared A');
    assert.equal((await update(102,'buy')).cart[0].name,'Shared B');
    const firstExpiry=await update(101,'expiry');
    assert.equal(firstExpiry.expiry[0].name,'Expires A');
    assert.deepEqual(firstExpiry.cart,[]);
    assert.deepEqual((await update(102,'expiry')).expiry,[]);
    assert.deepEqual((await update(101,'dinner')).cart,[]);
    await db.query('update household_members set household_id=$1 where user_id=$2',[otherHousehold,user]);
    assert.equal((await update(101,'buy')).cart[0].name,'Shared B');
    await as(user,'select unlink_telegram()');
    assert.equal((await update(101,'buy')).status,'not_linked');
    assert.equal((await update(102,'unlink',null,1001)).status,'unlinked');
    assert.equal((await update(102,'unlink',null,1001)).status,'duplicate');
    assert.equal((await update(102,'buy')).status,'not_linked');
  }finally{await db.close();}
});

test('webhook accepts private known commands only and passes no personal data in the Dinner URL', async () => {
  let reply = {status:'ok',today:'2026-11-10',cart:[{name:'Test item',qty_num:2,unit:'шт'}],expiry:[]};
  const calls=[],sent=[];
  const db={rpc:async(name,args)=>{calls.push({name,args});return {data:reply,error:null};}};
  const send=async(...args)=>sent.push(args);
  const message=(text, fields={})=>({update_id:9,message:{text,date:Math.floor(Date.now()/1000),chat:{id:101,type:'private'},from:{id:101,is_bot:false},...fields}});
  await handleUpdate(db,message('/buy',{chat:{id:101,type:'group'}}),send);
  await handleUpdate(db,message('/buy',{from:{id:102,is_bot:false}}),send);
  await handleUpdate(db,message('/buy',{date:1}),send);
  await handleUpdate(db,message('arbitrary text'),send);
  assert.deepEqual(calls,[]);
  await handleUpdate(db,message('Что купить'),send);
  assert.deepEqual(calls[0],{name:'sf_telegram_update',args:{p_update_id:9,p_chat_id:101,p_action:'buy'}});
  assert.match(sent[0][1],/Test item — 2 шт/);
  await handleUpdate(db,message('/dinner@Smart_Fridge_T_bot'),send);
  assert.deepEqual(sent[1][2].inline_keyboard,[[{text:'Открыть «Ужин»',url:'https://smart-fridge-prototype.vercel.app/?open=dinner'}]]);
  reply={status:'duplicate'};
  await handleUpdate(db,message('/buy'),send);
  assert.equal(sent.length,2);
});

test('linked Telegram users get a persistent menu and can return from the cooking choices', async () => {
  const chatId = 101;
  const token = 'a'.repeat(32);
  const sent = [];
  let updateId = 0;
  let linked = false;
  const db = { rpc: async (name, args) => {
    assert.equal(name, 'sf_telegram_update');
    assert.equal(args.p_chat_id, chatId);
    assert.equal(args.p_update_id, updateId);
    if(args.p_action === 'link'){
      assert.equal(args.p_token, token);
      linked = true;
      return { data: { status: 'linked' } };
    }
    if(!linked) return { data: { status: 'not_linked' } };
    if(args.p_action === 'unlink'){
      linked = false;
      return { data: { status: 'unlinked' } };
    }
    assert.ok(['help', 'buy', 'expiry', 'dinner'].includes(args.p_action));
    return { data: { status: 'ok', today: '2026-11-11', cart: [{ name: 'Лунные яблоки', qty_num: 3, unit: 'шт' }],
      expiry: [{ name: 'Облачный сыр', expires_on: '2026-11-12' }] } };
  } };
  async function press(text){
    await handleUpdate(db, { update_id: ++updateId, message: { text, date: Math.floor(Date.now()/1000),
      chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false } } },
    async (...args) => sent.push(args));
    assert.equal(sent.length, updateId);
    const [, reply, markup] = sent.at(-1);
    return { reply, markup };
  }
  function expectKeyboard(markup, buttons){
    assert.deepEqual(markup, { keyboard: buttons.map(text => [{ text }]), resize_keyboard: true, is_persistent: true });
  }

  const home = ['Что купить', 'Что скоро истекает', 'Что приготовить?'];
  assert.deepEqual((await press('Что приготовить?')).markup, { remove_keyboard: true });
  const welcome = await press('/start ' + token);
  assert.match(welcome.reply, /Smart Fridge подключён/);
  assert.doesNotMatch(welcome.reply, /\//);
  expectKeyboard(welcome.markup, home);
  assert.doesNotMatch((await press('/start')).reply, /\//);
  const shopping = await press(home[0]);
  assert.match(shopping.reply, /Лунные яблоки — 3 шт/);
  expectKeyboard(shopping.markup, home);
  assert.match((await press(home[1])).reply, /Облачный сыр — [Зз]автра/);
  const mealButtons = [['Завтрак', 'breakfast'], ['Обед', 'lunch'], ['Ужин', 'dinner']];
  expectKeyboard((await press(home[2])).markup, [...mealButtons.map(([label]) => label), 'В главное меню']);
  for(const [label, meal] of mealButtons){
    const choices = await press(label);
    assert.match(choices.reply, /Выберите кухню/);
    assert.deepEqual(choices.markup.inline_keyboard.map(([choice]) => choice.text), ['Без предпочтения', 'Домашняя', 'Японская']);
    for(const [index, cuisine] of ['any', 'home', 'japanese'].entries()){
      const url = new URL(choices.markup.inline_keyboard[index][0].url);
      assert.equal(url.origin + url.pathname, 'https://smart-fridge-prototype.vercel.app/');
      assert.deepEqual(Object.fromEntries(url.searchParams), { open: 'dinner', meal, cuisine, portions: '1' });
    }
  }
  expectKeyboard((await press('В главное меню')).markup, home);
  assert.match((await press('/help')).reply, /\/unlink/);
  assert.deepEqual((await press('/unlink')).markup, { remove_keyboard: true });
  assert.deepEqual((await press('Завтрак')).markup, { remove_keyboard: true });
});
