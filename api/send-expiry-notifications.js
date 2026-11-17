const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
const { isCronAuthorized } = require('./_lib/request-security');
const { sendTelegramMessage } = require('./_lib/telegram');
const { WEIGH_EVERY_DAYS, isoDate, daysBetween, addDaysIso, weighText, householdIdOf, lastWeighIn, expiryLadder, ladderText } = require('./_lib/fridge');

// Ежедневная рассылка (включается владельцем: SF_ENABLE_NOTIFICATIONS=1 и расписание в vercel.json).
// Лесенка напоминаний: за 3 дня («можно запланировать») и в последний день.
// service_role нужен, чтобы видеть подписки и продукты всех домохозяйств (RLS ограничивает своим аккаунтом).
// Каналы: Web Push (PWA) и Telegram. Нативное iOS-приложение убрано.

module.exports = async (req, res) => {
  if (!isCronAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (process.env.SF_ENABLE_NOTIFICATIONS !== '1') { res.status(503).json({ error: 'Раздел временно отключён до завершения проверки.' }); return; }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  webpush.setVapidDetails(
    'mailto:mr.taisarinov@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const today = isoDate();

  // Telegram подключён у части пользователей. Если таблицы ещё нет (миграция не выполнена),
  // просто работаем как раньше, только с Web Push.
  const tgStats = { expiry: 0, weigh: 0, unlinked: 0 };
  const linkByUser = {};
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const { data: links } = await sb.from('telegram_links').select('user_id, chat_id').not('chat_id', 'is', null);
    (links || []).forEach(l => { linkByUser[l.user_id] = l.chat_id; });
  }
  async function telegramTo(userId, text, kind) {
    const chatId = linkByUser[userId];
    if (!chatId) return;
    const r = await sendTelegramMessage(chatId, text);
    if (r.ok) tgStats[kind]++;
    else if (r.gone) { await sb.from('telegram_links').delete().eq('user_id', userId); delete linkByUser[userId]; tgStats.unlinked++; }
  }

  const { data: items, error: itemsErr } = await sb
    .from('fridge_items')
    .select('name, household_id, expires_on')
    .in('expires_on', [today, addDaysIso(today, 3)]);

  if (itemsErr) { res.status(500).json({ error: itemsErr.message }); return; }

  const byHousehold = expiryLadder(items, today);

  let sentWeb = 0, removedWeb = 0;
  for (const householdId of Object.keys(byHousehold)) {
    const { data: members } = await sb.from('household_members').select('user_id').eq('household_id', householdId);
    if (!members || members.length === 0) continue;
    const userIds = members.map(m => m.user_id);

    const body = ladderText(byHousehold[householdId]);
    if (!body) continue;

    for (const uid of userIds) await telegramTo(uid, '🧊 ' + body, 'expiry');

    const { data: subs } = await sb.from('push_subscriptions').select('*').in('user_id', userIds);
    if (subs && subs.length) {
      const payload = JSON.stringify({ title: 'Smart Fridge', body, url: '/?open=dinner' });
      for (const sub of subs) {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
          sentWeb++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await sb.from('push_subscriptions').delete().eq('id', sub.id);
            removedWeb++;
          }
        }
      }
    }

  }

  // Напоминание о взвешивании: на 2-й, 4-й, 6-й день без замера, а не каждый день подряд.
  const linkedUsers = Object.keys(linkByUser);
  const usersByHousehold = {};
  for (const uid of linkedUsers) {
    const hh = await householdIdOf(sb, uid);
    if (hh) (usersByHousehold[hh] ||= []).push(uid);
  }
  for (const hh of Object.keys(usersByHousehold)) {
    const w = await lastWeighIn(sb, hh);
    if (!w) continue;
    const since = daysBetween(w.date, today);
    if (since >= WEIGH_EVERY_DAYS && since % WEIGH_EVERY_DAYS === 0) {
      for (const uid of usersByHousehold[hh]) await telegramTo(uid, weighText(w, today), 'weigh');
    }
  }

  res.status(200).json({ sentWeb, removedWeb, households: Object.keys(byHousehold).length, telegram: tgStats });
};
