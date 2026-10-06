// Общая логика для Telegram: даты, тексты сообщений и выборка данных домохозяйства.
// Даты считаем по часовому поясу пользователей, а не сервера (Vercel работает в UTC),
// иначе ночью «сегодня» и «завтра» съезжают на сутки.
const TZ = process.env.APP_TIMEZONE || 'Asia/Almaty';
const WEIGH_EVERY_DAYS = 2;
const STATUS_HORIZON_DAYS = 3;
const LIST_LIMIT = 10;

function isoDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function dayNumber(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
function daysBetween(fromIso, toIso) { return dayNumber(toIso) - dayNumber(fromIso); }
function addDaysIso(iso, n) { return new Date((dayNumber(iso) + n) * 86400000).toISOString().slice(0, 10); }

function fmtKg(v) {
  const r = Math.round(Number(v) * 10) / 10;
  const s = r.toFixed(1).replace('.', ',');
  return s.endsWith(',0') ? s.slice(0, -2) : s;
}
function ruDays(n) {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return 'дней';
  const m10 = n % 10;
  if (m10 === 1) return 'день';
  if (m10 >= 2 && m10 <= 4) return 'дня';
  return 'дней';
}
function dueLabel(days) {
  if (days < 0) return 'просрочено';
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  return `через ${days} ${ruDays(days)}`;
}
function bullets(names) {
  const shown = names.slice(0, LIST_LIMIT).map(n => `• ${n}`);
  if (names.length > LIST_LIMIT) shown.push(`…и ещё ${names.length - LIST_LIMIT}`);
  return shown.join('\n');
}

function expiryText(names) {
  return `🧊 Завтра истекает срок годности:\n${bullets(names)}`;
}
function weighText(w, today) {
  const ago = daysBetween(w.date, today);
  return `⚖️ Пора взвеситься, ${w.profileName}.\nПоследний замер: ${fmtKg(w.weight)} кг, ${ago} ${ruDays(ago)} назад.`;
}

async function householdIdOf(sb, userId) {
  const { data } = await sb.from('household_members').select('household_id').eq('user_id', userId).maybeSingle();
  return data ? data.household_id : null;
}

// Последний замер первого профиля семьи (так же, как в виджетах и приложении).
async function lastWeighIn(sb, householdId) {
  const { data: profiles } = await sb.from('family_profiles').select('id, name').eq('household_id', householdId).order('created_at', { ascending: true }).limit(1);
  const profile = profiles && profiles[0];
  if (!profile) return null;
  const { data: rows } = await sb.from('family_measurements').select('log_date, weight').eq('profile_id', profile.id).order('log_date', { ascending: false }).limit(1);
  const row = rows && rows[0];
  if (!row) return null;
  return { profileName: profile.name, weight: Number(row.weight), date: String(row.log_date).slice(0, 10) };
}

async function statusText(sb, householdId, today) {
  const horizon = addDaysIso(today, STATUS_HORIZON_DAYS);
  const [fridge, cart, weigh] = await Promise.all([
    sb.from('fridge_items').select('name, expires_on').eq('household_id', householdId).not('expires_on', 'is', null).lte('expires_on', horizon).order('expires_on', { ascending: true }).limit(30),
    sb.from('cart_items').select('name').eq('household_id', householdId).order('created_at', { ascending: true }).limit(30),
    lastWeighIn(sb, householdId),
  ]);

  const lines = ['🧊 Холодильник'];
  const expiring = fridge.data || [];
  if (expiring.length) {
    lines.push(`Скоро истекает (${STATUS_HORIZON_DAYS} ${ruDays(STATUS_HORIZON_DAYS)}):`);
    expiring.slice(0, LIST_LIMIT).forEach(i => lines.push(`• ${i.name} — ${dueLabel(daysBetween(today, String(i.expires_on).slice(0, 10)))}`));
    if (expiring.length > LIST_LIMIT) lines.push(`…и ещё ${expiring.length - LIST_LIMIT}`);
  } else {
    lines.push(`Ничего не истекает в ближайшие ${STATUS_HORIZON_DAYS} ${ruDays(STATUS_HORIZON_DAYS)} ✅`);
  }

  lines.push('');
  const cartNames = (cart.data || []).map(c => c.name);
  lines.push(cartNames.length ? `🛒 Купить (${cartNames.length}):\n${bullets(cartNames.slice(0, 5))}${cartNames.length > 5 ? `\n…и ещё ${cartNames.length - 5}` : ''}` : '🛒 Корзина пуста');

  lines.push('');
  if (weigh) {
    const ago = daysBetween(weigh.date, today);
    const next = WEIGH_EVERY_DAYS - ago;
    const when = next <= 0 ? 'пора взвеситься' : `следующий через ${next} ${ruDays(next)}`;
    lines.push(`⚖️ ${weigh.profileName}: ${fmtKg(weigh.weight)} кг (замер ${ago === 0 ? 'сегодня' : `${ago} ${ruDays(ago)} назад`}), ${when}`);
  } else {
    lines.push('⚖️ Вес: замеров пока нет');
  }
  return lines.join('\n');
}

module.exports = {
  WEIGH_EVERY_DAYS, isoDate, daysBetween, addDaysIso, fmtKg, ruDays, dueLabel,
  expiryText, weighText, householdIdOf, lastWeighIn, statusText,
};
