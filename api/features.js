// Which owner-only extras the signed-in account may see. UI gate only: personal data stays
// owner-scoped in the database and the AI route re-checks the allowlist on every request.
const { authenticatedUser } = require('./_lib/request-security');
const { featuresFor } = require('./_lib/owner-features');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }
  const auth = await authenticatedUser(req);
  if (!auth.user) { res.status(auth.status).json({ nutrition: false, ai: false }); return; }
  res.status(200).json(featuresFor(auth.user));
};
