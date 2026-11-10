const { timingSafeEqual } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendTelegramMessage } = require('./_lib/telegram');
const { daysBetween, dueLabel } = require('./_lib/fridge');

const DINNER_URL = 'https://smart-fridge-prototype.vercel.app/?open=dinner';
const CONNECT = 'Откройте Smart Fridge → Профиль → «Подключить Telegram».';
const HELP = '/buy — что купить\n/expiry — что скоро истекает\n/dinner — открыть «Ужин»\n/status — общая сводка\n/unlink — отключить Telegram';
const ACTIONS = new Map([
  ['/buy', 'buy'], ['что купить', 'buy'], ['/expiry', 'expiry'], ['что скоро истекает', 'expiry'],
  ['/dinner', 'dinner'], ['ужин', 'dinner'], ['/status', 'status'],
  ['/unlink', 'unlink'], ['/stop', 'unlink'], ['/help', 'help'], ['/start', 'help'],
]);
const MENU = {
  keyboard: [[{ text: 'Что купить' }, { text: 'Что скоро истекает' }], [{ text: 'Ужин' }]],
  resize_keyboard: true,
};

function requestOf(update, now = Date.now()){
  const m = update?.message;
  if(!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || m?.chat?.type !== 'private'
    || !Number.isSafeInteger(m.chat.id) || m.chat.id <= 0 || m.from?.id !== m.chat.id || m.from.is_bot !== false
    || !Number.isSafeInteger(m.date) || m.date * 1000 < now - 86400000 || m.date * 1000 > now + 60000
    || typeof m.text !== 'string') return null;
  const text = m.text.trim();
  const link = text.match(/^\/start(?:@Smart_Fridge_T_bot)?\s+(\S+)$/i);
  if(link) return { p_update_id: update.update_id, p_chat_id: m.chat.id, p_action: 'link',
    p_token: /^[0-9a-f]{32}$/.test(link[1]) ? link[1] : null };
  const action = ACTIONS.get(text.toLowerCase().replace(/@smart_fridge_t_bot$/, ''));
  return action ? { p_update_id: update.update_id, p_chat_id: m.chat.id, p_action: action } : null;
}

function listText(rows, itemText, empty, title){
  if(!rows.length) return empty;
  const lines = rows.slice(0, 10).map(row => '• ' + itemText(row));
  if(rows.length > 10) lines.push('Остальное — в Smart Fridge.');
  return [title, ...lines].join('\n');
}

function itemName(name){
  return String(name).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 120);
}

function replyFor(action, data){
  switch(data.status){
    case 'duplicate': return null;
    case 'linked': return { text: 'Telegram подключён.\n\n' + HELP, markup: MENU };
    case 'invalid_link': return { text: 'Код недействителен или чат уже подключён. ' + CONNECT };
    case 'unlinked': return { text: 'Telegram отключён. ' + CONNECT, markup: { remove_keyboard: true } };
    case 'not_linked': return { text: 'Аккаунт не подключён. ' + CONNECT, markup: { remove_keyboard: true } };
    case 'no_household': return { text: 'Холодильник пока недоступен. Откройте Smart Fridge и войдите.' };
    case 'ok': break;
    default: throw Error('unexpected_telegram_state');
  }
  if(action === 'help') return { text: HELP, markup: MENU };
  if(action === 'dinner') return {
    text: 'Откройте «Ужин» в Smart Fridge. Если сессии нет, приложение попросит войти.',
    markup: { inline_keyboard: [[{ text: 'Открыть «Ужин»', url: DINNER_URL }]] },
  };
  const sections = [];
  if(action === 'buy' || action === 'status'){
    sections.push(listText(data.cart, row => itemName(row.name) + ' — ' + String(row.qty_num).replace('.', ',') + ' ' + itemName(row.unit),
      '🛒 Корзина пуста', '🛒 Что купить'));
  }
  if(action === 'expiry' || action === 'status'){
    sections.push(listText(data.expiry, row => itemName(row.name) + ' — ' +
      (row.expiry_estimated ? 'ориентировочно: ' : '') + dueLabel(daysBetween(data.today, row.expires_on)),
      '🧊 Ничего не истекает в ближайшие 3 дня', '🧊 Сроки годности'));
  }
  return { text: sections.join('\n\n'), markup: MENU };
}

async function handleUpdate(sb, update, send = sendTelegramMessage){
  const request = requestOf(update);
  if(!request) return;
  const { data, error } = await sb.rpc('sf_telegram_update', request);
  if(error) throw Error('telegram_database_unavailable');
  const reply = replyFor(request.p_action, data);
  if(reply) await send(request.p_chat_id, reply.text, reply.markup);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control','no-store');
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
    // A failed DB transaction can be retried. Once an update is committed,
    // never send it twice even if the Bot API response was lost.
    return res.status(503).end();
  }
};
module.exports.handleUpdate = handleUpdate;
