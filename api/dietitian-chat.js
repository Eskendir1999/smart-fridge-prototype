// Disabled until consent, provider eligibility and profile isolation are accepted.
const { authenticatedUser } = require('./_lib/request-security');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  const auth = await authenticatedUser(req);
  if (!auth.user) {
    res.status(auth.status).json({ error: 'Войдите в аккаунт. Проверка входа обязательна.' });
    return;
  }
  res.status(503).json({ code: 'AI_NOT_ENABLED', error: 'AI-помощник пока отключён: условия обработки данных и разделение профилей ещё не подтверждены.' });
};
