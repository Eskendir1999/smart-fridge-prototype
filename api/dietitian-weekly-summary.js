// Existing cron may call this route; no data is read, summarized or deleted.
const { isCronAuthorized } = require('./_lib/request-security');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isCronAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
  res.status(503).json({ enabled: false, reason: 'AI_NOT_ENABLED', summarized: 0 });
};
