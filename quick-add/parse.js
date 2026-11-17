/* Quick add: turn pasted text (a shopping list, a message, an electronic receipt) into product drafts.
 * Pure functions, no DOM and no network: the browser and node tests load the same file. */
(function(root){
  'use strict';
  const UNITS = {
    'шт':'шт','штук':'шт','штуки':'шт','штука':'шт','pcs':'шт','pc':'шт','x':'шт','х':'шт',
    'г':'г','гр':'г','грамм':'г','граммов':'г','g':'г',
    'кг':'кг','килограмм':'кг','kg':'кг',
    'мл':'мл','ml':'мл',
    'л':'л','литр':'л','литра':'л','литров':'л','l':'л'
  };
  // Receipt hosts of Kazakhstan fiscal data operators. Only these are offered as "open the e-receipt".
  const RECEIPT_HOSTS = ['consumer.oofd.kz','oofd.kz','ofd1.kz','consumer.kofd.kz','kofd.kz','cabinet.kofd.kz','receipt.kaspi.kz','ofd.kaspi.kz','wofd.kz','receipt.wofd.kz','consumer.wofd.kz','ofd.beeline.kz','tl.kz','ofd.tl.kz'];

  // Rough fridge shelf life by product type, used only when the app catalog has no entry. Always shown as "≈".
  const SHELF = [
    [/хлеб|батон|лепёшк|лепешк|баурсак|булк|лаваш/i, 4],
    [/фарш|курин|куриц|индейк|печень|субпрод/i, 2],
    [/рыб|форел|лосос|сёмг|семг|креветк/i, 2],
    [/мясо|говяд|баранин|конин|свинин|казы|шұжық|шужук/i, 3],
    [/кефир|айран|шубат|кумыс|қымыз|йогурт|сметан|ряженк|творог|курт|сливки/i, 7],
    [/молок/i, 5],
    [/колбас|сосиск|ветчин/i, 10],
    [/сыр/i, 14],
    [/масло сливоч/i, 30],
    [/зелен|укроп|петрушк|кинз|салат|шпинат/i, 4],
    [/ягод|клубник|малин|черешн/i, 3],
    [/помидор|томат|огурц|перец|баклажан|кабач/i, 6],
    [/яблок|груш|апельсин|мандарин|лимон/i, 21],
    [/картоф|морков|лук|свекл|капуст/i, 30],
    [/яйц/i, 21],
    [/рис|греч|круп|макарон|лапш|мук|сахар|соль|чай|кофе|консерв/i, 180]
  ];
  function estimateDays(name){
    for(const [re, days] of SHELF) if(re.test(name)) return days;
    return null;
  }
  const num = s => Number(String(s).replace(/\s/g,'').replace(',','.'));
  const clean = s => s.replace(/\s+/g,' ').replace(/^[\s•·\-–—*>\d.)]+(?=\D)/,'').replace(/[\s,;:–—-]+$/,'').trim();

  function parseLine(raw){
    let line = String(raw||'').replace(/ /g,' ').trim();
    if(!line) return null;
    // Skip receipt service lines and totals.
    if(/^(итого|всего|сумма|ндс|без ндс|наличн|безналичн|карта|сдача|чек|фп|рнм|знм|инк|ккм|кассир|смена|дата|время|оплата|спасибо|бин|иин|www\.|http|купить:?$)/i.test(line)) return null;
    // Receipt shape: "Name ... 2 x 659,00 = 1318,00" or "Name 1,000 x 659.00".
    let m = line.match(/^(.*?)\s+(\d+(?:[.,]\d+)?)\s*[xх×*]\s*(\d[\d\s]*(?:[.,]\d+)?)\s*(?:=\s*(\d[\d\s]*(?:[.,]\d+)?))?\s*(?:₸|тг|тенге|kzt)?$/i);
    if(m){
      const name = clean(m[1]); const qty = num(m[2]); const price = num(m[3]);
      if(!name || !(qty>0)) return null;
      const fromName = unitFromName(name);
      const isWeight = !Number.isInteger(qty);
      return {name, qty: isWeight ? qty : (fromName && qty===1 ? fromName.qty : qty), unit: isWeight ? 'кг' : (fromName && qty===1 ? fromName.unit : 'шт'), price: price>0 ? price : null, source:'receipt'};
    }
    // Our own share format and messages: "• Хлеб — 1 шт", "Молоко 2 л", "Яйца x10", "помидоры 0,5кг".
    line = line.replace(/^[•·\-–—*]\s*/,'');
    m = line.match(/^(.*?)[\s—–-]*[xх×]\s*(\d+)$/i);
    if(m && clean(m[1])) return {name:clean(m[1]), qty:num(m[2]), unit:'шт', price:null, source:'list'};
    m = line.match(/^(.*?)[\s—–:,-]+(\d+(?:[.,]\d+)?)\s*([a-zа-яё]+)\.?$/i);
    if(m && UNITS[m[3].toLowerCase()] && clean(m[1])) return normalize(clean(m[1]), num(m[2]), UNITS[m[3].toLowerCase()]);
    m = line.match(/^(\d+(?:[.,]\d+)?)\s*([a-zа-яё]+)\.?\s+(.+)$/i);
    if(m && UNITS[m[2].toLowerCase()] && clean(m[3])) return normalize(clean(m[3]), num(m[1]), UNITS[m[2].toLowerCase()]);
    m = line.match(/^(.*?)[\s—–:,-]+(\d+)$/);
    if(m && clean(m[1]) && /\D/.test(m[1])) return {name:clean(m[1]), qty:num(m[2]), unit:'шт', price:null, source:'list'};
    const name = clean(line);
    if(!name || name.length > 120 || !/[a-zа-яё]/i.test(name)) return null;
    // A size inside the name ("Молоко 3,2% 1 л") is the package, not a count.
    const pack = unitFromName(name);
    return pack ? {name, qty:pack.qty, unit:pack.unit, price:null, source:'list'} : {name, qty:1, unit:'шт', price:null, source:'list'};
  }
  function unitFromName(name){
    const m = name.match(/(\d+(?:[.,]\d+)?)\s*(кг|г|гр|мл|л)\b\.?\s*$/i);
    if(!m) return null;
    return normalizeQty(num(m[1]), UNITS[m[2].toLowerCase()]);
  }
  function normalizeQty(qty, unit){
    if(unit==='шт' && !Number.isInteger(qty)) return {qty:Math.max(1,Math.round(qty)), unit};
    return {qty, unit};
  }
  function normalize(name, qty, unit){
    if(!(qty>0)) return {name, qty:1, unit:'шт', price:null, source:'list'};
    const q = normalizeQty(qty, unit);
    return {name, qty:q.qty, unit:q.unit, price:null, source:'list'};
  }
  function parseList(text){
    const out = []; const seen = new Map();
    for(const raw of String(text||'').split(/\r?\n|;/)){
      const item = parseLine(raw);
      if(!item) continue;
      item.name = item.name.charAt(0).toUpperCase() + item.name.slice(1);
      const key = item.name.toLowerCase()+'|'+item.unit;
      if(seen.has(key)){ const prev = seen.get(key); prev.qty = Math.round((prev.qty + item.qty)*1000)/1000; continue; }
      seen.set(key, item); out.push(item);
      if(out.length >= 60) break;
    }
    return out;
  }
  function receiptLink(text){
    let url;
    try{ url = new URL(String(text||'').trim()); }catch{ return null; }
    if(!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if(!RECEIPT_HOSTS.some(h => host === h || host.endsWith('.'+h))) return null;
    url.protocol = 'https:';
    return url.href;
  }
  const api = {parseList, parseLine, receiptLink, estimateDays, RECEIPT_HOSTS};
  if(typeof module === 'object' && module.exports) module.exports = api; else root.SFQuickAdd = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
