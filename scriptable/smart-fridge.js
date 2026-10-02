// Smart Fridge: виджеты для Scriptable (бесплатная замена нативным виджетам).
//
// Как добавить виджет на экран:
//   маленький    параметр «weight» (по умолчанию) — вес сейчас и линия тренда
//   маленький    параметр «arc»                   — дуга до цели
//   средний      любой параметр                   — корзина
//   экран блокировки: круг, строка и прямоугольник
// Нажатие на виджет открывает Scriptable с меню (вход, выход, предпросмотр).
//
// Пароль нигде не хранится: он уходит в Supabase один раз, а в связке ключей iPhone
// остаётся только токен обновления сессии.

const SUPABASE_URL = '__SUPABASE_URL__';
const SUPABASE_ANON_KEY = '__SUPABASE_ANON_KEY__';
const APP_URL = 'https://smart-fridge-prototype.vercel.app';
const WEIGH_EVERY_DAYS = 2;
const CART_LIMIT = 4;

const KC_REFRESH = 'smartfridge.refresh';
const KC_ACCESS = 'smartfridge.access';
const KC_EXPIRES = 'smartfridge.expires';
const KC_EMAIL = 'smartfridge.email';
const CACHE_FILE = 'smartfridge-cache.json';

class AuthError extends Error {}

// ---------- Вход ----------

function kcGet(key) { return Keychain.contains(key) ? Keychain.get(key) : null; }

function saveSession(json) {
  Keychain.set(KC_ACCESS, json.access_token);
  Keychain.set(KC_REFRESH, json.refresh_token);
  const exp = json.expires_at || (Math.floor(Date.now() / 1000) + (json.expires_in || 3600));
  Keychain.set(KC_EXPIRES, String(exp));
}

function clearSession() {
  [KC_ACCESS, KC_REFRESH, KC_EXPIRES].forEach(k => { if (Keychain.contains(k)) Keychain.remove(k); });
}

async function tokenRequest(grant, body) {
  const req = new Request(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`);
  req.method = 'POST';
  req.headers = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  req.body = JSON.stringify(body);
  const json = await req.loadJSON();
  return { status: req.response.statusCode, json };
}

async function getAccessToken() {
  const access = kcGet(KC_ACCESS);
  const expires = Number(kcGet(KC_EXPIRES) || 0);
  if (access && expires - Date.now() / 1000 > 60) return access;

  const refresh = kcGet(KC_REFRESH);
  if (!refresh) throw new AuthError('Нет входа');
  const { status, json } = await tokenRequest('refresh_token', { refresh_token: refresh });
  if (status >= 500) throw new Error(`Сервер недоступен (${status})`);
  if (status >= 400 || !json.access_token) throw new AuthError('Сессия истекла');
  saveSession(json);
  return json.access_token;
}

async function signInInteractive() {
  const a = new Alert();
  a.title = 'Вход в Smart Fridge';
  a.message = 'Тот же email и пароль, что в приложении. Пароль не сохраняется.';
  a.addTextField('Email', kcGet(KC_EMAIL) || '');
  a.addSecureTextField('Пароль', '');
  a.addAction('Войти');
  a.addCancelAction('Отмена');
  if ((await a.presentAlert()) === -1) return false;

  const email = a.textFieldValue(0).trim();
  const password = a.textFieldValue(1);
  if (!email || !password) return false;

  let res;
  try { res = await tokenRequest('password', { email, password }); }
  catch (e) { await notify('Нет сети', 'Не удалось связаться с сервером. Попробуйте ещё раз.'); return false; }
  if (res.status >= 400 || !res.json.access_token) {
    await notify('Не удалось войти', 'Проверьте email и пароль.');
    return false;
  }
  saveSession(res.json);
  Keychain.set(KC_EMAIL, email);
  return true;
}

async function notify(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction('Понятно');
  await a.presentAlert();
}

// ---------- Данные ----------

async function rest(path, token) {
  const req = new Request(`${SUPABASE_URL}/rest/v1/${path}`);
  req.headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };
  const json = await req.loadJSON();
  if (req.response.statusCode >= 400) throw new Error(`Ошибка данных (${req.response.statusCode})`);
  return json;
}

function parseLocalDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Те же правила, что в приложении (buildWidgetSnapshot): виджеты показывают первый профиль семьи.
async function fetchSnapshot() {
  const token = await getAccessToken();
  const profiles = await rest('family_profiles?select=id,name,start_weight_kg,target_weight_kg,goal&order=created_at.asc&limit=1', token);
  const profile = profiles[0];
  if (!profile) return null;

  const [rows, cart] = await Promise.all([
    rest(`family_measurements?select=log_date,weight&profile_id=eq.${profile.id}&order=log_date.asc`, token),
    rest(`cart_items?select=id,name&order=created_at.asc&limit=12`, token),
  ]);
  const weights = rows.map(r => Number(r.weight));
  const first = rows[0], last = rows[rows.length - 1];
  const start = Number(profile.start_weight_kg);
  return {
    profileName: profile.name,
    weightNow: last ? Number(last.weight) : start,
    weightStart: first ? Number(first.weight) : start,
    weightGoal: (profile.goal === 'lose' && profile.target_weight_kg) ? Number(profile.target_weight_kg) : null,
    startTs: first ? parseLocalDate(first.log_date).getTime() / 1000 : null,
    lastWeighTs: last ? parseLocalDate(last.log_date).getTime() / 1000 : null,
    trend: weights.slice(-20),
    cart: cart.map(c => ({ id: String(c.id), name: c.name })),
    updatedAt: Date.now() / 1000,
  };
}

function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.documentsDirectory(), CACHE_FILE) };
}
function readCache() {
  try {
    const { fm, path } = cachePath();
    return fm.fileExists(path) ? JSON.parse(fm.readString(path)) : null;
  } catch (e) { return null; }
}
function writeCache(snap) {
  try { const { fm, path } = cachePath(); fm.writeString(path, JSON.stringify(snap)); } catch (e) { /* кэш не критичен */ }
}

// Возвращает { snap, problem }. Без сети показываем последние данные, без входа — подсказку.
async function loadSnapshot() {
  try {
    const snap = await fetchSnapshot();
    if (snap) writeCache(snap);
    return { snap, problem: snap ? null : 'noprofile' };
  } catch (e) {
    if (e instanceof AuthError) return { snap: null, problem: 'auth' };
    const cached = readCache();
    return { snap: cached, problem: cached ? null : 'offline' };
  }
}

// ---------- Форматирование ----------

function fmtKg(v) {
  const r = Math.round(v * 10) / 10;
  const s = r.toFixed(1).replace('.', ',');
  return s.endsWith(',0') ? s.slice(0, -2) : s;
}
function fmtSigned(v) {
  const r = Math.round(Math.abs(v) * 10) / 10;
  if (r === 0) return '0';
  return (v < 0 ? '−' : '+') + fmtKg(r);
}
function ruDays(n) {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return 'дней';
  const m10 = n % 10;
  if (m10 === 1) return 'день';
  if (m10 >= 2 && m10 <= 4) return 'дня';
  return 'дней';
}
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
function startLabel(ts) {
  if (!ts) return 'начала';
  const d = new Date(ts * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function progressOf(s) {
  if (s.weightNow == null || s.weightStart == null || s.weightGoal == null || s.weightStart === s.weightGoal) return 0;
  return Math.min(1, Math.max(0, (s.weightStart - s.weightNow) / (s.weightStart - s.weightGoal)));
}
function daysUntilWeighIn(s) {
  if (!s.lastWeighTs) return null;
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const passed = Math.round((startOfDay(new Date()) - startOfDay(new Date(s.lastWeighTs * 1000))) / 86400000);
  return WEIGH_EVERY_DAYS - passed;
}

// ---------- Оформление ----------

const dark = Device.isUsingDarkAppearance();
const C = dark ? {
  surface: new Color('#1B2620'), ink: new Color('#E8EEE9'), soft: new Color('#A6B1A9'), muted: new Color('#7B887F'),
  line: new Color('#34443B'), fresh: new Color('#5CC585'), freshSoft: new Color('#1D3327'),
  warn: new Color('#F18C4E'), warnSoft: new Color('#3A271B'),
} : {
  surface: new Color('#FFFFFF'), ink: new Color('#1F2A24'), soft: new Color('#5B655D'), muted: new Color('#8A8F87'),
  line: new Color('#E6DFD3'), fresh: new Color('#2F7A4D'), freshSoft: new Color('#E7F2EB'),
  warn: new Color('#D46A2C'), warnSoft: new Color('#FBEBE1'),
};
const SERIF = 'Georgia-Bold';

function dotImage(color) {
  const dc = new DrawContext();
  dc.size = new Size(14, 14);
  dc.opaque = false;
  dc.setFillColor(color);
  dc.fillEllipse(new Rect(0, 0, 14, 14));
  return dc.getImage();
}

function addLabel(parent, text, dotColor) {
  const row = parent.addStack();
  row.centerAlignContent();
  const dot = row.addImage(dotImage(dotColor));
  dot.imageSize = new Size(7, 7);
  row.addSpacer(5);
  const t = row.addText(text);
  t.font = Font.semiboldSystemFont(11.5);
  t.textColor = C.muted;
  t.lineLimit = 1;
  return row;
}

function addChip(parent, text, good) {
  const row = parent.addStack();
  const chip = row.addStack();
  chip.backgroundColor = good ? C.freshSoft : C.warnSoft;
  chip.cornerRadius = 9;
  chip.setPadding(3, 8, 3, 8);
  const t = chip.addText(text);
  t.font = Font.boldSystemFont(10.5);
  t.textColor = good ? C.fresh : C.warn;
  t.lineLimit = 1;
  row.addSpacer();
  return row;
}

function newWidget() {
  const w = new ListWidget();
  w.backgroundColor = C.surface;
  w.setPadding(14, 14, 12, 14);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  return w;
}

// Линия тренда: те же отступы и заливка, что в нативном виджете.
function sparkImage(values) {
  const W = 210, H = 50, pad = 3;
  const dc = new DrawContext();
  dc.size = new Size(W, H);
  dc.opaque = false;
  if (values.length < 2) return dc.getImage();
  const mn = Math.min(...values), mx = Math.max(...values);
  const span = (mx - mn) === 0 ? 1 : (mx - mn);
  const pts = values.map((v, i) => new Point(
    pad + i / (values.length - 1) * (W - 2 * pad),
    pad + (mx - v) / span * (H - 2 * pad)));

  const area = new Path();
  area.move(new Point(pts[0].x, H));
  pts.forEach(p => area.addLine(p));
  area.addLine(new Point(pts[pts.length - 1].x, H));
  area.closeSubpath();
  dc.addPath(area);
  dc.setFillColor(new Color(dark ? '#5CC585' : '#2F7A4D', 0.14));
  dc.fillPath();

  const line = new Path();
  line.move(pts[0]);
  pts.slice(1).forEach(p => line.addLine(p));
  dc.addPath(line);
  dc.setStrokeColor(C.fresh);
  dc.setLineWidth(2.5);
  dc.strokePath();

  const last = pts[pts.length - 1];
  dc.setFillColor(C.fresh);
  dc.fillEllipse(new Rect(last.x - 3.5, last.y - 3.5, 7, 7));
  return dc.getImage();
}

// Полукруг прогресса. У DrawContext нет скруглённых концов линии, поэтому дорисовываем кружки.
function arcImage(progress, centerText) {
  const W = 280, H = 156, lw = 24;
  const R = (W - lw) / 2, cx = W / 2, cy = lw / 2 + R;
  const dc = new DrawContext();
  dc.size = new Size(W, H);
  dc.opaque = false;

  const pointAt = t => {
    const phi = Math.PI + Math.PI * t;
    return new Point(cx + R * Math.cos(phi), cy + R * Math.sin(phi));
  };
  const strokeArc = (from, to, color) => {
    const steps = Math.max(2, Math.round(60 * (to - from)));
    const path = new Path();
    path.move(pointAt(from));
    for (let i = 1; i <= steps; i++) path.addLine(pointAt(from + (to - from) * i / steps));
    dc.addPath(path);
    dc.setStrokeColor(color);
    dc.setLineWidth(lw);
    dc.strokePath();
    dc.setFillColor(color);
    [pointAt(from), pointAt(to)].forEach(p => dc.fillEllipse(new Rect(p.x - lw / 2, p.y - lw / 2, lw, lw)));
  };
  strokeArc(0, 1, C.line);
  if (progress > 0) strokeArc(0, progress, C.fresh);

  dc.setFont(new Font(SERIF, 50));
  dc.setTextColor(C.ink);
  dc.setTextAlignedCenter();
  dc.drawTextInRect(centerText, new Rect(0, 82, W, 66));
  return dc.getImage();
}

// Кольцо для экрана блокировки: рисуем белым, система сама подкрасит.
function ringImage(progress, text) {
  const S = 120, lw = 11, R = (S - lw) / 2, c = S / 2;
  const dc = new DrawContext();
  dc.size = new Size(S, S);
  dc.opaque = false;
  const ring = (to, color) => {
    const steps = Math.max(2, Math.round(80 * to));
    const path = new Path();
    for (let i = 0; i <= steps; i++) {
      const phi = -Math.PI / 2 + 2 * Math.PI * to * i / steps;
      const p = new Point(c + R * Math.cos(phi), c + R * Math.sin(phi));
      if (i === 0) path.move(p); else path.addLine(p);
    }
    dc.addPath(path);
    dc.setStrokeColor(color);
    dc.setLineWidth(lw);
    dc.strokePath();
  };
  ring(0.9999, new Color('#FFFFFF', 0.3));
  if (progress > 0) ring(Math.min(progress, 0.9999), new Color('#FFFFFF'));
  dc.setFont(Font.boldSystemFont(40));
  dc.setTextColor(new Color('#FFFFFF'));
  dc.setTextAlignedCenter();
  dc.drawTextInRect(text, new Rect(0, 30, S, 48));
  dc.setFont(Font.mediumSystemFont(20));
  dc.drawTextInRect('кг', new Rect(0, 70, S, 26));
  return dc.getImage();
}

// ---------- Виджеты ----------

function messageWidget(text) {
  const w = newWidget();
  w.addSpacer();
  const t = w.addText(text);
  t.font = Font.mediumSystemFont(11.5);
  t.textColor = C.soft;
  t.centerAlignText();
  w.addSpacer();
  return w;
}

function problemText(problem) {
  if (problem === 'auth') return 'Войдите: нажмите на виджет и выберите «Войти»';
  if (problem === 'noprofile') return 'Создайте профиль в Smart Fridge';
  return 'Нет данных. Проверьте сеть';
}

function weightSmall(s) {
  const w = newWidget();
  addLabel(w, 'Вес', C.fresh);
  w.addSpacer(6);
  const row = w.addStack();
  row.bottomAlignContent();
  const big = row.addText(fmtKg(s.weightNow));
  big.font = new Font(SERIF, 34);
  big.textColor = C.ink;
  big.minimumScaleFactor = 0.7;
  big.lineLimit = 1;
  row.addSpacer(3);
  const unit = row.addText('кг');
  unit.font = Font.systemFont(13);
  unit.textColor = C.soft;
  row.addSpacer();
  w.addSpacer(6);
  if (s.weightStart != null) addChip(w, `${fmtSigned(s.weightNow - s.weightStart)} с ${startLabel(s.startTs)}`, s.weightNow <= s.weightStart);
  w.addSpacer();
  const holder = w.addStack();
  holder.size = new Size(0, 34);
  const img = holder.addImage(sparkImage(s.trend));
  img.applyFittingContentMode();
  return w;
}

function goalArcSmall(s) {
  if (s.weightGoal == null) return messageWidget('Цель не задана. Укажите целевой вес в профиле');
  const w = newWidget();
  addLabel(w, `Цель ${fmtKg(s.weightGoal)} кг`, C.fresh);
  w.addSpacer(6);
  const holder = w.addStack();
  holder.size = new Size(0, 76);
  const img = holder.addImage(arcImage(progressOf(s), fmtKg(s.weightNow)));
  img.applyFittingContentMode();
  w.addSpacer();
  const row = w.addStack();
  row.centerAlignContent();
  const left = row.addText(`осталось ${fmtKg(Math.max(0, s.weightNow - s.weightGoal))} кг`);
  left.font = Font.mediumSystemFont(11);
  left.textColor = C.soft;
  left.lineLimit = 1;
  left.minimumScaleFactor = 0.8;
  row.addSpacer(4);
  addChip(row, `${Math.round(progressOf(s) * 100)}%`, true);
  return w;
}

function cartMedium(s) {
  const w = newWidget();
  const head = w.addStack();
  head.centerAlignContent();
  addLabel(head, 'Корзина', C.warn);
  head.addSpacer();
  if (s.cart.length > 0) addChip(head, String(s.cart.length), false);
  w.addSpacer(7);
  if (s.cart.length === 0) {
    w.addSpacer();
    const t = w.addText('Корзина пуста');
    t.font = Font.mediumSystemFont(13);
    t.textColor = C.soft;
    t.centerAlignText();
    w.addSpacer();
    return w;
  }
  s.cart.slice(0, CART_LIMIT).forEach(item => {
    const row = w.addStack();
    row.centerAlignContent();
    const dot = row.addImage(dotImage(C.line));
    dot.imageSize = new Size(8, 8);
    row.addSpacer(10);
    const t = row.addText(item.name);
    t.font = Font.semiboldSystemFont(13);
    t.textColor = C.ink;
    t.lineLimit = 1;
    row.addSpacer();
    w.addSpacer(7);
  });
  if (s.cart.length > CART_LIMIT) {
    const more = w.addText(`ещё ${s.cart.length - CART_LIMIT}`);
    more.font = Font.mediumSystemFont(11);
    more.textColor = C.muted;
  }
  w.addSpacer();
  return w;
}

function lockWidget() {
  const w = new ListWidget();
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  return w;
}

function lockCircular(s) {
  const w = lockWidget();
  w.addAccessoryWidgetBackground = true;
  const img = w.addImage(ringImage(progressOf(s), String(Math.round(s.weightNow))));
  img.centerAlignImage();
  return w;
}

function lockInline(s) {
  const w = lockWidget();
  const d = daysUntilWeighIn(s);
  w.addText(d == null ? 'Smart Fridge' : d <= 0 ? 'Пора взвеситься' : `Взвесить через ${d} ${ruDays(d)}`);
  return w;
}

function lockRect(s) {
  const w = lockWidget();
  const head = w.addText(`Вес ${fmtKg(s.weightNow)} кг`);
  head.font = Font.boldSystemFont(14);
  if (s.weightStart != null) {
    const delta = w.addText(`${fmtSigned(s.weightNow - s.weightStart)} с ${startLabel(s.startTs)}`);
    delta.font = Font.systemFont(12);
  }
  if (s.weightGoal != null) {
    const goal = w.addText(`осталось ${fmtKg(Math.max(0, s.weightNow - s.weightGoal))} кг · ${Math.round(progressOf(s) * 100)}%`);
    goal.font = Font.systemFont(12);
  }
  return w;
}

async function buildWidget(family, param) {
  const { snap, problem } = await loadSnapshot();
  const isLock = String(family).startsWith('accessory');
  if (!snap || snap.weightNow == null) {
    if (family === 'accessoryInline') { const w = lockWidget(); w.addText('Войдите в Smart Fridge'); return w; }
    if (isLock) { const w = lockWidget(); w.addText('Smart Fridge'); return w; }
    return messageWidget(problemText(problem || 'noprofile'));
  }
  switch (family) {
    case 'accessoryCircular': return lockCircular(snap);
    case 'accessoryInline': return lockInline(snap);
    case 'accessoryRectangular': return lockRect(snap);
    case 'medium': case 'large': case 'extraLarge': return cartMedium(snap);
    default: return param === 'arc' ? goalArcSmall(snap) : weightSmall(snap);
  }
}

// ---------- Запуск ----------

async function preview(family, param) {
  const w = await buildWidget(family, param);
  if (family === 'medium') await w.presentMedium();
  else if (family === 'accessoryCircular' && w.presentAccessoryCircular) await w.presentAccessoryCircular();
  else if (family === 'accessoryRectangular' && w.presentAccessoryRectangular) await w.presentAccessoryRectangular();
  else if (family === 'accessoryInline' && w.presentAccessoryInline) await w.presentAccessoryInline();
  else await w.presentSmall();
}

async function appMenu() {
  if (!kcGet(KC_REFRESH)) {
    if (!(await signInInteractive())) return;
  }
  while (true) {
    const m = new Alert();
    m.title = 'Smart Fridge';
    m.message = kcGet(KC_EMAIL) ? `Аккаунт: ${kcGet(KC_EMAIL)}` : '';
    ['Предпросмотр: вес', 'Предпросмотр: дуга до цели', 'Предпросмотр: корзина', 'Предпросмотр: экран блокировки',
      'Открыть Smart Fridge', 'Войти в другой аккаунт', 'Выйти'].forEach(t => m.addAction(t));
    m.addCancelAction('Закрыть');
    const i = await m.presentSheet();
    if (i === -1) return;
    if (i === 0) await preview('small', 'weight');
    else if (i === 1) await preview('small', 'arc');
    else if (i === 2) await preview('medium', '');
    else if (i === 3) await preview('accessoryCircular', '');
    else if (i === 4) { Safari.open(APP_URL); return; }
    else if (i === 5) { clearSession(); if (!(await signInInteractive())) return; }
    else if (i === 6) { clearSession(); await notify('Вы вышли', 'Виджеты покажут подсказку, пока вы не войдёте снова.'); return; }
  }
}

if (config.runsInWidget) {
  const widget = await buildWidget(config.widgetFamily || 'small', String(args.widgetParameter || '').trim().toLowerCase());
  Script.setWidget(widget);
} else {
  await appMenu();
}
Script.complete();
