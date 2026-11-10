'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

test('desktop sheet stays centered with prefers-reduced-motion: reduce', () => {
  const desktop = html.indexOf('@media (min-width:768px){');
  const reduced = html.indexOf('@media (prefers-reduced-motion: reduce){');
  const override = html.indexOf('@media (min-width:768px) and (prefers-reduced-motion: reduce){');
  assert.ok(desktop >= 0 && reduced > desktop && override > reduced, 'desktop reduced-motion rule must follow the base and reduced-motion rules');
  assert.match(html, /\.sheet\{ left:50%; right:auto; top:50%; bottom:auto; transform:translate\(-50%,-40%\)/);
  assert.match(html, /\.sheet\.open\{ transform:translate\(-50%,-50%\); opacity:1; \}/);
  const rule = html.slice(override, html.indexOf('}', override) + 1);
  assert.match(rule, /\.sheet\{ transform:translate\(-50%,-50%\) !important; \}/);
});
