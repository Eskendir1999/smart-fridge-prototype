// Запускается раз в неделю по расписанию Vercel Cron (см. vercel.json).
// Для каждого пользователя с сообщениями диетологу старше 7 дней: просит
// Gemini сжать их в короткую выжимку, сохраняет её в dietitian_summaries,
// затем удаляет исходные сообщения — история чата не растёт бесконечно,
// а прошлое остаётся доступно одной строкой на неделю.
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!process.env.GEMINI_API_KEY) { res.status(503).json({ error: 'GEMINI_API_KEY not set' }); return; }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffIso = cutoff.toISOString();

  const { data: messages, error } = await sb
    .from('dietitian_messages')
    .select('id, user_id, role, content, created_at')
    .lt('created_at', cutoffIso)
    .order('created_at', { ascending: true });

  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!messages || messages.length === 0) { res.status(200).json({ summarized: 0 }); return; }

  const byUser = {};
  messages.forEach(m => { (byUser[m.user_id] ||= []).push(m); });

  let summarized = 0, failed = 0;
  for (const userId of Object.keys(byUser)) {
    const userMessages = byUser[userId];
    const transcript = userMessages
      .map(m => (m.role === 'user' ? 'Пользователь: ' : 'Диетолог: ') + m.content)
      .join('\n');
    const weekStart = userMessages[0].created_at.slice(0, 10);

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: 'Сожми переписку пользователя с диетологом за неделю в 2-4 предложения по-русски: о чём говорили, какие решения/советы дал диетолог, как менялся вес/поведение, если упоминалось. Без markdown, только текст.' }],
            },
            contents: [{ role: 'user', parts: [{ text: transcript }] }],
            generationConfig: { temperature: 0.5, maxOutputTokens: 200 },
          }),
        }
      );
      const data = await resp.json();
      const summary = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
      if (!resp.ok || !summary) { failed++; continue; }

      await sb.from('dietitian_summaries').insert({ user_id: userId, week_start: weekStart, summary });
      await sb.from('dietitian_messages').delete().in('id', userMessages.map(m => m.id));
      summarized++;
    } catch {
      failed++;
    }
  }

  res.status(200).json({ summarized, failed, users: Object.keys(byUser).length });
};
