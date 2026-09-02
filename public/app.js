/* Field Budget — instructor app
   No dependencies on purpose: nothing to fetch from a CDN when there is no signal.
   The local IndexedDB ledger is the app's source of truth for display; the server
   is where it eventually lands. */

const API = (location.hostname === 'localhost' || location.hostname.endsWith('netlify.app'))
  ? '/api' : '/api';

const MINOR = { PEN: 100, USD: 100, NZD: 100, EUR: 100 };
const state = { email: null, budgets: [], budgetId: null, entries: [], online: navigator.onLine };

/* ---------------- storage ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('field-budget', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id' });
        s.createIndex('budget', 'budget_id');
        s.createIndex('pending', 'pending');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('receipts')) db.createObjectStore('receipts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbp;
const db = () => (dbp ||= openDB());

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    // A miss gives req.result === undefined. Returning `req` as a fallback here
    // hands callers an IDBRequest that passes a truthy check and then blows up
    // on .find/.length — which is exactly what a fresh install hits.
    t.oncomplete = () => {
      resolve(req && typeof req === 'object' && 'result' in req ? req.result : undefined);
    };
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const putEntry = (e) => tx('entries', 'readwrite', (s) => s.put(e));
const allEntries = () => tx('entries', 'readonly', (s) => s.getAll());
const putMeta = (k, v) => tx('meta', 'readwrite', (s) => s.put(v, k));
const getMeta = (k) => tx('meta', 'readonly', (s) => s.get(k));
const putReceipt = (k, blob) => tx('receipts', 'readwrite', (s) => s.put(blob, k));
const getReceipt = (k) => tx('receipts', 'readonly', (s) => s.get(k));

/* ---------------- money ---------------- */

const minor = (cur) => MINOR[cur] || 100;
const toMinor = (v, cur) => Math.round(Number(v) * minor(cur));

function fmt(amountMinor, cur, { sign = false } = {}) {
  const v = amountMinor / minor(cur);
  const s = new Intl.NumberFormat('en-NZ', {
    style: 'currency', currency: cur, currencyDisplay: 'code',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Math.abs(v));
  const prefix = amountMinor < 0 ? '−' : (sign ? '+' : '');
  return prefix + s;
}

/* ---------------- derived balances ----------------
   Nothing is stored. Remaining is allocated minus spend; float is money in
   minus cash out, per currency, because Katie held PEN and USD at the same time. */

const budget = () => state.budgets.find((b) => b.id === state.budgetId);
const budgetEntries = () => state.entries.filter((e) => e.budget_id === state.budgetId);

function categoryBalances() {
  const b = budget();
  if (!b) return [];
  const spend = {};
  for (const e of budgetEntries()) {
    if (e.entry_type !== 'expense' && e.entry_type !== 'correction') continue;
    if (!e.category_id) continue;
    spend[e.category_id] = (spend[e.category_id] || 0) + e.budget_amount;
  }
  // Categories are one level deep. A parent with subcategories IS the sum of
  // them — it holds no allocation of its own, so there is one place each figure
  // is set and the top line always equals what is underneath it.
  const kidsOf = (id) => b.categories.filter((c) => c.parent_id === id);
  const shape = (c, isSub) => {
    const kids = isSub ? [] : kidsOf(c.id);
    const allocated = kids.length
      ? kids.reduce((n, k) => n + k.allocated, 0)
      : c.allocated;
    const spent = (spend[c.id] || 0) + kids.reduce((n, k) => n + (spend[k.id] || 0), 0);
    return {
      ...c, allocated, spent, isSub,
      remaining: allocated - spent,
      pct: allocated > 0 ? Math.min(100, (spent / allocated) * 100) : (spent > 0 ? 100 : 0),
      over: spent > allocated,
    };
  };

  const out = [];
  for (const p of b.categories.filter((c) => !c.parent_id)) {
    out.push(shape(p, false));
    for (const k of kidsOf(p.id)) out.push(shape(k, true));
  }
  return out;
}

// Flat list for the spend form's dropdown, grouped by parent.
// rates maps a currency code to budget-currency units per 1 unit of it, e.g. a
// PEN budget: { NZD: 2.20, USD: 3.34 }. default_rate is the pre-map fallback.
// Offer the budget currency first, then anything the admin set a rate for.
function currencyChoices(b) {
  const out = [b.currency];
  for (const c of Object.keys((b && b.rates) || {})) if (!out.includes(c)) out.push(c);
  for (const c of [b.base_currency || 'NZD', 'USD', 'EUR']) if (!out.includes(c)) out.push(c);
  return out;
}

function planningRate(b, currency) {
  if (!b || currency === b.currency) return 1;
  const r = b.rates && b.rates[currency];
  if (Number.isFinite(Number(r)) && Number(r) > 0) return Number(r);
  // Only fall back when the legacy single rate was actually meant for this
  // currency — otherwise leave it blank and make the instructor enter one.
  if (currency === (b.base_currency || 'NZD') && Number(b.default_rate) > 0) {
    return Number(b.default_rate);
  }
  return null;
}

function categoryOptions(selectedId) {
  const b = budget();
  if (!b) return '';
  const parents = b.categories.filter((c) => !c.parent_id);
  return parents.map((p) => {
    const kids = b.categories.filter((c) => c.parent_id === p.id);
    const opt = (c, label) =>
      `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${label}</option>`;
    if (!kids.length) return opt(p, p.name);
    // A parent with subcategories holds no allocation of its own, so logging
    // straight to it would always read as unbudgeted. Only the leaves are
    // selectable.
    return `<optgroup label="${p.name}">${kids.map((k) => opt(k, k.name)).join('')}</optgroup>`;
  }).join('');
}

function cashFloat() {
  const byCur = {};
  for (const e of budgetEntries()) {
    const add = (cur, amt) => { byCur[cur] = (byCur[cur] || 0) + amt; };
    if (e.entry_type === 'withdrawal' || e.entry_type === 'exchange' || e.entry_type === 'transfer') {
      add(e.currency, e.amount); // signed: cash in positive, cash out negative
    } else if (e.entry_type === 'expense' && e.payment_method === 'cash') {
      add(e.currency, -e.amount);
    }
  }
  return Object.entries(byCur)
    .filter(([, amt]) => amt !== 0)
    .map(([currency, amount]) => ({ currency, amount }));
}

/* ---------------- sync ---------------- */

async function refreshFromServer() {
  const res = await fetch(`${API}/me`, {
    credentials: 'include', headers: { accept: 'application/json' },
  });
  if (res.status === 401) { showSignIn(); throw new Error('signed_out'); }
  if (!res.ok) throw new Error(`me ${res.status}`);
  const data = await res.json();
  state.email = data.email;
  state.budgets = data.budgets || [];
  await putMeta('budgets', state.budgets);
  await putMeta('email', state.email);
  for (const e of data.entries || []) await putEntry({ ...e, pending: 0 });
}

async function pushOutbox() {
  const local = await allEntries();
  const pending = local.filter((e) => e.pending === 1);
  if (!pending.length) return { pushed: 0 };

  // Receipts go first and separately, so a stuck photo never holds up the ledger.
  for (const e of pending) {
    if (!e.receipt_key || e.receipt_uploaded) continue;
    try {
      const blob = await getReceipt(e.receipt_key);
      if (!blob) { await putEntry({ ...e, receipt_uploaded: true }); continue; }
      const r = await fetch(
        `${API}/receipts/${encodeURIComponent(e.id)}?budget=${encodeURIComponent(e.budget_id)}`,
        { method: 'PUT', credentials: 'include',
          headers: { 'content-type': blob.type || 'image/jpeg' }, body: blob }
      );
      if (r.ok) {
        const { file_id, link } = await r.json();
        e.receipt_file_id = file_id; e.receipt_link = link; e.receipt_uploaded = true;
        await putEntry(e);
      }
    } catch { /* try again next sync */ }
  }

  const payload = pending.map(({ pending: _p, receipt_uploaded: _r, receipt_key: _k, ...rest }) => rest);
  const res = await fetch(`${API}/sync`, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: payload }),
  });
  if (!res.ok) throw new Error(`sync ${res.status}`);
  const { accepted = [] } = await res.json();
  for (const id of accepted) {
    const e = pending.find((x) => x.id === id);
    if (e) await putEntry({ ...e, pending: 0 });
  }
  return { pushed: accepted.length };
}

let syncing = false;
async function sync({ quiet = false } = {}) {
  if (syncing) return;
  syncing = true;
  try {
    await pushOutbox();
    await refreshFromServer();
    state.entries = await allEntries();
    await putMeta('lastSync', new Date().toISOString());
    state.online = true;
    if (!quiet) toast('Up to date');
  } catch {
    state.online = false;
    if (!quiet) toast('No connection — saved on this device');
  } finally {
    syncing = false;
    render();
  }
}

/* ---------------- render ---------------- */

const view = document.getElementById('view');
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

function render() {
  if (!Array.isArray(state.budgets)) state.budgets = [];
  if (!Array.isArray(state.entries)) state.entries = [];
  const b = budget();
  const pendingCount = state.entries.filter((e) => e.pending === 1).length;

  document.getElementById('budgetName').textContent = b ? b.name : 'No budget assigned';
  document.getElementById('budgetSub').textContent = b ? `${b.currency} · ${state.email || ''}` : (state.email || '');

  const chip = document.getElementById('syncChip');
  if (pendingCount) { chip.textContent = `${pendingCount} to sync`; chip.dataset.state = 'pending'; }
  else if (!state.online) { chip.textContent = 'Offline'; chip.dataset.state = 'offline'; }
  else { chip.textContent = 'Synced'; chip.dataset.state = 'ok'; }

  view.innerHTML = '';

  if (!b) {
    view.append(el(`<div class="empty">No budgets are assigned to this address yet. Ask your programme director to add <strong>${state.email || 'your email'}</strong> to the programme budget.</div>`));
    return;
  }

  if (state.budgets.length > 1) {
    const picker = el('<div class="section-head"><h2>Budget</h2></div>');
    view.append(picker);
    const sel = el('<select id="budgetPicker"></select>');
    for (const bb of state.budgets) {
      const o = document.createElement('option');
      o.value = bb.id; o.textContent = `${bb.name} · ${bb.currency}`;
      o.selected = bb.id === state.budgetId;
      sel.append(o);
    }
    sel.addEventListener('change', async () => {
      state.budgetId = sel.value; await putMeta('budgetId', sel.value); render();
    });
    view.append(sel);
  }

  const cats = categoryBalances();
  // Parents already include their children, so sum top level only.
  const totalLeft = cats.filter((c) => !c.isSub).reduce((n, c) => n + c.remaining, 0);
  view.append(el(`<div class="section-head"><h2>Remaining</h2><span class="num">${fmt(totalLeft, b.currency)} left</span></div>`));

  const list = el('<div class="gauge-list"></div>');
  for (const c of cats) {
    const g = el(`
      <button class="gauge ${c.isSub ? 'sub' : ''} ${c.over ? 'over' : ''}" type="button">
        <span class="gauge-top">
          <span class="gauge-name">${c.name}</span>
          <span class="gauge-left num">${fmt(c.remaining, b.currency)}</span>
        </span>
        <span class="gauge-meta num">${fmt(c.spent, b.currency)} of ${fmt(c.allocated, b.currency)} spent</span>
        <span class="gauge-track"><span class="gauge-fill" style="width:${c.pct}%"></span></span>
      </button>`);
    g.addEventListener('click', () => openSpend(c.id));
    list.append(g);
  }
  view.append(list);

  const floats = cashFloat();
  view.append(el(`<div class="section-head"><h2>Cash on hand</h2><span>${state.email ? 'yours' : ''}</span></div>`));
  if (!floats.length) {
    view.append(el('<div class="empty">No cash recorded. Log a withdrawal or exchange when you draw money.</div>'));
  } else {
    for (const f of floats) {
      view.append(el(`<div class="float-row"><span class="float-cur">${f.currency}</span><span class="float-amt num ${f.amount < 0 ? 'negative' : ''}">${fmt(f.amount, f.currency)}</span></div>`));
    }
  }
}

/* ---------------- sheet ---------------- */

const sheet = document.getElementById('sheet');
const sheetBody = document.getElementById('sheetBody');
const scrim = document.getElementById('scrim');

function openSheet(html) {
  sheetBody.innerHTML = '';
  sheetBody.append(html);
  sheet.hidden = false; scrim.hidden = false;
}
function closeSheet() { sheet.hidden = true; scrim.hidden = true; }
scrim.addEventListener('click', closeSheet);

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

const today = () => new Date().toISOString().slice(0, 10);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/* Shrink before queueing: a 4MB phone photo will never clear a 3G uplink in Cuyabeno. */
async function compress(file, max = 1200, quality = 0.72) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
}

function openSpend(categoryId) {
  const b = budget();
  if (!b) return;
  const cats = categoryBalances();
  const form = el(`
    <div>
      <h2>Log spend</h2>
      <label for="amt">Amount</label>
      <input class="amount-input num" id="amt" type="number" inputmode="decimal" step="0.01" placeholder="0.00">
      <div class="field-row">
        <div>
          <label for="cur">Currency</label>
          <select id="cur">
            ${currencyChoices(b).map((c) => `<option ${c === b.currency ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div>
          <label for="cat">Category</label>
          <select id="cat">${categoryOptions(categoryId)}</select>
        </div>
      </div>
      <div id="rateWrap" hidden>
        <label for="rate">Rate — ${b.currency} per 1 unit</label>
        <input class="num" id="rate" type="number" inputmode="decimal" step="0.0001" value="${b.default_rate || 1}">
        <p class="hint" id="rateHint"></p>
      </div>
      <label>Paid with</label>
      <div class="seg" id="method">
        <button type="button" data-v="cash" aria-pressed="true">Cash</button>
        <button type="button" data-v="card" aria-pressed="false">Card</button>
      </div>
      <label for="desc">What was it</label>
      <input id="desc" type="text" placeholder="Group lunch, Marita Restaurant" autocomplete="off">
      <label for="date">Date</label>
      <input id="date" type="date" value="${today()}">
      <label>Receipt</label>
      <div class="receipt">
        <img id="thumb" hidden alt="">
        <button class="receipt-btn" type="button" id="snap">Take a photo</button>
      </div>
      <input id="file" type="file" accept="image/*" capture="environment" hidden>
      <p class="error" id="err" hidden></p>
      <button class="submit" type="button" id="save">Save spend</button>
      <button class="ghost" type="button" id="cancel">Cancel</button>
    </div>`);

  let method = 'cash';
  let receiptBlob = null;

  const amt = form.querySelector('#amt');
  const cur = form.querySelector('#cur');
  const rateWrap = form.querySelector('#rateWrap');
  const rate = form.querySelector('#rate');
  const rateHint = form.querySelector('#rateHint');
  const err = form.querySelector('#err');

  let wasForeign = false;
  function saveLabel(conv, foreign) {
    const btn = form.querySelector('#save');
    if (!btn) return;
    // Put the converted figure on the button. A wrong rate then has to get past
    // your eyes on the way to being saved, instead of failing silently.
    btn.textContent = foreign && conv > 0
      ? `Save ${conv.toFixed(2)} ${b.currency}`
      : 'Save spend';
  }
  function updateRate() {
    const foreign = cur.value !== b.currency;
    rateWrap.hidden = !foreign;
    if (!foreign) {
      rate.value = 1; rateHint.textContent = ''; wasForeign = false;
      saveLabel(0, false); return;
    }
    // Entering a foreign currency: fill in the planning rate for THAT currency.
    // A single per-budget rate could only ever be right for one of them.
    if (!wasForeign || rate.dataset.forCur !== cur.value) {
      rate.value = planningRate(b, cur.value) || '';
      rate.dataset.forCur = cur.value;
    }
    wasForeign = true;
    const a = Number(amt.value) || 0;
    const conv = a * (Number(rate.value) || 0);
    rateHint.innerHTML = conv > 0
      ? `Counts against the budget as <strong>${conv.toFixed(2)} ${b.currency}</strong>. Card rates differ from this; reconciliation will catch it.`
      : `Enter the rate in ${b.currency} per 1 ${cur.value}.`;
    saveLabel(conv, true);
  }
  cur.addEventListener('change', updateRate);
  rate.addEventListener('input', updateRate);
  amt.addEventListener('input', updateRate);

  form.querySelector('#method').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-v]');
    if (!btn) return;
    method = btn.dataset.v;
    form.querySelectorAll('#method button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
  });

  const file = form.querySelector('#file');
  form.querySelector('#snap').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    receiptBlob = await compress(file.files[0]);
    const thumb = form.querySelector('#thumb');
    thumb.src = URL.createObjectURL(receiptBlob); thumb.hidden = false;
    form.querySelector('#snap').textContent = 'Retake photo';
  });

  form.querySelector('#cancel').addEventListener('click', closeSheet);
  form.querySelector('#save').addEventListener('click', async () => {
    const value = Number(amt.value);
    if (!value || value <= 0) {
      err.textContent = 'Enter an amount first.'; err.hidden = false; amt.focus(); return;
    }
    err.hidden = true;

    const currency = cur.value;
    const r = currency === b.currency ? 1 : (Number(rate.value) || 0);
    if (!r || r < 0) {
      err.textContent = `Enter the rate in ${b.currency} per 1 ${currency}.`;
      err.hidden = false; rate.focus(); return;
    }

    const id = uuid();
    let receipt_key = null;
    if (receiptBlob) {
      receipt_key = `${b.id}/${id}.jpg`;
      await putReceipt(receipt_key, receiptBlob);
    }

    const amountMinor = toMinor(value, currency);
    await putEntry({
      id, budget_id: b.id, category_id: form.querySelector('#cat').value,
      email: state.email, entry_type: 'expense', group_id: null,
      spent_on: form.querySelector('#date').value,
      amount: amountMinor, currency, rate: r,
      budget_amount: Math.round(amountMinor * r * (minor(b.currency) / minor(currency))),
      payment_method: method,
      description: form.querySelector('#desc').value.trim(),
      receipt_key, corrects_id: null,
      created_at: new Date().toISOString(), pending: 1,
    });

    state.entries = await allEntries();
    closeSheet(); render(); toast('Saved');
    if (navigator.onLine) sync({ quiet: true });
  });

  updateRate();
  openSheet(form);
  setTimeout(() => amt.focus(), 60);
}

function openCash() {
  const b = budget();
  if (!b) return;
  const form = el(`
    <div>
      <h2>Cash movement</h2>
      <label>What happened</label>
      <div class="seg" id="kind">
        <button type="button" data-v="withdrawal" aria-pressed="true">Withdrew</button>
        <button type="button" data-v="exchange" aria-pressed="false">Exchanged</button>
      </div>
      <div id="wd">
        <label for="wamt">Amount received</label>
        <input class="amount-input num" id="wamt" type="number" inputmode="decimal" step="0.01" placeholder="0.00">
        <label for="wcur">Currency</label>
        <select id="wcur">${currencyChoices(b).map((c) => `<option ${c === b.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <div id="ex" hidden>
        <label for="xout">Gave</label>
        <div class="field-row">
          <div><input class="num" id="xout" type="number" inputmode="decimal" step="0.01" placeholder="0.00"></div>
          <div><select id="xoutcur">${currencyChoices(b).map((c) => `<option ${c === (b.base_currency || 'USD') ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        </div>
        <label for="xin">Received</label>
        <div class="field-row">
          <div><input class="num" id="xin" type="number" inputmode="decimal" step="0.01" placeholder="0.00"></div>
          <div><select id="xincur">${currencyChoices(b).map((c) => `<option ${c === b.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        </div>
        <p class="hint" id="xhint"></p>
      </div>
      <label for="cdesc">Note</label>
      <input id="cdesc" type="text" placeholder="ATM, Banco Pichincha, Baños">
      <label for="cdate">Date</label>
      <input id="cdate" type="date" value="${today()}">
      <p class="hint">The NZD cost gets attached later from the statement — you don't need it here.</p>
      <p class="error" id="cerr" hidden></p>
      <button class="submit" type="button" id="csave">Save</button>
      <button class="ghost" type="button" id="ccancel">Cancel</button>
    </div>`);

  let kind = 'withdrawal';
  const xhint = form.querySelector('#xhint');
  const recalc = () => {
    const out = Number(form.querySelector('#xout').value) || 0;
    const inn = Number(form.querySelector('#xin').value) || 0;
    xhint.textContent = out && inn ? `Rate ${(inn / out).toFixed(4)}` : '';
  };
  form.querySelector('#xout').addEventListener('input', recalc);
  form.querySelector('#xin').addEventListener('input', recalc);

  form.querySelector('#kind').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-v]');
    if (!btn) return;
    kind = btn.dataset.v;
    form.querySelectorAll('#kind button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
    form.querySelector('#wd').hidden = kind !== 'withdrawal';
    form.querySelector('#ex').hidden = kind !== 'exchange';
  });

  form.querySelector('#ccancel').addEventListener('click', closeSheet);
  form.querySelector('#csave').addEventListener('click', async () => {
    const cerr = form.querySelector('#cerr');
    const desc = form.querySelector('#cdesc').value.trim();
    const date = form.querySelector('#cdate').value;
    const base = { budget_id: b.id, category_id: null, email: state.email, spent_on: date,
                   payment_method: 'cash', description: desc, receipt_key: null,
                   corrects_id: null, created_at: new Date().toISOString(), pending: 1 };

    if (kind === 'withdrawal') {
      const v = Number(form.querySelector('#wamt').value);
      if (!v || v <= 0) { cerr.textContent = 'Enter how much you received.'; cerr.hidden = false; return; }
      const currency = form.querySelector('#wcur').value;
      await putEntry({ ...base, id: uuid(), entry_type: 'withdrawal', group_id: null,
        amount: toMinor(v, currency), currency, rate: 1, budget_amount: 0 });
    } else {
      const out = Number(form.querySelector('#xout').value);
      const inn = Number(form.querySelector('#xin').value);
      if (!out || !inn) { cerr.textContent = 'Enter both amounts.'; cerr.hidden = false; return; }
      const outCur = form.querySelector('#xoutcur').value;
      const inCur = form.querySelector('#xincur').value;
      const group = uuid();
      // Two rows, one group: −2,700 USD and +9,004.50 PEN. Exactly the row your sheet already had.
      await putEntry({ ...base, id: uuid(), entry_type: 'exchange', group_id: group,
        amount: -toMinor(out, outCur), currency: outCur, rate: 1, budget_amount: 0 });
      await putEntry({ ...base, id: uuid(), entry_type: 'exchange', group_id: group,
        amount: toMinor(inn, inCur), currency: inCur, rate: 1, budget_amount: 0 });
    }

    state.entries = await allEntries();
    closeSheet(); render(); toast('Saved');
    if (navigator.onLine) sync({ quiet: true });
  });

  openSheet(form);
}

function openHistory() {
  const b = budget();
  const rows = budgetEntries()
    .slice().sort((a, c) => (c.spent_on + c.created_at).localeCompare(a.spent_on + a.created_at))
    .slice(0, 80);
  const wrap = el('<div><h2>Recent entries</h2></div>');
  if (!rows.length) {
    wrap.append(el('<div class="empty">Nothing logged yet.</div>'));
  }
  for (const e of rows) {
    const cat = b.categories.find((c) => c.id === e.category_id);
    const label = e.entry_type === 'expense' ? (cat ? cat.name : 'Spend')
      : e.entry_type === 'withdrawal' ? 'Cash withdrawn' : 'Exchange';
    wrap.append(el(`
      <div class="entry">
        <div class="entry-main">
          <span class="entry-desc">${e.description || label}</span>
          <span class="entry-meta"><span class="dot ${e.pending ? 'pending' : ''}"></span>${e.spent_on} · ${label}${e.payment_method === 'card' ? ' · card' : ''}</span>
        </div>
        <span class="entry-amt num">${fmt(e.amount, e.currency, { sign: e.entry_type !== 'expense' })}</span>
      </div>`));
  }
  wrap.append(el('<button class="ghost" type="button" id="hclose">Close</button>'));
  wrap.querySelector('#hclose').addEventListener('click', closeSheet);
  openSheet(wrap);
}

/* ---------------- wiring ---------------- */

document.querySelector('.dock').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-open]');
  if (!btn) return;
  if (btn.dataset.open === 'spend') openSpend(budget()?.categories?.[0]?.id);
  if (btn.dataset.open === 'cash') openCash();
  if (btn.dataset.open === 'history') openHistory();
});

document.getElementById('syncChip').addEventListener('click', () => sync());
window.addEventListener('online', () => { state.online = true; sync({ quiet: true }); });
window.addEventListener('offline', () => { state.online = false; render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) sync({ quiet: true }); });

/* ---------------- sign-in ----------------
   Two paths that converge on the same session cookie: Google Identity Services,
   and an emailed one-time link for anyone without a usable Google account. */

let signInShown = false;

function showSignIn() {
  if (signInShown) return;
  signInShown = true;
  document.body.classList.add('signed-out');
  document.getElementById('signin').hidden = false;

  const params = new URLSearchParams(location.search);
  const msg = document.getElementById('signinMsg');
  if (params.get('auth') === 'expired') {
    msg.textContent = 'That link had already been used or expired. Send another.';
  }

  wireMagicLink();
  loadGoogle();
}

function hideSignIn() {
  signInShown = false;
  document.body.classList.remove('signed-out');
  document.getElementById('signin').hidden = true;
}

function wireMagicLink() {
  const btn = document.getElementById('magicSend');
  const input = document.getElementById('magicEmail');
  const msg = document.getElementById('signinMsg');
  if (btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', async () => {
    const email = input.value.trim();
    if (!email.includes('@')) { msg.textContent = 'Enter your email address.'; return; }
    btn.disabled = true; msg.textContent = 'Sending…';
    try {
      await fetch(`${API}/auth/magic-link`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      // Deliberately the same message whether or not the address is known — the
      // response never confirms who has an account.
      msg.textContent = 'Check your email for a sign-in link. It expires in 20 minutes.';
    } catch {
      msg.textContent = 'Could not send right now. Check your connection.';
    } finally {
      btn.disabled = false;
    }
  });
}

// When Google is unavailable, take the divider with it — otherwise the screen
// reads as a broken button rather than an email-only sign-in.
function hideGoogle(reason) {
  document.getElementById('gbtn').hidden = true;
  document.querySelector('.signin-or').hidden = true;
  if (reason) console.warn(`Google sign-in unavailable (${reason})`);
}

async function loadGoogle() {
  const target = document.getElementById('gbtn');
  let clientId = null;
  try {
    const res = await fetch(`${API}/auth/config`, { credentials: 'include' });
    ({ google_client_id: clientId } = await res.json());
  } catch { /* offline: the magic-link path is still visible */ }
  if (!clientId) { hideGoogle('config'); return; }

  await new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client';
    sc.async = true; sc.onload = resolve; sc.onerror = reject;
    document.head.append(sc);
  }).catch(() => { hideGoogle('script'); });

  if (!window.google?.accounts?.id) { hideGoogle('script'); return; }
  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: async ({ credential }) => {
      const msg = document.getElementById('signinMsg');
      msg.textContent = 'Signing in…';
      const res = await fetch(`${API}/auth/google`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential }),
      });
      if (res.ok) { hideSignIn(); await boot(); return; }
      const err = await res.json().catch(() => ({}));
      if (err.error === 'not_assigned') {
        msg.textContent = `No budgets are assigned to ${err.email}. Ask your programme director to add that address.`;
      } else if (res.status >= 500) {
        // A 500 here is a configuration problem, not the instructor's fault.
        // Showing the real message beats a shrug that sends them to a path that
        // is probably broken for the same reason.
        msg.textContent = `Sign-in is misconfigured: ${err.error || res.status}`;
      } else {
        msg.textContent = 'That sign-in did not work. Try the email link instead.';
      }
      console.error('google sign-in failed', res.status, err);
    },
  });
  window.google.accounts.id.renderButton(target, {
    theme: 'outline', size: 'large', width: 320, text: 'signin_with',
  });
}

async function boot() {
  const cached = await getMeta('budgets');
  state.budgets = Array.isArray(cached) ? cached : [];
  state.email = (await getMeta('email')) || null;
  state.entries = await allEntries();
  state.budgetId = (await getMeta('budgetId')) || state.budgets[0]?.id || null;
  render();

  try {
    await sync({ quiet: true });
  } catch { /* offline boot is fine, we render from cache */ }

  const demoAllowed = location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || new URLSearchParams(location.search).has('demo');
  if (!state.budgets.length && demoAllowed) await seedDemo();
  if (!state.budgetId) { state.budgetId = state.budgets[0]?.id || null; render(); }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* Demo seed for local work and for showing the app before any budget exists.
   Only runs on localhost or with ?demo=1 — never in production, so nobody sees a
   phantom budget instead of the correct empty state. */
async function seedDemo() {
  state.email = state.email || 'instructor@pacificdiscovery.org';
  state.budgets = [{
    id: 'bud_peru_2026', name: 'Peru — Feb 2026', currency: 'PEN',
    base_currency: 'NZD', default_rate: 3.34,
    categories: [
      { id: 'cat_food', name: 'Food', allocated: 1448880 },
      { id: 'cat_transport', name: 'Transport', allocated: 14000 },
      { id: 'cat_gratuity', name: 'Gratuities', allocated: 150000 },
      { id: 'cat_activity', name: 'Activities', allocated: 192970 },
      { id: 'cat_misc', name: 'Misc', allocated: 50000 },
      { id: 'cat_firstaid', name: 'First aid', allocated: 16800 },
    ],
  }];
  state.budgetId = 'bud_peru_2026';
  await putMeta('budgets', state.budgets);
  await putMeta('email', state.email);
  render();
}

boot();
