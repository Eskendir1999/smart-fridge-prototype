// Telegram-бот Smart Fridge. Меню: что купить, что истекает, что приготовить, диета.
// «Диета»: выбор профиля, меню на сегодня и неделю, вес и обхваты, прогресс,
// докупить к меню, напоминания о замерах, удаление профиля.
//
// Переменные окружения: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SF_ENABLE_TELEGRAM=1.
// Запрос без правильного секретного заголовка отбрасывается. Пользователь и дом всегда
// определяются в базе по chat_id привязанного чата, а не по данным из сообщения.
const { timingSafeEqual } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendTelegramMessage, answerCallbackQuery } = require('./_lib/telegram');
const { daysBetween, dueLabel, ruDays } = require('./_lib/fridge');
const D = require('../nutrition/core.js');

const APP_URL = 'https://smart-fridge-prototype.vercel.app/';
const CONNECT = 'Откройте Smart Fridge → Профиль → «Подключить Telegram».';
const BUY = 'Что купить';
const EXPIRY = 'Что скоро истекает';
const COOK = 'Что приготовить?';
const DIET = '🥗 Диета';
const HELP = '/buy — что купить\n/expiry — что скоро истекает\n/cook — что приготовить из того, что дома\n'
  + '/diet — диета: меню, вес, замеры\n/weight — записать вес\n/status — общая сводка\n/unlink — отключить Telegram';
const ACTIONS = new Map([
  ['/buy', 'buy'], [BUY.toLowerCase(), 'buy'], ['/expiry', 'expiry'], [EXPIRY.toLowerCase(), 'expiry'],
  ['/status', 'status'], ['/unlink', 'unlink'], ['/stop', 'unlink'], ['/help', 'help'], ['/start', 'start'],
  ['/cook', 'cook'], ['/dinner', 'cook'], [COOK.toLowerCase(), 'cook'],
  ['/diet', 'diet'], [DIET.toLowerCase(), 'diet'], ['диета', 'diet'], ['/weight', 'weight'],
  ['в главное меню', 'start'],
]);
const MENU = { keyboard: [[{ text: BUY }, { text: EXPIRY }], [{ text: COOK }, { text: DIET }]],
  resize_keyboard: true, is_persistent: true };
const CALLBACKS = new Set(['dp', 'dt', 'dw', 'wg', 'ms', 'pr', 'bw', 'ba', 'rm', 'dl', 'dx', 'dn', 'cx', 'pl']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GOALS = { lose: 'похудеть', maintain: 'держать вес', gain: 'набрать' };
const WEEKDAY = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

// ---------- разбор входящего обновления ----------
function requestOf(update, now = Date.now()){
  if(!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return null;
  const q = update.callback_query;
  if(q){
    const chat = q.message?.chat;
    if(chat?.type !== 'private' || !Number.isSafeInteger(chat.id) || chat.id <= 0 || q.from?.id !== chat.id
      || q.from.is_bot !== false || typeof q.id !== 'string' || typeof q.data !== 'string') return null;
    const m = q.data.match(/^([a-z]{2}):(.*)$/);
    if(!m || !CALLBACKS.has(m[1]) || (m[2] && !UUID.test(m[2]))) return null;
    return { update_id: update.update_id, chat_id: chat.id, action: 'callback', op: m[1], profile: m[2] || null, callback: q.id };
  }
  const m = update.message;
  if(m?.chat?.type !== 'private' || !Number.isSafeInteger(m.chat.id) || m.chat.id <= 0 || m.from?.id !== m.chat.id
    || m.from.is_bot !== false || !Number.isSafeInteger(m.date) || m.date * 1000 < now - 86400000
    || m.date * 1000 > now + 60000 || typeof m.text !== 'string') return null;
  const text = m.text.trim().slice(0, 300);
  const link = text.match(/^\/start(?:@Smart_Fridge_T_bot)?\s+(\S+)$/i);
  if(link) return { update_id: update.update_id, chat_id: m.chat.id, action: 'link',
    token: /^[0-9a-f]{32}$/.test(link[1]) ? link[1] : null };
  const key = text.toLowerCase().replace(/@smart_fridge_t_bot$/, '');
  return { update_id: update.update_id, chat_id: m.chat.id, action: ACTIONS.get(key) || 'text', text };
}

// ---------- форматирование ----------
const clean = s => String(s ?? '').replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, ' ').slice(0, 120);
const num = v => { const r = Math.round(Number(v) * 10) / 10; return String(r).replace('.', ','); };
const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + num(Math.abs(v));
function ago(today, iso){
  const n = daysBetween(iso, today);
  return n <= 0 ? 'сегодня' : n === 1 ? 'вчера' : `${n} ${ruDays(n)} назад`;
}
function weekday(today, offset){
  const [y, mo, d] = today.split('-').map(Number);
  return WEEKDAY[new Date(Date.UTC(y, mo - 1, d + offset)).getUTCDay()];
}
function listText(rows, itemText, empty, title){
  if(!rows.length) return empty;
  const lines = rows.slice(0, 10).map(row => '• ' + itemText(row));
  if(rows.length > 10) lines.push('Остальное — в Smart Fridge.');
  return [title, ...lines].join('\n');
}
const btn = (text, op, id) => ({ text, callback_data: op + ':' + (id || '') });
const weightNow = (p, ms) => ms.length ? Number(ms[0].weight) : Number(p.start_weight_kg);
const ratioOf = (p, ms) => Number(p.start_weight_kg) > 0 ? weightNow(p, ms) / Number(p.start_weight_kg) : 1;

function profileCard(data, many){
  const p = data.profile, ms = data.measurements, today = data.today;
  const w = weightNow(p, ms);
  const lines = ['🥗 ' + clean(p.name)];
  const kcal = D.kcal(p, w);
  lines.push(D.isBF(p) ? `Кормление грудью · ${kcal} ккал в день` : `Цель: ${GOALS[p.goal] || 'держать вес'} · ${kcal} ккал в день`);
  if(Number.isFinite(w)){
    let s = `⚖️ ${num(w)} кг`;
    if(ms.length && Number(p.start_weight_kg)) s += ` (${signed(w - Number(p.start_weight_kg))} от старта)`;
    if(Number(p.target_weight_kg)){
      const left = w - Number(p.target_weight_kg);
      s += Math.abs(left) < 0.1 ? ' · цель достигнута 🎉' : ` · до цели ${num(Math.abs(left))} кг`;
    }
    lines.push(s);
  }
  if(ms.length){
    lines.push(`📅 Последний замер: ${ago(today, ms[0].log_date)}`);
    const full = ms.find(m => m.neck > 0 && m.chest > 0 && m.belly > 0 && m.hips > 0);
    const wl = 2 - daysBetween(ms[0].log_date, today), fl = full ? 5 - daysBetween(full.log_date, today) : 0;
    lines.push('Взвешивание: ' + (wl <= 0 ? 'пора сегодня' : `через ${wl} ${ruDays(wl)}`)
      + ' · обхваты: ' + (fl <= 0 ? 'пора сегодня' : `через ${fl} ${ruDays(fl)}`));
  } else lines.push('📅 Замеров пока нет — запишите вес.');
  const id = p.id;
  const rows = [
    [btn('🍽 Меню на сегодня', 'dt', id), btn('📅 На неделю', 'dw', id)],
    [btn('⚖️ Записать вес', 'wg', id), btn('📏 Вес и обхваты', 'ms', id)],
    [btn('📈 Прогресс', 'pr', id), btn('🛒 Докупить к меню', 'bw', id)],
    [btn(data.reminders ? '🔔 Напоминания: вкл' : '🔕 Напоминания: выкл', 'rm', id), btn('🗑 Удалить профиль', 'dl', id)],
  ];
  if(many) rows.push([btn('👥 Другой профиль', 'pl')]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

function dishLine(slot, dish, ratio){
  const meta = D.SLOT_META[slot];
  const portion = D.portion(dish, ratio);
  return `${meta.icon} ${meta.name}: ${clean(dish.title)}${portion ? ' · ' + portion : ''}` + (dish.desc ? '\n   ' + clean(dish.desc) : '');
}

function todayMenu(data){
  const p = data.profile, day = D.week(p)[0], ratio = ratioOf(p, data.measurements);
  return { text: [`🍽 Меню на сегодня (${weekday(data.today, 0)}) — ${clean(p.name)}`,
    ...day.slots.map(x => dishLine(x.slot, x.dish, ratio))].join('\n'),
  markup: { inline_keyboard: [[btn('📅 На неделю', 'dw', p.id), btn('🛒 Докупить к меню', 'bw', p.id)], [btn('← Профиль', 'dp', p.id)]] } };
}

function weekMenuText(data){
  const p = data.profile;
  const lines = [`📅 Меню на неделю — ${clean(p.name)}`];
  D.week(p).forEach(({ d, slots }, i) => {
    lines.push('', `${weekday(data.today, i)}${i === 0 ? ' (сегодня)' : ''}`);
    slots.forEach(({ slot, dish }) => lines.push(`${D.SLOT_META[slot].icon} ${clean(dish.title)}`));
  });
  lines.push('', 'Заменить блюдо можно в приложении: Диета → Меню.');
  return { text: lines.join('\n'), markup: { inline_keyboard: [
    [btn('🛒 Докупить к меню', 'bw', p.id), btn('← Профиль', 'dp', p.id)],
    [{ text: 'Открыть меню в приложении', url: APP_URL }]] } };
}

function progressText(data){
  const p = data.profile, ms = data.measurements, today = data.today;
  const lines = [`📈 Прогресс — ${clean(p.name)}`];
  if(!ms.length) return { text: lines.concat('Замеров пока нет. Запишите вес, и здесь появится динамика.').join('\n'),
    markup: { inline_keyboard: [[btn('⚖️ Записать вес', 'wg', p.id), btn('← Профиль', 'dp', p.id)]] } };
  const start = Number(p.start_weight_kg), target = Number(p.target_weight_kg), w = Number(ms[0].weight);
  if(start) lines.push(`Старт ${num(start)} → сейчас ${num(w)} кг (${signed(w - start)})` + (target ? ` · цель ${num(target)}` : ''));
  if(start && target && start !== target){
    const pct = Math.max(0, Math.min(100, Math.round((start - w) / (start - target) * 100)));
    const filled = Math.round(pct / 10);
    lines.push('▓'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}% пути`);
  }
  const old = ms.find(m => daysBetween(m.log_date, today) >= 14) || ms[ms.length - 1];
  const span = daysBetween(old.log_date, ms[0].log_date);
  if(span >= 7){
    const perWeek = (w - Number(old.weight)) / span * 7;
    lines.push(`Темп: ${signed(perWeek)} кг в неделю (за ${span} ${ruDays(span)})`);
  }
  lines.push('', 'Последние взвешивания:');
  ms.slice(0, 6).forEach((m, i) => {
    const prev = ms[i + 1];
    lines.push(`• ${m.log_date.slice(8, 10)}.${m.log_date.slice(5, 7)} — ${num(m.weight)} кг` + (prev ? ` (${signed(Number(m.weight) - Number(prev.weight))})` : ''));
  });
  const full = ms.filter(m => m.neck > 0 && m.chest > 0 && m.belly > 0 && m.hips > 0);
  if(full.length){
    const a = full[0], b = full[full.length - 1];
    const part = (label, k) => `${label} ${num(a[k])}` + (full.length > 1 ? ` (${signed(Number(a[k]) - Number(b[k]))})` : '');
    lines.push('', `Обхваты ${ago(today, a.log_date)}, см:`, [part('шея', 'neck'), part('грудь', 'chest'), part('живот', 'belly'), part('бёдра', 'hips')].join(' · '));
    if(full.length > 1) lines.push(`В скобках — изменение с ${b.log_date.slice(8, 10)}.${b.log_date.slice(5, 7)}.`);
  }
  return { text: lines.join('\n'), markup: { inline_keyboard: [[btn('⚖️ Записать вес', 'wg', p.id), btn('← Профиль', 'dp', p.id)]] } };
}

function cookText(inventory){
  const list = D.cookable(inventory).slice(0, 6);
  if(!list.length) return { text: 'Из того, что дома, блюд из программы пока не собрать. Добавьте продукты в Smart Fridge.', markup: MENU };
  const lines = ['🍳 Можно приготовить из того, что дома:'];
  list.forEach(x => {
    lines.push('', `${D.SLOT_META[x.dish.slot].icon} ${clean(x.dish.title)}`, '   есть: ' + x.have.slice(0, 4).map(clean).join(', ')
      + (x.lack.length ? '\n   докупить: ' + x.lack.slice(0, 3).map(clean).join(', ') : ''));
  });
  return { text: lines.join('\n'), markup: { inline_keyboard: [[{ text: 'Рецепты в приложении', url: APP_URL }]] } };
}

// Вес — одно число. Обхваты — до 5 чисел: вес, шея, грудь, живот, бёдра; «-» пропускает.
function parseMeasurement(text, awaiting){
  const parts = String(text).replace(/кг|см/gi, ' ').trim().split(/[\s;\/]+/).filter(Boolean);
  if(!parts.length || parts.length > (awaiting === 'weight' ? 1 : 5)) return null;
  const keys = ['weight', 'neck', 'chest', 'belly', 'hips'];
  const out = {};
  for(let i = 0; i < parts.length; i++){
    if(parts[i] === '-' && i > 0) continue;
    if(!/^\d{1,3}(?:[.,]\d{1,2})?$/.test(parts[i])) return null;
    out[keys[i]] = Number(parts[i].replace(',', '.'));
  }
  if(!(out.weight >= 2 && out.weight <= 400)) return null;
  if(keys.slice(1).some(k => k in out && !(out[k] >= 10 && out[k] <= 300))) return null;
  return out;
}

function missingFor(data){
  return D.missing(data.profile, data.inventory.map(String));
}

// ---------- обработка ----------
async function diet(sb, chatId, action, profile, args){
  const { data, error } = await sb.rpc('sf_telegram_diet', { p_chat_id: chatId, p_action: action,
    p_profile: profile, p_args: args || {} });
  if(error) throw Error('telegram_database_unavailable');
  return data;
}

async function openDiet(sb, chatId){
  const list = await diet(sb, chatId, 'profiles');
  if(list.status !== 'ok') return statusReply(list);
  if(!list.profiles.length) return { text: 'Профиля для диеты пока нет. Создайте его в приложении: «Диета» → «Добавить профиль».',
    markup: { inline_keyboard: [[{ text: 'Открыть Smart Fridge', url: APP_URL }]] } };
  if(list.profiles.length === 1) return card(sb, chatId, list.profiles[0].id, false);
  return { text: 'Чей профиль открыть?', markup: { inline_keyboard: list.profiles.map(p => [btn('👤 ' + clean(p.name), 'dp', p.id)]) } };
}

async function card(sb, chatId, id, many){
  const data = await diet(sb, chatId, 'profile', id);
  if(data.status !== 'ok') return statusReply(data);
  if(many == null) many = (await diet(sb, chatId, 'profiles')).profiles?.length > 1;
  return profileCard(data, many);
}

function statusReply(data){
  if(data.status === 'not_linked') return { text: 'Аккаунт не подключён. ' + CONNECT, markup: { remove_keyboard: true } };
  if(data.status === 'no_household') return { text: 'Холодильник пока недоступен. Откройте Smart Fridge и войдите.' };
  return { text: 'Этого профиля больше нет. Нажмите «🥗 Диета», чтобы выбрать другой.', markup: MENU };
}

async function askMeasurement(sb, chatId, id, awaiting){
  const data = await diet(sb, chatId, 'await', id, { awaiting });
  if(data.status !== 'ok') return statusReply(data);
  const last = data.last;
  const cancel = { inline_keyboard: [[btn('Отмена', 'cx')]] };
  if(awaiting === 'weight') return { markup: cancel, text: `⚖️ ${clean(data.name)}: сколько весите сегодня? Пришлите число, например 72,4.`
    + (last ? `\nПрошлый раз: ${num(last.weight)} кг.` : '') };
  const prev = last && last.neck ? `\nПрошлый раз: ${[last.weight, last.neck, last.chest, last.belly, last.hips].map(v => v == null ? '-' : num(v)).join(' ')}` : '';
  return { markup: cancel, text: `📏 ${clean(data.name)}: пришлите числа через пробел —\nвес, шея, грудь, живот, бёдра (см).\nНапример: 72,4 34 92 80 98`
    + '\nЕсли что-то не мерили, поставьте «-».' + prev };
}

async function saveMeasurement(sb, chatId, state, text){
  const values = parseMeasurement(text, state.awaiting);
  if(!values) return { text: state.awaiting === 'weight'
    ? 'Не понял число. Пришлите вес, например 72,4.'
    : 'Не понял. Пришлите до 5 чисел: вес, шея, грудь, живот, бёдра. Например: 72,4 34 92 80 98',
    markup: { inline_keyboard: [[btn('Отмена', 'cx')]] } };
  const data = await diet(sb, chatId, 'save', state.profile_id, values);
  if(data.status === 'invalid_measurement') return { text: 'Похоже на опечатку: значения вне допустимого диапазона. Попробуйте ещё раз.' };
  if(data.status !== 'saved') return statusReply(data);
  const ms = data.measurements, prev = ms.find(m => m.log_date !== data.today);
  const p = data.profile;
  let msg = `✅ Записал за сегодня: ${num(values.weight)} кг`;
  if(prev) msg += ` (${signed(values.weight - Number(prev.weight))} за ${daysBetween(prev.log_date, data.today)} ${ruDays(daysBetween(prev.log_date, data.today))})`;
  if(values.neck || values.chest || values.belly || values.hips) msg += '\nОбхваты сохранены.';
  if(Number(p.target_weight_kg)){
    const left = values.weight - Number(p.target_weight_kg);
    msg += Math.abs(left) < 0.1 ? '\nЦель достигнута 🎉' : `\nДо цели ${num(Math.abs(left))} кг.`;
  }
  msg += `\nНорма на сегодня: ${D.kcal(p, values.weight)} ккал.`;
  return { text: msg, markup: { inline_keyboard: [[btn('📈 Прогресс', 'pr', p.id), btn('← Профиль', 'dp', p.id)]] } };
}

async function onCallback(sb, r){
  const id = r.profile;
  switch(r.op){
    case 'pl': return openDiet(sb, r.chat_id);
    case 'dp': return card(sb, r.chat_id, id);
    case 'cx': await diet(sb, r.chat_id, 'cancel'); return { text: 'Отменено.', markup: MENU };
    case 'wg': return askMeasurement(sb, r.chat_id, id, 'weight');
    case 'ms': return askMeasurement(sb, r.chat_id, id, 'measure');
    case 'rm': {
      const data = await diet(sb, r.chat_id, 'reminders', id);
      if(data.status !== 'ok') return statusReply(data);
      return { text: data.reminders
        ? `🔔 ${clean(data.name)}: буду напоминать взвеситься (раз в 2 дня) и снять обхваты (раз в 5 дней), утром.`
        : `🔕 ${clean(data.name)}: напоминания о замерах выключены. Включить можно в карточке профиля.`,
      markup: { inline_keyboard: [[btn('← Профиль', 'dp', id)]] } };
    }
    case 'dn': return { text: 'Профиль не удалён.', markup: { inline_keyboard: [[btn('← Профиль', 'dp', id)]] } };
    case 'dx': {
      const data = await diet(sb, r.chat_id, 'delete', id);
      if(data.status !== 'deleted') return statusReply(data);
      return { text: `🗑 Профиль «${clean(data.name)}» удалён` + (data.measurements ? ` вместе с замерами (${data.measurements}).` : '.')
        + '\nПродукты, корзина и аккаунт остались.', markup: MENU };
    }
  }
  const data = await diet(sb, r.chat_id, 'profile', id);
  if(data.status !== 'ok') return statusReply(data);
  const name = clean(data.profile.name);
  if(r.op === 'dt') return todayMenu(data);
  if(r.op === 'dw') return weekMenuText(data);
  if(r.op === 'pr') return progressText(data);
  if(r.op === 'dl') return {
    text: `Удалить профиль «${name}»?\n\nУдалятся: профиль, цель, меню и все замеры` + (data.measurements.length ? ` (${data.measurements.length})` : '')
      + '.\nОстанутся: продукты, корзина, аккаунт и другие профили.\nОтменить удаление нельзя.',
    markup: { inline_keyboard: [[btn('Да, удалить', 'dx', id), btn('Не удалять', 'dn', id)]] } };
  const missing = missingFor(data);
  if(r.op === 'bw') return missing.length
    ? { text: [`🛒 Для меню на неделю (${name}) дома не хватает:`, ...missing.slice(0, 25).map(x => '• ' + clean(x.name))].join('\n'),
      markup: { inline_keyboard: [[btn(`Добавить в корзину (${Math.min(missing.length, 25)})`, 'ba', id)], [btn('← Профиль', 'dp', id)]] } }
    : { text: `✅ Для меню на неделю (${name}) всё есть дома.`, markup: { inline_keyboard: [[btn('← Профиль', 'dp', id)]] } };
  // ba
  if(!missing.length) return { text: 'Всё уже есть дома — добавлять нечего.' };
  const res = await diet(sb, r.chat_id, 'cart_add', id, { items: missing.slice(0, 25).map(x => ({ name: x.name })) });
  if(res.status !== 'ok') return statusReply(res);
  const asked = Math.min(missing.length, 25);
  return { text: !res.added ? 'Всё это уже есть в корзине.'
    : `🛒 Добавил в корзину: ${res.added}.` + (res.added < asked ? ' Остальное уже было в списке.' : '')
    , markup: MENU };
}

async function handleUpdate(sb, update, send = sendTelegramMessage, answer = answerCallbackQuery){
  const r = requestOf(update);
  if(!r) return;
  if(r.callback) await answer(r.callback).catch(() => {});
  // Сначала — защита от повторной доставки и проверка привязки (одна транзакция в базе).
  const base = r.action === 'link' ? 'link' : r.action === 'unlink' ? 'unlink'
    : ['buy', 'expiry', 'status'].includes(r.action) ? r.action : 'help';
  const { data, error } = await sb.rpc('sf_telegram_update', { p_update_id: r.update_id, p_chat_id: r.chat_id,
    p_action: base, p_token: r.token ?? null });
  if(error) throw Error('telegram_database_unavailable');
  let reply;
  switch(data.status){
    case 'duplicate': return;
    case 'linked': reply = { text: 'Smart Fridge подключён.\n\nЧто хотите посмотреть?', markup: MENU }; break;
    case 'invalid_link': reply = { text: 'Код недействителен или чат уже подключён. ' + CONNECT }; break;
    case 'unlinked': reply = { text: 'Telegram отключён. ' + CONNECT, markup: { remove_keyboard: true } }; break;
    case 'not_linked': reply = { text: 'Аккаунт не подключён. ' + CONNECT, markup: { remove_keyboard: true } }; break;
    case 'no_household': reply = { text: 'Холодильник пока недоступен. Откройте Smart Fridge и войдите.' }; break;
    case 'ok': break;
    default: throw Error('unexpected_telegram_state');
  }
  if(!reply){
    if(r.action === 'callback') reply = await onCallback(sb, r);
    else if(r.action === 'start') reply = { text: 'Что хотите посмотреть?', markup: MENU };
    else if(r.action === 'help') reply = { text: HELP, markup: MENU };
    else if(r.action === 'diet') { await diet(sb, r.chat_id, 'cancel'); reply = await openDiet(sb, r.chat_id); }
    else if(r.action === 'cook'){
      const inv = await diet(sb, r.chat_id, 'cook');
      reply = inv.status === 'ok' ? cookText(inv.inventory.map(String)) : statusReply(inv);
    } else if(r.action === 'weight'){
      const list = await diet(sb, r.chat_id, 'profiles');
      if(list.status !== 'ok') reply = statusReply(list);
      else if(list.profiles.length === 1) reply = await askMeasurement(sb, r.chat_id, list.profiles[0].id, 'weight');
      else reply = list.profiles.length
        ? { text: 'Чей вес записать?', markup: { inline_keyboard: list.profiles.map(p => [btn('⚖️ ' + clean(p.name), 'wg', p.id)]) } }
        : await openDiet(sb, r.chat_id);
    } else if(r.action === 'text'){
      const state = await diet(sb, r.chat_id, 'state');
      reply = state.status === 'ok' && state.awaiting ? await saveMeasurement(sb, r.chat_id, state, r.text)
        : state.status === 'ok' ? { text: 'Выберите раздел в меню ниже или /help.', markup: MENU } : statusReply(state);
    } else {
      const sections = [];
      if(r.action === 'buy' || r.action === 'status') sections.push(listText(data.cart,
        row => clean(row.name) + ' — ' + String(row.qty_num).replace('.', ',') + ' ' + clean(row.unit), '🛒 Корзина пуста', '🛒 Что купить'));
      if(r.action === 'expiry' || r.action === 'status') sections.push(listText(data.expiry,
        row => clean(row.name) + ' — ' + (row.expiry_estimated ? 'ориентировочно: ' : '') + dueLabel(daysBetween(data.today, row.expires_on)),
        '🧊 Ничего не истекает в ближайшие 3 дня', '🧊 Сроки годности'));
      reply = { text: sections.join('\n\n'), markup: MENU };
    }
  }
  if(reply) await send(r.chat_id, reply.text, reply.markup);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if(req.method !== 'POST') return res.status(405).end();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const provided = req.headers['x-telegram-bot-api-secret-token'];
  if(!secret || typeof provided !== 'string' || Buffer.byteLength(provided) !== Buffer.byteLength(secret)
    || !timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) return res.status(401).end();
  if(process.env.SF_ENABLE_TELEGRAM !== '1') return res.status(200).end();
  try{
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) }) },
    });
    await handleUpdate(sb, req.body);
    return res.status(200).end();
  }catch{
    // Ошибку базы Telegram повторит. Уже обработанное обновление дважды не отправится.
    return res.status(503).end();
  }
};
module.exports.handleUpdate = handleUpdate;
module.exports.parseMeasurement = parseMeasurement;
