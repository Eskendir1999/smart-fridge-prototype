const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

// Запускается ежедневно по расписанию Vercel Cron (см. vercel.json).
// Использует service_role ключ, чтобы видеть подписки и продукты всех
// пользователей/домохозяйств (обходит RLS, который ограничивает доступ
// только своим аккаунтом).
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

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const y = tomorrow.getFullYear(), m = String(tomorrow.getMonth() + 1).padStart(2, '0'), d = String(tomorrow.getDate()).padStart(2, '0');
  const targetDate = `${y}-${m}-${d}`;

  const { data: items, error: itemsErr } = await sb
    .from('fridge_items')
    .select('name, household_id')
    .eq('expires_on', targetDate);

  if (itemsErr) { res.status(500).json({ error: itemsErr.message }); return; }
  if (!items || items.length === 0) { res.status(200).json({ sent: 0, reason: 'nothing expiring tomorrow' }); return; }

  const byHousehold = {};
  items.forEach(i => { (byHousehold[i.household_id] ||= []).push(i.name); });

  let sent = 0, removed = 0;
  for (const householdId of Object.keys(byHousehold)) {
    const { data: members } = await sb.from('household_members').select('user_id').eq('household_id', householdId);
    if (!members || members.length === 0) continue;
    const userIds = members.map(m => m.user_id);
    const { data: subs } = await sb.from('push_subscriptions').select('*').in('user_id', userIds);
    if (!subs || subs.length === 0) continue;

    const names = byHousehold[householdId];
    const body = names.length === 1
      ? `Завтра истекает срок: ${names[0]}`
      : `Завтра истекает срок у ${names.length} продуктов: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`;
    const payload = JSON.stringify({ title: 'Smart Fridge', body, url: '/' });

    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await sb.from('push_subscriptions').delete().eq('id', sub.id);
          removed++;
        }
      }
    }
  }

  res.status(200).json({ sent, removed, households: Object.keys(byHousehold).length });
};
