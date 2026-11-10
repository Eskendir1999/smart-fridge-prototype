(() => {
  const byId = id => document.getElementById('account-erasure-' + id);
  const panel = byId('panel');
  const form = byId('form');
  const status = byId('status');
  const secret = byId('secret');
  const password = byId('password');
  const submit = form.querySelector('button[type=submit]');
  const storageKey = 'sf_account_erasure_receipt';
  const receiptPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const project = () => window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'sf-erasure-verification' },
  });
  let receipt = null;
  let verification;
  let checker;
  let active = false;

  function readReceipt() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      return receiptPattern.test(saved?.secret || '') ? saved : null;
    } catch { return null; }
  }

  function saveReceipt(value) {
    try { sessionStorage.setItem(storageKey, JSON.stringify(value)); } catch {}
  }

  function showReceipt(value) {
    secret.value = value?.secret || '';
    byId('pending').hidden = !value;
  }

  async function lookup(code) {
    checker ??= window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { accessToken: async () => null });
    const { data, error } = await checker.rpc('sf_account_erasure', { action: 'status', receipt_secret: code });
    if (error) throw Error('lookup_failed');
    return data?.status === 'active_account_deleted';
  }

  async function finish(actor, code) {
    saveReceipt({ secret: code });
    if (actor !== currentUserId) return;
    for (const storage of [localStorage, sessionStorage]) {
      try {
        for (const key of Object.keys(storage)) if (key.includes(actor)) storage.removeItem(key);
      } catch {}
    }
    window.dispatchEvent(new Event('sf-account-reset'));
    resetPrivateContext();
    familyProfiles = [];
    currentUserId = null;
    globalThis.sfDinner?.clear();
    document.getElementById('family-grid').replaceChildren();
    await sb.auth.signOut({ scope: 'local' });
    location.reload();
  }

  document.getElementById('my-data-open').addEventListener('click', async () => {
    const actor = currentUserId;
    const { data } = await sb.rpc('sf_account_erasure', { action: 'availability' });
    if (!actor || actor !== currentUserId || !document.getElementById('screen-my-data').classList.contains('active')) return;
    panel.hidden = data?.enabled !== true;
    const saved = readReceipt();
    if (saved?.actor === actor) {
      receipt = saved;
      showReceipt(receipt);
      panel.open = true;
      status.textContent = 'Есть запрос с неподтверждённым результатом. Проверьте его или повторите подтверждение тем же кодом.';
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const actor = currentUserId;
    if (active || !actor || panel.hidden || byId('confirm').value !== 'УДАЛИТЬ АККАУНТ') return;
    const enteredPassword = password.value;
    password.value = '';
    active = true;
    submit.disabled = true;
    status.textContent = 'Проверяем вход и подтверждаем удаление…';
    try {
      if (receipt && await lookup(receipt.secret)) {
        await finish(actor, receipt.secret);
        return;
      }
      const { data: current } = await sb.auth.getUser();
      if (current.user?.id !== actor || !current.user.email || actor !== currentUserId) throw Error('authentication_required');
      if (!receipt) {
        const code = crypto.randomUUID();
        const { data, error } = await sb.rpc('sf_account_erasure', { action: 'prepare', receipt_secret: code });
        if (error || data?.status !== 'confirmation_required') throw Error('prepare_failed');
        if (actor !== currentUserId || !panel.open) return;
        receipt = { actor, secret: code };
        saveReceipt(receipt);
        showReceipt(receipt);
      }
      const code = receipt.secret;
      verification ??= project();
      // Use Auth directly. The password never goes to a Smart Fridge API.
      const { data: fresh, error: authError } = await verification.auth.signInWithPassword({
        email: current.user.email, password: enteredPassword,
      });
      if (authError || fresh.user?.id !== actor || !fresh.session) {
        status.textContent = 'Повторный вход не подтверждён. Проверьте пароль. Удаление этим действием не отправлено.';
        return;
      }
      if (actor !== currentUserId || !panel.open || panel.hidden) return;
      const { data, error } = await verification.rpc('sf_account_erasure', { action: 'delete', receipt_secret: code });
      if (data?.status === 'active_account_deleted' || await lookup(code)) {
        await finish(actor, code);
      } else if (error?.code === '22023') {
        receipt = null;
        try { sessionStorage.removeItem(storageKey); } catch {}
        showReceipt(null);
        status.textContent = 'Срок подтверждения истёк. Этот запрос отклонён. Для нового запроса подтвердите удаление заново.';
      } else {
        status.textContent = 'Удаление пока не подтверждено. Проверьте результат по тому же коду.';
      }
    } catch {
      status.textContent = receipt
        ? 'Удаление пока не подтверждено. Проверьте результат по сохранённому коду.'
        : 'Не удалось подготовить удаление. Повторите попытку.';
    } finally {
      if (verification) await verification.auth.signOut({ scope: 'local' }).catch(() => {});
      active = false;
      submit.disabled = false;
    }
  });

  byId('verify').addEventListener('click', async () => {
    if (active || !receipt) return;
    const { actor, secret: code } = receipt;
    try {
      if (await lookup(code)) await finish(actor, code);
      else status.textContent = 'Завершённая операция по этому коду пока не найдена.';
    } catch { status.textContent = 'Проверка недоступна. Повторите позже.'; }
  });

  const previous = readReceipt();
  if (previous) {
    byId('code').value = previous.secret;
    if (!previous.actor) {
      byId('receipt').open = true;
      lookup(previous.secret).then(confirmed => {
        byId('result').textContent = confirmed
          ? 'Удаление аккаунта из рабочей базы подтверждено.'
          : 'Операция не найдена или срок квитанции истёк.';
      }).catch(() => { byId('result').textContent = 'Проверка недоступна. Повторите позже.'; });
    }
  }

  byId('check').addEventListener('submit', async event => {
    event.preventDefault();
    const code = byId('code').value.trim();
    const result = byId('result');
    if (!receiptPattern.test(code)) {
      result.textContent = 'Проверьте формат кода квитанции.';
      return;
    }
    try {
      result.textContent = await lookup(code)
        ? 'Удаление аккаунта из рабочей базы подтверждено.'
        : 'Операция не найдена, ещё не завершена или срок квитанции истёк.';
    } catch { result.textContent = 'Проверка недоступна. Повторите позже.'; }
  });

  window.addEventListener('sf-account-reset', () => {
    form.reset();
    panel.open = false;
    panel.hidden = true;
    status.textContent = '';
    receipt = null;
    showReceipt(null);
  });
})();
