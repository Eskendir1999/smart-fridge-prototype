const webpush = require('web-push');
const apn = require('apn');
const { createClient } = require('@supabase/supabase-js');
const { sendTelegramMessage } = require('./_lib/telegram');
const { WEIGH_EVERY_DAYS, isoDate, daysBetween, addDaysIso, expiryText, weighText, householdIdOf, lastWeighIn } = require('./_lib/fridge');

// Запускается ежедневно по расписанию Vercel Cron (см. vercel.json).
// Использует service_role ключ, чтобы видеть подписки и продукты всех
// пользователей/домохозяйств (обходит RLS, который ограничивает доступ
// только своим аккаунтом).
//
// Шлёт два параллельных пути: Web Push (PWA/браузер, push_subscriptions)
// и APNs (нативное iOS-приложение, apns_tokens). APNs настраивается через
// APNS_KEY (содержимое .p8 ключа), APNS_KEY_ID, APNS_TEAM_ID — их пока нет
// (нужен Apple Developer Program), поэтому apnProvider остаётся null и
// эта часть просто пропускается, не ломая Web Push.
let apnProvider = null;
if (process.env.APNS_KEY && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID) {
  apnProvider = new apn.Provider({
    token: {
      key: process.env.APNS_KEY.replace(/\\n/g, '\n'),
      keyId: process.env.APNS_KEY_ID,
      teamId: process.env.APNS_TEAM_ID,
    },
    production: process.env.APNS_PRODUCTION === '1',
  });
}

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  webpush.setVapidDetails(
    'mailto:mr.taisarinov@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const today = isoDate();
  const targetDate = addDaysIso(today, 1);

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
    .select('name, household_id')
    .eq('expires_on', targetDate);

  if (itemsErr) { res.status(500).json({ error: itemsErr.message }); return; }

  const byHousehold = {};
  (items || []).forEach(i => { (byHousehold[i.household_id] ||= []).push(i.name); });

  let sentWeb = 0, removedWeb = 0, sentApns = 0, removedApns = 0;
  for (const householdId of Object.keys(byHousehold)) {
    const { data: members } = await sb.from('household_members').select('user_id').eq('household_id', householdId);
    if (!members || members.length === 0) continue;
    const userIds = members.map(m => m.user_id);

    const names = byHousehold[householdId];
    const body = names.length === 1
      ? `Завтра истекает срок: ${names[0]}`
      : `Завтра истекает срок у ${names.length} продуктов: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`;

    for (const uid of userIds) await telegramTo(uid, expiryText(names), 'expiry');

    const { data: subs } = await sb.from('push_subscriptions').select('*').in('user_id', userIds);
    if (subs && subs.length) {
      const payload = JSON.stringify({ title: 'Smart Fridge', body, url: '/' });
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

    if (apnProvider) {
      const { data: tokens } = await sb.from('apns_tokens').select('*').in('user_id', userIds);
      if (tokens && tokens.length) {
        const note = new apn.Notification();
        note.alert = { title: 'Smart Fridge', body };
        note.topic = process.env.APNS_BUNDLE_ID || 'com.florino.smartfridge';
        note.sound = 'default';
        const result = await apnProvider.send(note, tokens.map(t => t.token));
        sentApns += result.sent.length;
        for (const f of result.failed) {
          if (f.status === '410' || (f.response && f.response.reason === 'BadDeviceToken')) {
            await sb.from('apns_tokens').delete().eq('token', f.device);
            removedApns++;
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

  res.status(200).json({ sentWeb, removedWeb, sentApns, removedApns, households: Object.keys(byHousehold).length, telegram: tgStats });
};
