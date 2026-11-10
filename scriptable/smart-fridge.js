// Smart Fridge for Scriptable. This version shows a shortcut to the app.
// Running it removes the old widget's local snapshot and stored sign-in data.
const APP_URL = 'https://smart-fridge-prototype.vercel.app';
const CACHE_FILE = 'smartfridge-cache.json';
const LEGACY_KEYS = ['smartfridge.access', 'smartfridge.refresh', 'smartfridge.expires', 'smartfridge.email'];

function clearLegacyData() {
  try {
    const fm = FileManager.local();
    const path = fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
    if (fm.fileExists(path)) fm.remove(path);
  } catch { /* The shortcut does not read the cache, even if removal fails. */ }
  for (const key of LEGACY_KEYS) {
    try {
      if (Keychain.contains(key)) Keychain.remove(key);
    } catch { /* The shortcut never uses stored sign-in data. */ }
  }
}

clearLegacyData();
if (config.runsInWidget) {
  const widget = new ListWidget();
  widget.url = APP_URL;
  const title = widget.addText('Smart Fridge');
  title.font = Font.semiboldSystemFont(13);
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.55;
  if (!String(config.widgetFamily || '').startsWith('accessory')) {
    widget.addSpacer(4);
    widget.addText('Открыть приложение').font = Font.systemFont(11);
  }
  Script.setWidget(widget);
} else {
  const notice = new Alert();
  notice.title = 'Виджет Smart Fridge';
  notice.message = 'Виджет открывает приложение. Личные данные и покупки на виджете выключены.';
  notice.addAction('Понятно');
  await notice.presentAlert();
}
Script.complete();
