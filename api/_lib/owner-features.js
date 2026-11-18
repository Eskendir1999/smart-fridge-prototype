// Owner-only extras (nutrition screens, AI dietitian). The allowlist lives only in server env
// (SF_NUTRITION_EMAILS, comma separated), so addresses never appear in public HTML.
function allowedEmails() {
  return String(process.env.SF_NUTRITION_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function featuresFor(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  const nutrition = !!email && !user?.is_anonymous && allowedEmails().includes(email);
  return { nutrition, ai: nutrition && !!process.env.GEMINI_API_KEY };
}
module.exports = { featuresFor, allowedEmails };
