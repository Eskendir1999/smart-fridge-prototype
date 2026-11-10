const fs = require('fs');
const path = require('path');

const srcDir = __dirname;
const distDir = path.join(__dirname, 'dist');

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const publicKey = (process.env.SUPABASE_ANON_KEY || '').trim();
if (!supabaseUrl || !publicKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
let parsedUrl;
try { parsedUrl = new URL(supabaseUrl); } catch { throw new Error('SUPABASE_URL must be a valid URL'); }
if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash
  || (parsedUrl.protocol !== 'https:' && !(parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)))) {
  throw new Error('SUPABASE_URL must use HTTPS (or local HTTP) without credentials or query');
}
let publicRole = false;
if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(publicKey)) publicRole = true;
else {
  try {
    const parts = publicKey.split('.');
    publicRole = parts.length === 3 && JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role === 'anon';
  } catch { /* Invalid public configuration is rejected below. */ }
}
if (!publicRole) throw new Error('SUPABASE_ANON_KEY must be an anon or publishable key; secret keys are forbidden in the client');
const botUsername = (process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
if (botUsername && !/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) throw new Error('Invalid TELEGRAM_BOT_USERNAME');
// Replace complete JS literals, not raw values inside quotes or HTML script tags.
const jsLiteral = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function injectPublicConfig(text) {
  return text.replaceAll("'__DINNER_ENABLED__'", jsLiteral(process.env.SF_ENABLE_DINNER === '1' ? '1' : '0'))
    .replaceAll("'__SUPABASE_URL__'", jsLiteral(supabaseUrl))
    .replaceAll("'__SUPABASE_ANON_KEY__'", jsLiteral(publicKey))
    .replaceAll("'__VAPID_PUBLIC_KEY__'", jsLiteral(process.env.VAPID_PUBLIC_KEY || ''))
    .replaceAll("'__TELEGRAM_ENABLED__'", jsLiteral(process.env.SF_ENABLE_TELEGRAM === '1' ? '1' : '0'))
    .replaceAll("'__TELEGRAM_BOT_USERNAME__'", jsLiteral(botUsername));
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const html = injectPublicConfig(fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8'));
fs.writeFileSync(path.join(distDir, 'index.html'), html);

fs.copyFileSync(path.join(srcDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
fs.copyFileSync(path.join(srcDir, 'sw.js'), path.join(distDir, 'sw.js'));
fs.copyFileSync(path.join(srcDir, 'privacy.html'), path.join(distDir, 'privacy.html'));
fs.copyFileSync(path.join(srcDir, 'support.html'), path.join(distDir, 'support.html'));
fs.copyFileSync(path.join(srcDir, 'widgets.html'), path.join(distDir, 'widgets.html'));

fs.mkdirSync(path.join(distDir, 'scriptable'), { recursive: true });
fs.copyFileSync(path.join(srcDir, 'scriptable', 'smart-fridge.js'), path.join(distDir, 'scriptable', 'smart-fridge.js'));
fs.cpSync(path.join(srcDir, 'icons'), path.join(distDir, 'icons'), { recursive: true });

fs.cpSync(path.join(srcDir, 'personal-data'), path.join(distDir, 'personal-data'), {recursive:true});
fs.cpSync(path.join(srcDir, 'dinner'), path.join(distDir, 'dinner'), { recursive: true });
fs.mkdirSync(path.join(distDir, 'ux'), { recursive: true });
fs.copyFileSync(path.join(srcDir, 'ux', 'core-flow.css'), path.join(distDir, 'ux', 'core-flow.css'));
fs.copyFileSync(path.join(srcDir, 'ux', 'core-flow.js'), path.join(distDir, 'ux', 'core-flow.js'));

console.log('Build complete ->', distDir);
