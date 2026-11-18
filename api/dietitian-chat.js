// Прокси к Gemini API для чата с ИИ-диетологом. Не трогает базу — клиент
// сам сохраняет сообщения в dietitian_messages после получения ответа.
const { authenticatedUser, takeChatSlot } = require('./_lib/request-security');
const { featuresFor } = require('./_lib/owner-features');

// Ключ GEMINI_API_KEY (aistudio.google.com) хранится только в Vercel env. Бесплатный тариф:
// Google может использовать запросы для улучшения моделей — клиент предупреждает об этом
// до первого сообщения. Доступ только для почт из SF_NUTRITION_EMAILS. История не хранится.

const SYSTEM_PROMPT = `Ты — личный диетолог в приложении Smart Fridge. Общаешься тепло и по-человечески,
как заботливый тренер, а не бездушный ассистент: хвалишь за хорошие решения, но не льстишь,
и прямо (мягко, без занудства и без фальшивого ура-оптимизма) указываешь на плохие — объясняя, почему именно.

Пиши просто и понятно любому человеку, а не только тем, кто разбирается в нутрициологии —
без терминов и канцелярита; если термин всё же нужен, поясни его тут же на бытовом языке.
Числа (вес, калории, граммы) всегда пиши цифрами (76 кг, 2400 ккал, 250 г), а не прописью
("семьдесят шесть килограммов") — цифрами проще читать глазами, а голосовой движок всё равно
прочитает их вслух правильно.

Каждый ответ обязательно заканчивай одним конкретным, дельным советом на будущее — что
конкретно съесть, заменить или сделать в следующий раз, а не только оценкой того, что уже
произошло. Совет должен быть практичным и выполнимым, а не общими словами вроде "питайся
правильно".

Когда пользователь описывает, что съел или хочет съесть — оцени калорийность блюда и скажи,
сколько граммов/порций ему сейчас разумно съесть, учитывая его дневную норму (если она известна)
и то, что он, скорее всего, уже съел сегодня. Не советуй голодание и дефицит больше 500 ккал. Ты не
врач: при болезнях, лекарствах, тревожных симптомах или беременности советуй обратиться к врачу.

Отвечай по-русски, разговорно, без markdown-разметки (это озвучивается голосом), 2-5 предложений
на реплику — не читай лекцию, если не просят подробностей. Обходись без пафоса и дежурных фраз
("давай сделаем это красиво", "ты справишься") — конкретика звучит убедительнее лозунгов.`;

// Режим питания приходит от клиента — в промпт попадают только значения из белого списка,
// а не произвольный текст.
const EXCLUSION_NAMES = { dairy: 'молочное', egg: 'яйца', fish: 'рыба и икра', nuts: 'орехи', gluten: 'глютен' };
function dietModeLine(profile) {
  let line = '';
  if (profile.dietMode === 'breastfeeding') {
    const age = Number.isInteger(profile.babyAgeMonths) && profile.babyAgeMonths >= 0 && profile.babyAgeMonths <= 36
      ? ` Малышу ${profile.babyAgeMonths} мес.` : '';
    line += ` Пользователь — кормящая мама (грудное вскармливание).${age} Учитывай безопасность продуктов при ГВ:
без алкоголя, кофеин до 300 мг в день, рыба только с низким содержанием ртути (без крупного тунца, меч-рыбы, акулы),
не советуй голодание, разгрузочные дни и дефицит больше 300 ккал; не опускай калорийность ниже 1800 ккал.
Не предлагай исключать продукты "на всякий случай" — только если у малыша есть признаки аллергии и это согласовано с педиатром.
При тревожных симптомах у мамы или малыша советуй обратиться к врачу.`;
  }
  const ex = Array.isArray(profile.excludedFoods) ? profile.excludedFoods.filter(x => Object.hasOwn(EXCLUSION_NAMES, x)) : [];
  if (ex.length) line += ` Не предлагай блюда, в которых есть: ${ex.map(x => EXCLUSION_NAMES[x]).join(', ')}.`;
  return line;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  const auth = await authenticatedUser(req);
  if (!auth.user) {
    res.status(auth.status).json({ error: auth.status === 503 ? 'Проверка входа временно недоступна.' : 'Войдите в аккаунт, чтобы открыть диетолога.' });
    return;
  }
  if (!featuresFor(auth.user).nutrition) {
    res.status(403).json({ code: 'AI_NOT_ALLOWED', error: 'Диетолог доступен только владельцу.' });
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({ error: 'Диетолог временно недоступен: не настроен GEMINI_API_KEY.' });
    return;
  }

  const { message, history, profile: rawProfile } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) { res.status(400).json({ error: 'message required' }); return; }
  if (message.length > 2000 || JSON.stringify(req.body).length > 32000) {
    res.status(413).json({ error: 'Сообщение слишком длинное.' }); return;
  }
  // Never interpolate arbitrary client strings into the system instruction. Numbers are optional.
  let profile = null;
  if (rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile)) {
    const num = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 10) / 10 : null);
    profile = {
      weightKg: num(rawProfile.weightKg, 20, 400),
      targetWeightKg: num(rawProfile.targetWeightKg, 20, 400),
      kcalPerDay: Number.isFinite(rawProfile.kcalPerDay) && rawProfile.kcalPerDay >= 1200 && rawProfile.kcalPerDay <= 6000 ? Math.round(rawProfile.kcalPerDay) : null,
      dietMode: rawProfile.dietMode === 'breastfeeding' ? 'breastfeeding' : 'standard',
      babyAgeMonths: rawProfile.babyAgeMonths,
      excludedFoods: Array.isArray(rawProfile.excludedFoods) ? rawProfile.excludedFoods.filter(x => typeof x === 'string' && Object.hasOwn(EXCLUSION_NAMES, x)) : [],
    };
  }

  const profileLine = profile
    ? [profile.weightKg ? `Текущий вес: ${profile.weightKg} кг.` : '', profile.targetWeightKg ? `Цель: ${profile.targetWeightKg} кг.` : '', profile.kcalPerDay ? `Дневная норма по расчёту приложения: ${profile.kcalPerDay} ккал.` : ''].join(' ').trim() + dietModeLine(profile)
    : '';

  const contents = [];
  if (Array.isArray(history)) {
    for (const m of history.slice(-20)) {
      if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length <= 2000) {
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      }
    }
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const slot = takeChatSlot(auth.user.id);
  if (!slot.allowed) {
    res.setHeader('Retry-After', String(slot.retryAfter));
    res.status(429).json({ error: 'Слишком много запросов. Подождите минуту.' }); return;
  }
  try {
    // Model names change often: try the configured one, then stable aliases, only on 404.
    const models = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean))];
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT + (profileLine ? '\n\n' + profileLine : '') }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
    });
    let resp;
    for (const model of models) {
      resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body,
      });
      if (resp.status !== 404) break;
    }
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 429) { res.status(429).json({ error: 'Бесплатный лимит диетолога на сегодня исчерпан, попробуйте позже.' }); return; }
    if (!resp.ok) {
      res.status(502).json({ error: 'Ошибка у диетолога, попробуйте позже.' });
      return;
    }
    const reply = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if (!reply) { res.status(502).json({ error: 'Диетолог не ответил, попробуйте ещё раз.' }); return; }
    res.status(200).json({ reply });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось связаться с диетологом.' });
  } finally {
    slot.release();
  }
};
