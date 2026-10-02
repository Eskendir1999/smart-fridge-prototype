const fs = require('fs');
const path = require('path');

const srcDir = __dirname;
const distDir = path.join(__dirname, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

let html = fs.readFileSync(path.join(srcDir, 'index.html'), 'utf8');
html = html.replaceAll('__SUPABASE_URL__', process.env.SUPABASE_URL || '');
html = html.replaceAll('__SUPABASE_ANON_KEY__', process.env.SUPABASE_ANON_KEY || '');
html = html.replaceAll('__VAPID_PUBLIC_KEY__', process.env.VAPID_PUBLIC_KEY || '');
fs.writeFileSync(path.join(distDir, 'index.html'), html);

fs.copyFileSync(path.join(srcDir, 'manifest.json'), path.join(distDir, 'manifest.json'));
fs.copyFileSync(path.join(srcDir, 'sw.js'), path.join(distDir, 'sw.js'));
fs.copyFileSync(path.join(srcDir, 'privacy.html'), path.join(distDir, 'privacy.html'));
fs.copyFileSync(path.join(srcDir, 'support.html'), path.join(distDir, 'support.html'));
fs.copyFileSync(path.join(srcDir, 'widgets.html'), path.join(distDir, 'widgets.html'));

// Скрипт для Scriptable получает те же публичные ключи Supabase, что и веб-версия.
fs.mkdirSync(path.join(distDir, 'scriptable'), { recursive: true });
let widgetJs = fs.readFileSync(path.join(srcDir, 'scriptable', 'smart-fridge.js'), 'utf8');
widgetJs = widgetJs.replaceAll('__SUPABASE_URL__', process.env.SUPABASE_URL || '');
widgetJs = widgetJs.replaceAll('__SUPABASE_ANON_KEY__', process.env.SUPABASE_ANON_KEY || '');
fs.writeFileSync(path.join(distDir, 'scriptable', 'smart-fridge.js'), widgetJs);
fs.cpSync(path.join(srcDir, 'icons'), path.join(distDir, 'icons'), { recursive: true });

console.log('Build complete ->', distDir);
