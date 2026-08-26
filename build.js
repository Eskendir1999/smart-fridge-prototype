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
fs.cpSync(path.join(srcDir, 'icons'), path.join(distDir, 'icons'), { recursive: true });

console.log('Build complete ->', distDir);
