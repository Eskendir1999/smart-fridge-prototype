// Прокси к Gemini API для чата с ИИ-диетологом. Не трогает базу — клиент
// сам сохраняет сообщения в dietitian_messages после получения ответа.
// Ключ GEMINI_API_KEY получается бесплатно на aistudio.google.com (без
// привязки карты, щедрый бесплатный лимит) и хранится только в Vercel env.

const SYSTEM_PROMPT = `Ты — личный диетолог в приложении Smart Fridge. Общаешься тепло и по-человечески,
как заботливый тренер, а не бездушный ассистент: хвалишь за хорошие решения, но не льстишь,
и прямо (мягко, без занудства) указываешь на плохие — объясняя, почему именно.

Когда пользователь описывает, что съел или хочет съесть — оцени калорийность блюда и скажи,
сколько граммов/порций ему сейчас разумно съесть, учитывая его дневную норму и то, сколько он,
скорее всего, уже съел сегодня (если это видно из разговора).

Отвечай по-русски, разговорно, без markdown-разметки (это озвучивается голосом), 2-5 предложений
на реплику — не читай лекцию, если не просят подробностей.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({ error: 'Диетолог временно недоступен: не настроен GEMINI_API_KEY.' });
    return;
  }

  const { message, history, profile } = req.body || {};
  if (!message || typeof message !== 'string') { res.status(400).json({ error: 'message required' }); return; }

  const profileLine = profile
    ? `Текущий вес: ${profile.weightKg} кг. Целевой вес: ${profile.targetWeightKg} кг. Дневная норма: ${profile.kcalPerDay} ккал.`
    : '';

  const contents = [];
  if (Array.isArray(history)) {
    for (const m of history.slice(-20)) {
      if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      }
    }
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT + (profileLine ? '\n\n' + profileLine : '') }] },
          contents,
          generationConfig: { temperature: 0.8, maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const data = await resp.json();
    if (!resp.ok) {
      res.status(502).json({ error: data.error?.message || 'Ошибка у диетолога, попробуйте позже.' });
      return;
    }
    const reply = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if (!reply) { res.status(502).json({ error: 'Диетолог не ответил, попробуйте ещё раз.' }); return; }
    res.status(200).json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось связаться с диетологом.' });
  }
};
