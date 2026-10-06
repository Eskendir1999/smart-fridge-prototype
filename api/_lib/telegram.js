// Отправка сообщений через Bot API. Токен читаем при каждом вызове, а не при загрузке модуля,
// чтобы окружение можно было подменять в тестах и чтобы отсутствие токена не ломало cron.
//
// Возвращает { ok, gone }. gone = true, если чат больше недоступен (пользователь заблокировал
// бота или удалил чат): такую привязку нужно убрать, иначе cron будет стучаться вечно.
async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, gone: false, reason: 'no-token' };

  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    return { ok: false, gone: false, reason: 'network' };
  }
  if (res.ok) return { ok: true, gone: false };

  const body = await res.json().catch(() => ({}));
  const description = String(body.description || '');
  const gone = res.status === 403 || /chat not found|user is deactivated/i.test(description);
  return { ok: false, gone, status: res.status };
}

module.exports = { sendTelegramMessage };
