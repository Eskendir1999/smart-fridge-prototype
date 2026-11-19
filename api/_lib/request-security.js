const { createClient } = require('@supabase/supabase-js');
const { timingSafeEqual } = require('node:crypto');

function isCronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers?.authorization;
  if (typeof secret !== 'string' || !secret.trim() || typeof header !== 'string') return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function authenticatedUser(req) {
  const header = req.headers?.authorization;
  const match = typeof header === 'string' && header.match(/^Bearer (\S{1,8192})$/i);
  if (!match) return { status: 401 };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return { status: 503 };
  try {
    // Verify the supplied JWT with Auth, using only the public project key.
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(8000) }) },
    });
    const { data, error } = await client.auth.getUser(match[1]);
    if (error || !data?.user?.id) return { status: error?.status >= 500 ? 503 : 401 };
    if (data.user.is_anonymous) return { status: 403 };
    return { user: data.user };
  } catch {
    return { status: 503 };
  }
}

// Bounded per-process protection. This is NOT a distributed Vercel quota.
// A shared/global quota needs a separately configured durable store or WAF rule.
const buckets = new Map();
const WINDOW_MS = 60000;
const MAX_REQUESTS = 6;
const MAX_USERS = 5000;
function takeChatSlot(userId, now = Date.now()) {
  for (const [id, bucket] of buckets) {
    if (!bucket.inFlight && now >= bucket.resetAt) buckets.delete(id);
  }
  let bucket = buckets.get(userId);
  if (!bucket) {
    if (buckets.size >= MAX_USERS) return { allowed: false, retryAfter: 60 };
    bucket = { count: 0, resetAt: now + WINDOW_MS, inFlight: false };
    buckets.set(userId, bucket);
  } else if (now >= bucket.resetAt && !bucket.inFlight) {
    bucket.count = 0;
    bucket.resetAt = now + WINDOW_MS;
  }
  if (bucket.inFlight || bucket.count >= MAX_REQUESTS) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  bucket.count++;
  bucket.inFlight = true;
  return { allowed: true, release() { bucket.inFlight = false; } };
}

module.exports = { authenticatedUser, isCronAuthorized, takeChatSlot };
