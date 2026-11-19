/* Quick add sheet: paste a list / message / receipt text -> review -> add to stock.
 * Uses the app's existing globals (openSheet, saveStockItem, findCatalog...). Nothing is saved without review. */
(function(){
  'use strict';
  const Q = globalThis.SFQuickAdd;
  const $ = id => document.getElementById(id);
  const sheet = $('quick-sheet');
  if(!Q || !sheet) return;
  const text = $('quick-text'), preview = $('quick-preview'), addBtn = $('quick-add-btn');
  const destFridge = $('quick-dest-fridge'), destFreezer = $('quick-dest-freezer');
  let drafts = [], busy = false;

  const plural = (n, f) => { const a = n % 100, b = n % 10; return f[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2]; };
  const toFreezer = () => destFreezer.classList.contains('active');
  const fmtQty = d => String(d.qty).replace('.', ',') + ' ' + d.unit;

  function shelfDays(d){
    const base = d.entry ? d.entry.shelfDays : Q.estimateDays(d.name);
    if(!base) return null;
    return toFreezer() ? Math.max(base, 60) : base;
  }
  function render(){
    drafts = Q.parseList(text.value).map(d => ({...d, entry: typeof findCatalog === 'function' ? findCatalog(d.name) : null, on: true}));
    preview.replaceChildren();
    if(!drafts.length){ addBtn.disabled = true; addBtn.textContent = 'Добавить'; return; }
    const head = document.createElement('div');
    head.className = 'quick-head';
    head.textContent = 'Проверьте перед добавлением. Сроки — примерные, по типу продукта.';
    preview.append(head);
    drafts.forEach((d, i) => {
      const row = document.createElement('label');
      row.className = 'quick-row';
      const box = document.createElement('input');
      box.type = 'checkbox'; box.checked = true; box.dataset.quickIdx = String(i);
      box.addEventListener('change', () => { d.on = box.checked; paintButton(); });
      const name = document.createElement('span');
      name.className = 'quick-name'; name.textContent = (d.entry?.emoji ? d.entry.emoji + ' ' : '') + d.name;
      const meta = document.createElement('span');
      meta.className = 'quick-meta';
      const days = shelfDays(d);
      meta.textContent = fmtQty(d) + ' · ' + (days ? '≈ ' + days + ' ' + plural(days, ['день', 'дня', 'дней']) : 'срок не указан');
      row.append(box, name, meta);
      preview.append(row);
    });
    paintButton();
  }
  function paintButton(){
    const n = drafts.filter(d => d.on).length;
    addBtn.disabled = busy || n === 0;
    addBtn.textContent = n ? 'Добавить ' + n + ' ' + plural(n, ['продукт', 'продукта', 'продуктов']) : 'Добавить';
  }
  // Версия 2 ноября: продукт сразу появляется в списке, запись уходит на сервер через dbInsertItem (stock_mutate).
  async function addAll(){
    if(busy) return;
    const chosen = drafts.filter(d => d.on);
    if(!chosen.length) return;
    busy = true; paintButton();
    const freezer = toFreezer();
    const target = freezer ? freezerData : fridgeData;
    try{
      for(const d of chosen){
        const days = shelfDays(d);
        const unit = d.unit === 'шт' && !Number.isInteger(d.qty) ? 'кг' : d.unit;
        const item = {
          name: d.name.slice(0, 160), emoji: d.entry?.emoji || '📦', qtyNum: d.qty, unit,
          location: freezer ? 'Морозилка' : 'Средняя полка',
          expiresOn: days ? isoDate(addDays(TODAY, days)) : null,
        };
        target.push(item);
        await dbInsertItem(item, freezer ? 'freezer' : 'fridge');
      }
    } finally { busy = false; }
    renderFridgeList(currentCompartment); updateSummary(); renderMissingAlert(); renderSuggestRow();
    text.value = ''; render(); closeSheet();
    showToast('Добавлено: ' + chosen.length + ' ' + plural(chosen.length, ['продукт', 'продукта', 'продуктов']));
  }
  function open(opts = {}){
    const receipt = $('quick-receipt'), link = $('quick-receipt-link');
    receipt.hidden = !opts.receipt;
    if(opts.receipt) link.href = opts.receipt;
    if(typeof opts.text === 'string') text.value = opts.text;
    render();
    openSheet(sheet);
    if(!opts.receipt) setTimeout(() => text.focus({preventScroll: true}), 250);
  }
  function setDest(freezer){
    destFridge.classList.toggle('active', !freezer);
    destFreezer.classList.toggle('active', freezer);
    render();
  }

  let timer = null;
  text.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 150); });
  destFridge.addEventListener('click', () => setDest(false));
  destFreezer.addEventListener('click', () => setDest(true));
  addBtn.addEventListener('click', addAll);
  $('quick-cancel').addEventListener('click', () => closeSheet());
  $('sheet-quick-opt')?.addEventListener('click', () => { closeSheet(); setTimeout(() => open(), 50); });
  // "?quick=1" deep link (e.g. from a home-screen shortcut).
  if(new URLSearchParams(location.search).get('quick') === '1') window.addEventListener('load', () => setTimeout(() => open(), 300), {once: true});
  globalThis.sfQuickAdd = {open};
})();
