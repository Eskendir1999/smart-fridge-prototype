// Ежедневно утром (cron Vercel): напомнить в Telegram каждому владельцу профиля,
// что пора взвеситься (раз в 2 дня) или снять обхваты (раз в 5 дней).
// Какие профили «должны» и отметку об отправке база делает в одной транзакции,
// поэтому повторный запуск не пришлёт напоминание второй раз.
const { timingSafeEqual } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendTelegramMessage } = require('./_lib/telegram');
const { daysBetween, ruDays } = require('./_lib/fridge');

const clean = s => String(s ?? '').replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, ' ').slice(0, 60);
const since = (today, iso) => { const n = daysBetween(iso, today); return `${n} ${ruDays(n)}`; };

function reminderText(r){
  const name = clean(r.name);
  let what;
  if(!r.last_weight) what = 'сделать первый замер: вес и обхваты (шея, грудь, живот, бёдра)';
  else {
    const parts = [];
    if(r.weight_due) parts.push(`взвеситься (последний раз ${since(r.today, r.last_weight)} назад)`);
    if(r.full_due) parts.push(r.last_full ? `снять обхваты (${since(r.today, r.last_full)} назад)` : 'снять обхваты — их ещё не записывали');
    what = parts.join(' и ');
  }
  const id = r.profile_id;
  return {
    text: `⏰ ${name}, доброе утро! Пора ${what}.\nЗаписать можно прямо здесь — это 10 секунд.`,
    markup: { inline_keyboard: [
      [{ text: '⚖️ Записать вес', callback_data: 'wg:' + id }, { text: '📏 Вес и обхваты', callback_data: 'ms:' + id }],
      [{ text: '🔕 Не напоминать', callback_data: 'rm:' + id }],
    ] },
  };
}

function authorized(req){
  const secret = process.env.CRON_SECRET;
  const got = req.headers.authorization;
  const want = 'Bearer ' + secret;
  return !!secret && typeof got === 'string' && Buffer.byteLength(got) === Buffer.byteLength(want)
    && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

async function run(sb, send = sendTelegramMessage){
  const { data, error } = await sb.rpc('sf_telegram_claim_reminders');
  if(error) throw Error('telegram_database_unavailable');
  let sent = 0;
  for(const r of data || []){
    const m = reminderText(r);
    const res = await send(r.chat_id, m.text, m.markup);
    if(res && res.ok) sent++;
  }
  return { due: (data || []).length, sent };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if(!authorized(req)) return res.status(401).end();
  if(process.env.SF_ENABLE_TELEGRAM !== '1') return res.status(200).json({ skipped: true });
  try{
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return res.status(200).json(await run(sb));
  }catch{
    return res.status(503).end();
  }
};
module.exports.run = run;
module.exports.reminderText = reminderText;
