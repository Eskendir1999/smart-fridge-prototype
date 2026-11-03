'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const css = source.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(css, 'The production stylesheet should be present');
  const evidence = process.env.SF_EVIDENCE_DIR || path.join(__dirname, '../test-evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const outcomes = [];
  try {
    for (const width of [390, 767, 768, 1024, 1440]) {
      for (const reducedMotion of ['reduce', 'no-preference']) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion });
        await page.setContent(`<style>${css}</style>
          <div class="sheet-overlay open"></div>
          <div id="motion-sheet" class="sheet open" style="height:300px" role="dialog" aria-modal="true">
            <h3>Добавить продукт</h3>
            <div id="stock-save-panel" role="status" aria-live="polite" data-state="pending" style="display:block;background:var(--surface,#fff);color:var(--ink,#222);padding:12px 16px;margin:16px;border:1px solid #bbb;border-radius:16px;box-shadow:0 4px 20px #0002">
              <div id="stock-save-message">Сохраняем…</div>
              <button id="stock-retry-btn" class="secondary-btn" hidden>Повторить сохранение</button>
              <button id="stock-undo-btn" class="secondary-btn" hidden>Отменить</button>
            </div>
          </div>`);
        await page.waitForTimeout(400);
        const g = await page.locator('#motion-sheet').boundingBox();
        assert.ok(g, 'sheet is visible');
        if (width >= 768) {
          assert.ok(Math.abs((g.x + g.width / 2) - width / 2) <= 2, `desktop x offset at ${width}, ${reducedMotion}`);
          assert.ok(Math.abs((g.y + g.height / 2) - 450) <= 2, `desktop y offset at ${width}, ${reducedMotion}`);
        } else {
          assert.ok(Math.abs((g.y + g.height) - 900) <= 3, `mobile bottom offset at ${width}, ${reducedMotion}`);
        }
        const colors = [];
        for (const state of ['pending','error','saved']) {
          await page.locator('#stock-save-panel').evaluate((el, st) => {el.dataset.state = st; el.querySelector('#stock-save-message').textContent = st;},state);
          await page.waitForTimeout(190);
          const color = await page.locator('#stock-save-panel').evaluate(el => getComputedStyle(el).backgroundColor);
          colors.push(color);
        }
        assert.equal(new Set(colors).size, 3, `distinct states at ${width}, ${reducedMotion}`);
        if (width === 390 || width === 768 || width === 1440) {
          await page.screenshot({ path: path.join(evidence, `motion-${width}-${reducedMotion}.png`) });
        }
        outcomes.push({width, reducedMotion, geometry:'pass', states:'pass'});
        await page.close();
      }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(evidence, 'motion-visual-results.json'), JSON.stringify(outcomes, null, 2));
  console.log('Motion visual fixture PASS:', outcomes.length, 'viewport/preference combinations');
})().catch(e => {console.error(e); process.exitCode = 1;});
