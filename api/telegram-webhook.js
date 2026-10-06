// Telegram вызывает этот адрес на каждое сообщение боту Smart Fridge.
//   /start <код>  привязывает чат к аккаунту (код выдаёт кнопка «Подключить Telegram» в приложении)
//   /status       что скоро испортится, что купить и когда следующее взвешивание
//   /unlink       отключает уведомления
//
// Нужные переменные окружения: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (тот же секрет надо
// передать в setWebhook как secret_token), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Любой запрос без правильного секретного заголовка отбрасывается, поэтому подделать
// «сообщение от Telegram» и привязать чужой аккаунт нельзя.
const { createClient } = require('@supabase/supabase-js');
const { sendTelegramMessage } = require('./_lib/telegram');
const { isoDate, statusText, householdIdOf } = require('./_lib/fridge');

const HELP = 'Команды:\n/status — что скоро истекает и что купить\n/unlink — отключить уведомления\n\nПодключить аккаунт можно в приложении: Профиль → «Подключить Telegram».';

async function handleStart(sb, chatId, token) {
  if (!/^[0-9a-f]{32}$/.test(token || '')) {
    const { data: existing } = await sb.from('telegram_links').select('user_id').eq('chat_id', chatId).maybeSingle();
    await sendTelegramMessage(chatId, existing
      ? '✅ Этот чат уже подключён. Команда /status покажет сводку.'
      : 'Чтобы подключить аккаунт, откройте Smart Fridge → Профиль → «Подключить Telegram».');
    return;
  }

  const { data: link } = await sb.from('telegram_links').select('user_id')
    .eq('link_token', token).gt('link_token_expires_at', new Date().toISOString()).maybeSingle();
  if (!link) {
    await sendTelegramMessage(chatId, 'Ссылка устарела. Откройте «Подключить Telegram» в приложении ещё раз.');
    return;
  }

  // Один чат — один аккаунт: если он был привязан к другому, переносим сюда.
  await sb.from('telegram_links').delete().eq('chat_id', chatId).neq('user_id', link.user_id);
  const { error } = await sb.from('telegram_links').update({
    chat_id: chatId, link_token: null, link_token_expires_at: null, linked_at: new Date().toISOString(),
  }).eq('user_id', link.user_id);
  if (error) {
    await sendTelegramMessage(chatId, 'Не получилось подключить. Попробуйте ещё раз через минуту.');
    return;
  }
  await sendTelegramMessage(chatId, '✅ Telegram подключён. Сюда будут приходить напоминания о сроках годности и взвешивании.\n\n/status — сводка прямо сейчас\n/unlink — отключить');
}

async function handleStatus(sb, chatId) {
  const { data: link } = await sb.from('telegram_links').select('user_id').eq('chat_id', chatId).maybeSingle();
  if (!link) {
    await sendTelegramMessage(chatId, 'Аккаунт не подключён. Откройте Smart Fridge → Профиль → «Подключить Telegram».');
    return;
  }
  const householdId = await householdIdOf(sb, link.user_id);
  if (!householdId) {
    await sendTelegramMessage(chatId, 'Не нашёл ваш холодильник. Откройте приложение и войдите ещё раз.');
    return;
  }
  await sendTelegramMessage(chatId, await statusText(sb, householdId, isoDate()));
}

async function handleUnlink(sb, chatId) {
  await sb.from('telegram_links').delete().eq('chat_id', chatId);
  await sendTelegramMessage(chatId, 'Уведомления отключены. Подключить снова можно в приложении.');
}

async function handleUpdate(sb, update) {
  const message = update && update.message;
  const text = message && typeof message.text === 'string' ? message.text.trim() : '';
  const chat = message && message.chat;
  // Бот личный: в группах и каналах молчим, чтобы не светить чужим данные холодильника.
  if (!text || !chat || chat.type !== 'private') return;

  const m = text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/);
  const command = m ? m[1].toLowerCase() : null;
  const arg = m && m[2] ? m[2].trim() : '';

  if (command === 'start') return handleStart(sb, chat.id, arg);
  if (command === 'status') return handleStatus(sb, chat.id);
  if (command === 'unlink' || command === 'stop') return handleUnlink(sb, chat.id);
  await sendTelegramMessage(chat.id, HELP);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(200).end(); return; }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    res.status(401).end();
    return;
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    await handleUpdate(sb, req.body);
  } catch (e) {
    console.error('telegram-webhook failed', e && e.message);
  }
  // Всегда 200, иначе Telegram будет повторять то же сообщение.
  res.status(200).end();
};
module.exports.handleUpdate = handleUpdate;
