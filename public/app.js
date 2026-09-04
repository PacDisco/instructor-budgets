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
const delEntry = (id) => tx('entries', 'readwrite', (s) => s.delete(id));
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

// Level 1 is a programme leg and carries the currency; levels 2 and 3 are
// categories and subcategories. Allocation lives on leaves, recursively: a node
// with children is the sum of its children, one without holds its own figure.
function categoryTree() {
  const b = budget();
  if (!b) return [];
  const spend = {};
  for (const e of budgetEntries()) {
    if (e.entry_type !== 'expense' && e.entry_type !== 'correction') continue;
    if (!e.category_id) continue;
    spend[e.category_id] = (spend[e.category_id] || 0) + e.budget_amount;
  }
  const kidsOf = (id) => b.categories.filter((c) => c.parent_id === id);

  const shape = (c, depth, leg) => {
    const self = leg || c;                    // depth 1 is its own leg
    const kids = kidsOf(c.id).map((k) => shape(k, depth + 1, self));
    const allocated = kids.length
      ? kids.reduce((n, k) => n + k.allocated, 0)
      : (c.allocated || 0);
    const spent = (spend[c.id] || 0) + kids.reduce((n, k) => n + k.spent, 0);
    return {
      ...c, depth, kids, allocated, spent,
      currency: self.currency,
      remaining: allocated - spent,
      pct: allocated > 0 ? Math.min(100, (spent / allocated) * 100) : (spent > 0 ? 100 : 0),
      over: spent > allocated,
    };
  };
  return b.categories.filter((c) => !c.parent_id).map((leg) => shape(leg, 1, null));
}

// Flattened for rendering, depth preserved so each row can be indented.
function categoryRows() {
  const out = [];
  const walk = (n) => { out.push(n); n.kids.forEach(walk); };
  categoryTree().forEach(walk);
  return out;
}

// Which leg a category belongs to — the conversion target for anything logged
// against it, and where its rates live.
function legOf(categoryId) {
  const b = budget();
  if (!b) return null;
  const byId = Object.fromEntries(b.categories.map((c) => [c.id, c]));
  let node = byId[categoryId];
  let guard = 0;
  while (node && node.parent_id && guard++ < 5) node = byId[node.parent_id];
  return node || null;
}

// The first leaf, used when the dock's "Log spend" button opens the form with
// nothing selected.
function firstLeafId() {
  const rows = categoryRows();
  const leaf = rows.find((r) => r.depth > 1 && !r.kids.length);
  return leaf ? leaf.id : null;
}

// Offer the leg's own currency first, then anything the admin set a rate for.
function currencyChoices(leg) {
  const b = budget();
  const out = leg && leg.currency ? [leg.currency] : [];
  for (const c of Object.keys((leg && leg.rates) || {})) if (!out.includes(c)) out.push(c);
  for (const c of [(b && b.base_currency) || 'NZD', 'USD']) if (!out.includes(c)) out.push(c);
  return out;
}

// A leg's rates map is LEG-currency units per 1 unit of the given currency.
// Returns null when there is no rate, so the field stays blank rather than
// prefilling something plausible but wrong.
// Cash can be held in any leg's currency plus the base — a Peru/Ecuador
// programme means PEN, USD and NZD all plausibly in a pocket.
function cashCurrencies(b) {
  const out = [];
  for (const l of (b ? b.categories.filter((c) => !c.parent_id) : [])) {
    if (l.currency && !out.includes(l.currency)) out.push(l.currency);
    for (const c of Object.keys(l.rates || {})) if (!out.includes(c)) out.push(c);
  }
  for (const c of [(b && b.base_currency) || 'NZD', 'USD']) if (!out.includes(c)) out.push(c);
  return out;
}

function planningRate(leg, currency) {
  if (!leg || currency === leg.currency) return 1;
  const r = Number((leg.rates || {})[currency]);
  return Number.isFinite(r) && r > 0 ? r : null;
}

function categoryOptions(selectedId) {
  // <optgroup> cannot nest, so three levels render as indented flat options
  // grouped by leg. Only leaves are selectable: a node with children holds no
  // allocation, so logging to it would always read as unbudgeted.
  const NB = '\u00a0';
  return categoryTree().map((leg) => {
    const opts = [];
    const walk = (n, depth) => {
      const pad = NB.repeat(Math.max(0, (depth - 2) * 3));
      if (!n.kids.length) {
        opts.push(`<option value="${n.id}" ${n.id === selectedId ? 'selected' : ''}>${pad}${n.name}</option>`);
      } else {
        opts.push(`<option disabled>${pad}${n.name}</option>`);
        n.kids.forEach((k) => walk(k, depth + 1));
      }
    };
    leg.kids.forEach((k) => walk(k, 2));
    if (!opts.length) return '';
    return `<optgroup label="${leg.name} (${leg.currency || '\u2014'})">${opts.join('')}</optgroup>`;
  }).join('');
}

// An entry is void once a correction points at it. Corrections are how the
// append-only ledger handles an edit: nothing is ever mutated, so sync stays a
// plain insert-or-ignore and finance keeps the full history.
function voidedIds() {
  const out = new Set();
  for (const e of budgetEntries()) {
    if (e.entry_type === 'correction' && e.corrects_id) out.add(e.corrects_id);
  }
  return out;
}

function cashFloat() {
  const byCur = {};
  for (const e of budgetEntries()) {
    const add = (cur, amt) => { byCur[cur] = (byCur[cur] || 0) + amt; };
    if (e.entry_type === 'withdrawal' || e.entry_type === 'exchange' || e.entry_type === 'transfer') {
      add(e.currency, e.amount); // signed: cash in positive, cash out negative
    } else if ((e.entry_type === 'expense' || e.entry_type === 'correction')
               && e.payment_method === 'cash') {
      // A correction carries a negated amount, so this adds the cash back.
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
      // Receipts upload before the ledger does, so the server can't look up what
      // this entry was for. Send a note it can name the file with. A header
      // rather than a query string: URLs get logged, and this is the
      // instructor's own free text.
      const r = await fetch(
        `${API}/receipts/${encodeURIComponent(e.id)}?budget=${encodeURIComponent(e.budget_id)}`,
        { method: 'PUT', credentials: 'include',
          headers: {
            'content-type': blob.type || 'image/jpeg',
            'x-receipt-note': receiptNote(e),
          },
          body: blob }
      );
      if (r.ok) {
        const { file_id, link } = await r.json();
        e.receipt_file_id = file_id; e.receipt_link = link;
        e.receipt_uploaded = true; delete e.receipt_error;
        await putEntry(e);
      } else {
        // Record why. A bare catch here meant a misconfigured Drive looked
        // exactly like a slow connection, forever.
        const body = await r.json().catch(() => ({}));
        e.receipt_error = body.error || `Upload failed (${r.status})`;
        await putEntry(e);
        console.error('receipt upload failed', r.status, body);
      }
    } catch (err) {
      e.receipt_error = 'No connection while uploading the photo';
      await putEntry(e);
    }
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

// Base64 so accented descriptions survive — header values must be ASCII, and
// "Almuerzo Pisonay Calca" is more likely than not in Peru.
function receiptNote(e) {
  const b = state.budgets.find((x) => x.id === e.budget_id);
  const cat = b && b.categories.find((c) => c.id === e.category_id);
  const parts = [
    e.spent_on,
    cat ? cat.name : null,
    e.description || null,
    `${e.currency} ${(e.amount / minor(e.currency)).toFixed(2)}`,
    (e.email || '').split('@')[0] || null,
  ].filter(Boolean);
  try {
    return btoa(String.fromCharCode(...new TextEncoder().encode(parts.join(' - '))));
  } catch {
    return '';
  }
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

const $ = (id) => document.getElementById(id);
const view = document.getElementById('view');
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

function render() {
  if (!Array.isArray(state.budgets)) state.budgets = [];
  if (!Array.isArray(state.entries)) state.entries = [];
  const b = budget();
  const pendingCount = state.entries.filter((e) => e.pending === 1).length;

  document.getElementById('budgetName').textContent = b ? b.name : 'No budget assigned';
  const legList = b ? b.categories.filter((c) => !c.parent_id).map((l) => l.currency).filter(Boolean) : [];
  document.getElementById('budgetSub').textContent = b
    ? `${[...new Set(legList)].join(', ') || 'no legs'} · ${state.email || ''}`
    : (state.email || '');

  const receiptErrors = state.entries.filter((e) => e.receipt_error && !e.receipt_uploaded).length;
  const chip = document.getElementById('syncChip');
  if (receiptErrors) {
    chip.textContent = `${receiptErrors} photo${receiptErrors === 1 ? '' : 's'} stuck`;
    chip.dataset.state = 'offline';
  } else if (pendingCount) { chip.textContent = `${pendingCount} to sync`; chip.dataset.state = 'pending'; }
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
      const curs = [...new Set(bb.categories.filter((c) => !c.parent_id).map((c) => c.currency).filter(Boolean))];
      o.value = bb.id; o.textContent = `${bb.name}${curs.length ? ` · ${curs.join(', ')}` : ''}`;
      o.selected = bb.id === state.budgetId;
      sel.append(o);
    }
    sel.addEventListener('change', async () => {
      state.budgetId = sel.value; await putMeta('budgetId', sel.value); render();
    });
    view.append(sel);
  }

  const base = b.base_currency || 'NZD';
  const tree = categoryTree();

  for (const leg of tree) {
    // Each leg has its own currency, so a single combined total would be
    // meaningless. The base-currency figure sits alongside for reporting.
    const nzd = leg.currency === base
      ? leg.remaining
      : (planningRate(leg, base) ? Math.round(leg.remaining / planningRate(leg, base)) : null);

    view.append(el(`<div class="section-head">
        <h2>${leg.name}</h2>
        <span class="num">${fmt(leg.remaining, leg.currency)} left${
          nzd !== null && leg.currency !== base ? ` · ≈ ${fmt(nzd, base)}` : ''}</span>
      </div>`));

    const list = el('<div class="gauge-list"></div>');
    const walk = (n) => {
      const leaf = !n.kids.length;
      const g = el(`
        <button class="gauge d${n.depth} ${n.over ? 'over' : ''}" type="button" ${leaf ? '' : 'data-parent="1"'}>
          <span class="gauge-top">
            <span class="gauge-name">${n.name}</span>
            <span class="gauge-left num">${fmt(n.remaining, n.currency)}</span>
          </span>
          <span class="gauge-meta num">${fmt(n.spent, n.currency)} of ${fmt(n.allocated, n.currency)} spent</span>
          <span class="gauge-track"><span class="gauge-fill" style="width:${n.pct}%"></span></span>
        </button>`);
      // Only leaves can be logged against; tapping a roll-up opens the form on
      // its first leaf rather than doing nothing.
      g.addEventListener('click', () => {
        if (leaf) return openSpend(n.id);
        const firstLeaf = (function dig(x) {
          return x.kids.length ? dig(x.kids[0]) : x;
        })(n);
        openSpend(firstLeaf.id);
      });
      list.append(g);
      n.kids.forEach(walk);
    };
    leg.kids.forEach(walk);
    if (!leg.kids.length) {
      list.append(el('<div class="empty">No categories in this leg yet.</div>'));
    }
    view.append(list);
  }

  if (!tree.length) {
    view.append(el('<div class="empty">This budget has no legs set up yet.</div>'));
  }

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

/* Shrink before queueing: a 4MB phone photo will never clear a 3G uplink in
   Cuyabeno. But a receipt is a document, not a snapshot — the whole point is
   being able to read the total and the date months later, so this is tuned for
   text legibility rather than the smallest possible file.

   1600px puts a receipt filling half the frame at roughly 23px line height,
   which is comfortably readable and viable for OCR. 1200px gave 17px: fine at a
   glance, poor for small print. The cost is roughly 250-350KB instead of
   120-180KB, which is a second or two on a bad connection and worth it for a
   record finance has to reconcile against a bank statement. */
const RECEIPT_MAX_PX = 1600;
const RECEIPT_QUALITY = 0.85;

async function compress(file, max = RECEIPT_MAX_PX, quality = RECEIPT_QUALITY) {
  // `imageOrientation: 'from-image'` is required. Without it createImageBitmap
  // ignores the EXIF orientation tag that phones set on portrait photos, and
  // canvas strips EXIF on the way out — so the receipt uploads sideways with no
  // metadata left for anything downstream to correct it.
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await createImageBitmap(file);
  }

  // Already small and modest resolution: keep the original bytes rather than
  // re-encoding, which would only lose detail.
  if (file.size < 350_000 && Math.max(bmp.width, bmp.height) <= max) {
    bmp.close?.();
    return file;
  }

  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();

  return new Promise((resolve) => {
    c.toBlob((blob) => resolve(blob && blob.size < file.size ? blob : file),
             'image/jpeg', quality);
  });
}

function openSpend(categoryId, existing) {
  const b = budget();
  if (!b) return;
  if (!categoryId) categoryId = firstLeafId();
  if (!categoryId) { toast('No categories set up yet'); return; }
  // Currency, rates and the conversion target all come from the leg the chosen
  // category sits under, not from the budget.
  let leg = legOf(categoryId);
  const form = el(`
    <div>
      <h2>${existing ? 'Change spend' : 'Log spend'}</h2>
      <label for="amt">Amount</label>
      <input class="amount-input num" id="amt" type="number" inputmode="decimal" step="0.01" placeholder="0.00">
      <div class="field-row">
        <div>
          <label for="cur">Currency</label>
          <select id="cur">
            ${currencyChoices(leg).map((c) => `<option ${c === (leg && leg.currency) ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div>
          <label for="cat">Category</label>
          <select id="cat">${categoryOptions(categoryId)}</select>
        </div>
      </div>
      <div id="rateWrap" hidden>
        <label for="rate" id="rateLabel">Rate</label>
        <input class="num" id="rate" type="number" inputmode="decimal" step="0.0001">
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
      <button class="submit" type="button" id="save">${existing ? 'Save changes' : 'Save spend'}</button>
      <button class="ghost" type="button" id="cancel">Cancel</button>
    </div>`);

  let method = existing ? existing.payment_method : 'cash';
  let receiptBlob = null;

  const amt = form.querySelector('#amt');
  const cur = form.querySelector('#cur');
  const catSel = form.querySelector('#cat');
  const rateLabel = form.querySelector('#rateLabel');
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
      ? `Save ${conv.toFixed(2)} ${(leg && leg.currency) || ''}`
      : (existing ? 'Save changes' : 'Save spend');
  }
  function updateRate() {
    const legCur = (leg && leg.currency) || '';
    const foreign = cur.value !== legCur;
    rateWrap.hidden = !foreign;
    rateLabel.textContent = `Rate — ${legCur} per 1 unit`;
    if (!foreign) {
      rate.value = 1; rateHint.textContent = ''; wasForeign = false;
      saveLabel(0, false); return;
    }
    // Fill in the planning rate for THAT currency, from the leg's rates map.
    if (!wasForeign || rate.dataset.forCur !== cur.value) {
      rate.value = planningRate(leg, cur.value) || '';
      rate.dataset.forCur = cur.value;
    }
    wasForeign = true;
    const a = Number(amt.value) || 0;
    const conv = a * (Number(rate.value) || 0);
    rateHint.innerHTML = conv > 0
      ? `Counts against ${leg.name} as <strong>${conv.toFixed(2)} ${legCur}</strong>. Card rates differ from this; reconciliation will catch it.`
      : `Enter the rate in ${legCur} per 1 ${cur.value}.`;
    saveLabel(conv, true);
  }
  cur.addEventListener('change', updateRate);
  rate.addEventListener('input', updateRate);
  amt.addEventListener('input', updateRate);

  // Picking a category in a different leg changes the currency and the rates,
  // so the currency list is rebuilt rather than left pointing at the old leg.
  catSel.addEventListener('change', () => {
    const next = legOf(catSel.value);
    if (!next || next.id === (leg && leg.id)) return;
    leg = next;
    cur.innerHTML = currencyChoices(leg)
      .map((c) => `<option ${c === leg.currency ? 'selected' : ''}>${c}</option>`).join('');
    wasForeign = false;
    delete rate.dataset.forCur;
    updateRate();
  });

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
    const legCur = (leg && leg.currency) || currency;
    const r = currency === legCur ? 1 : (Number(rate.value) || 0);
    if (!r || r < 0) {
      err.textContent = `Enter the rate in ${legCur} per 1 ${currency}.`;
      err.hidden = false; rate.focus(); return;
    }

    // An entry that has never synced exists only on this device, so it is
    // rewritten under its own id. Once synced the row is immutable and the
    // change becomes a void plus a replacement.
    const editInPlace = existing && existing.pending === 1;
    const id = editInPlace ? existing.id : uuid();

    let receipt_key = editInPlace ? existing.receipt_key : null;
    if (receiptBlob) {
      receipt_key = `${b.id}/${id}.jpg`;
      await putReceipt(receipt_key, receiptBlob);
    }

    const amountMinor = toMinor(value, currency);
    const groupId = existing && !editInPlace ? uuid() : (editInPlace ? existing.group_id : null);

    const row = {
      id, budget_id: b.id, category_id: form.querySelector('#cat').value,
      email: state.email, entry_type: 'expense', group_id: groupId,
      spent_on: form.querySelector('#date').value,
      amount: amountMinor, currency, rate: r,
      budget_amount: Math.round(amountMinor * r * (minor(legCur) / minor(currency))),
      payment_method: method,
      description: form.querySelector('#desc').value.trim(),
      receipt_key, corrects_id: null,
      created_at: new Date().toISOString(), pending: 1,
    };

    if (existing && !editInPlace) {
      // Carry the original's receipt reference across so the replacement still
      // points at the photo, unless a new one was just taken.
      if (!receiptBlob) {
        row.receipt_file_id = existing.receipt_file_id || null;
        row.receipt_link = existing.receipt_link || null;
        row.receipt_uploaded = true;
      }
      await putEntry(voidOf(existing, groupId));
    }
    await putEntry(row);

    state.entries = await allEntries();
    closeSheet(); render();
    toast(existing ? (editInPlace ? 'Updated' : 'Corrected') : 'Saved');
    if (navigator.onLine) sync({ quiet: true });
  });

  if (existing) {
    amt.value = (existing.amount / minor(existing.currency)).toFixed(2);
    cur.value = existing.currency;
    rate.value = existing.rate;
    rate.dataset.forCur = existing.currency;
    wasForeign = existing.currency !== (leg && leg.currency);
    form.querySelector('#desc').value = existing.description || '';
    form.querySelector('#date').value = existing.spent_on;
    form.querySelectorAll('#method button').forEach((x) =>
      x.setAttribute('aria-pressed', String(x.dataset.v === method)));
    if (existing.receipt_file_id || existing.receipt_key) {
      form.querySelector('#snap').textContent = 'Replace photo';
    }
  }
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
        <select id="wcur">${cashCurrencies(b).map((c) => `<option>${c}</option>`).join('')}</select>
      </div>
      <div id="ex" hidden>
        <label for="xout">Gave</label>
        <div class="field-row">
          <div><input class="num" id="xout" type="number" inputmode="decimal" step="0.01" placeholder="0.00"></div>
          <div><select id="xoutcur">${cashCurrencies(b).map((c) => `<option ${c === (b.base_currency || 'USD') ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        </div>
        <label for="xin">Received</label>
        <div class="field-row">
          <div><input class="num" id="xin" type="number" inputmode="decimal" step="0.01" placeholder="0.00"></div>
          <div><select id="xincur">${cashCurrencies(b).map((c) => `<option>${c}</option>`).join('')}</select></div>
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

/* ---------------- account ----------------
   Tap the header. Instructors hand devices over and phones get reassigned, so
   there has to be a way out that isn't clearing browser data. */

function openAccount() {
  const pending = state.entries.filter((e) => e.pending === 1).length;
  const wrap = el(`
    <div>
      <h2>Account</h2>
      <p class="hint">Signed in as <strong>${state.email || 'unknown'}</strong></p>
      <p class="hint">${state.online ? 'Connected' : 'Offline — entries are saved on this device'}${
        pending ? ` · <strong>${pending} not yet synced</strong>` : ''}</p>
      ${pending ? `<p class="error">Sync before signing out, or those ${pending} entr${
        pending === 1 ? 'y' : 'ies'} stay on this device and nobody else can see them.</p>` : ''}
      ${(() => {
        const stuck = state.entries.filter((e) => e.receipt_error && !e.receipt_uploaded);
        if (!stuck.length) return '';
        return `<p class="error">${stuck.length} receipt photo${stuck.length === 1 ? '' : 's'} could not upload.
          The spending is recorded either way — only the photo is missing.<br>
          <span class="hint">${stuck[stuck.length - 1].receipt_error}</span></p>`;
      })()}
      <button class="submit" type="button" id="aSync">Sync now</button>
      <button class="ghost" type="button" id="aOut">Sign out</button>
      <button class="ghost" type="button" id="aClose">Close</button>
    </div>`);

  wrap.querySelector('#aClose').addEventListener('click', closeSheet);
  wrap.querySelector('#aSync').addEventListener('click', async () => {
    closeSheet();
    await sync();
  });

  wrap.querySelector('#aOut').addEventListener('click', async () => {
    const left = state.entries.filter((e) => e.pending === 1).length;
    if (left && !confirm(`${left} entr${left === 1 ? 'y has' : 'ies have'} not synced yet and will be lost. Sign out anyway?`)) return;
    if (!left && !confirm('Sign out of Field Budget on this device?')) return;
    await signOut();
  });

  openSheet(wrap);
}

async function signOut() {
  try {
    await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch { /* offline: the cookie is cleared locally either way */ }

  // Clear cached budgets and the ledger. Leaving another instructor's entries on
  // a device that has changed hands would be both confusing and a privacy leak.
  try {
    await tx('entries', 'readwrite', (s) => s.clear());
    await tx('meta', 'readwrite', (s) => s.clear());
    await tx('receipts', 'readwrite', (s) => s.clear());
  } catch { /* nothing worth blocking sign-out over */ }

  state.email = null; state.budgets = []; state.entries = []; state.budgetId = null;
  closeSheet();
  location.reload();
}

function openHistory() {
  const b = budget();
  const voided = voidedIds();
  const rows = budgetEntries()
    // Corrections are bookkeeping, not events an instructor logged. The entry
    // they void is shown struck through instead, which reads as "this was fixed"
    // rather than two rows that look like double spending.
    .filter((e) => e.entry_type !== 'correction')
    .slice().sort((a, c) => (c.spent_on + c.created_at).localeCompare(a.spent_on + a.created_at))
    .slice(0, 80);

  const wrap = el('<div><h2>Recent entries</h2></div>');
  if (!rows.length) wrap.append(el('<div class="empty">Nothing logged yet.</div>'));

  for (const e of rows) {
    const cat = b.categories.find((c) => c.id === e.category_id);
    const entryLeg = e.category_id ? legOf(e.category_id) : null;
    const label = e.entry_type === 'expense' ? (cat ? cat.name : 'Spend')
      : e.entry_type === 'withdrawal' ? 'Cash withdrawn' : 'Exchange';
    const isVoid = voided.has(e.id);

    const row = el(`
      <button class="entry ${isVoid ? 'void' : ''}" type="button">
        <span class="entry-main">
          <span class="entry-desc">${e.description || label}</span>
          <span class="entry-meta"><span class="dot ${e.pending ? 'pending' : ''}"></span>${
            e.spent_on} · ${entryLeg ? `${entryLeg.name} · ` : ''}${label}${
            e.payment_method === 'card' ? ' · card' : ''}${isVoid ? ' · corrected' : ''}</span>
        </span>
        <span class="entry-amt num">${fmt(e.amount, e.currency, { sign: e.entry_type !== 'expense' })}</span>
      </button>`);
    if (!isVoid) row.addEventListener('click', () => openEntry(e));
    wrap.append(row);
  }

  wrap.append(el('<p class="hint">Tap an entry to change or remove it.</p>'));
  wrap.append(el('<button class="ghost" type="button" id="hclose">Close</button>'));
  wrap.querySelector('#hclose').addEventListener('click', closeSheet);
  openSheet(wrap);
}

/* ---------------- editing an entry ----------------
   Two paths, and which one applies depends on whether the entry has left the
   device.

   Never synced: it exists only in this browser's IndexedDB, so it is edited or
   deleted in place. No correction, no clutter — a typo caught ten seconds later
   should not leave a permanent trail.

   Already synced: the row is immutable. An edit writes a correction that voids
   the original plus a fresh entry with the new values; a delete writes just the
   correction. Both carry a group_id so the pair can be read together. */

function openEntry(e) {
  const b = budget();
  const cat = b.categories.find((c) => c.id === e.category_id);
  const entryLeg = e.category_id ? legOf(e.category_id) : null;
  const synced = e.pending !== 1;

  const wrap = el(`
    <div>
      <h2>${e.description || (cat ? cat.name : 'Entry')}</h2>
      <p class="hint">
        ${e.spent_on} · ${entryLeg ? `${entryLeg.name} · ` : ''}${cat ? cat.name : e.entry_type}
        · ${e.payment_method}<br>
        <strong>${fmt(e.amount, e.currency)}</strong>${
          e.currency !== (entryLeg && entryLeg.currency) && entryLeg
            ? ` at ${e.rate} = ${fmt(e.budget_amount, entryLeg.currency)}` : ''}
      </p>
      <p class="hint">${synced
        ? 'Already synced. Changes are recorded as a correction, so the original stays in the record.'
        : 'Not synced yet, so this is edited in place.'}</p>
      <button class="submit" type="button" id="eEdit">Change</button>
      <button class="ghost" type="button" id="eDel">Remove this entry</button>
      <button class="ghost" type="button" id="eCancel">Back</button>
    </div>`);

  wrap.querySelector('#eCancel').addEventListener('click', () => openHistory());

  wrap.querySelector('#eEdit').addEventListener('click', () => {
    if (e.entry_type !== 'expense') {
      toast('Cash movements can only be removed, not changed');
      return;
    }
    openSpend(e.category_id, e);
  });

  wrap.querySelector('#eDel').addEventListener('click', async () => {
    if (!confirm(synced
      ? 'Remove this entry? A correction will be recorded against it.'
      : 'Remove this entry? It has not synced, so it disappears entirely.')) return;

    if (!synced) {
      await delEntry(e.id);
      if (e.receipt_key) await putReceipt(e.receipt_key, null).catch(() => {});
    } else {
      await putEntry(voidOf(e));
    }
    state.entries = await allEntries();
    closeSheet(); render(); toast('Removed');
    if (navigator.onLine) sync({ quiet: true });
  });

  openSheet(wrap);
}

// A correction is the original with every signed figure negated, so balances and
// the cash float net back to where they were.
function voidOf(e, groupId) {
  return {
    ...e,
    id: uuid(),
    entry_type: 'correction',
    corrects_id: e.id,
    group_id: groupId || uuid(),
    amount: -e.amount,
    budget_amount: -e.budget_amount,
    description: e.description ? `Correction: ${e.description}` : 'Correction',
    email: state.email,
    created_at: new Date().toISOString(),
    pending: 1,
    receipt_key: null,          // the receipt belongs to the original
    receipt_uploaded: true,
    receipt_file_id: null,
    receipt_link: null,
  };
}

/* ---------------- wiring ---------------- */

document.querySelector('.dock').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-open]');
  if (!btn) return;
  if (btn.dataset.open === 'spend') openSpend(firstLeafId());
  if (btn.dataset.open === 'cash') openCash();
  if (btn.dataset.open === 'history') openHistory();
});

document.getElementById('syncChip').addEventListener('click', () => sync());
document.getElementById('acctBtn').addEventListener('click', () => { if (state.email) openAccount(); });
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

  wireAccessCode();
  wireMagicLink();
  loadGoogle();
}

function hideSignIn() {
  signInShown = false;
  document.body.classList.remove('signed-out');
  document.getElementById('signin').hidden = true;
}

function wireAccessCode() {
  const btn = $('ciGo');
  if (btn.dataset.wired) return;
  btn.dataset.wired = '1';

  const email = $('ciEmail');
  const code = $('ciCode');
  const msg = $('signinMsg');

  const submit = async () => {
    if (!email.value.includes('@')) { msg.textContent = 'Enter your email address.'; email.focus(); return; }
    if (!code.value) { msg.textContent = 'Enter your access code.'; code.focus(); return; }
    btn.disabled = true; msg.textContent = 'Signing in…';
    try {
      const res = await fetch(`${API}/auth/code`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.value.trim(), code: code.value }),
      });
      if (res.ok) { code.value = ''; hideSignIn(); await boot(); return; }
      const err = await res.json().catch(() => ({}));
      msg.textContent = err.error === 'not_assigned'
        ? `No budgets are assigned to ${err.email}. Ask your programme director to add that address.`
        : (err.error || 'That did not work.');
    } catch {
      // The code has to be checked server-side, so there is no offline path in.
      // Say that plainly rather than leaving them tapping a dead button.
      msg.textContent = 'No connection. Signing in needs a connection the first time; after that the app works offline.';
    } finally {
      btn.disabled = false;
    }
  };

  btn.addEventListener('click', submit);
  code.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
  email.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') code.focus(); });
  setTimeout(() => email.focus(), 80);
}

function wireMagicLink() {
  const toggle = document.getElementById('magicToggle');
  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = '1';
    toggle.addEventListener('click', () => {
      const blk = document.getElementById('magicBlock');
      blk.hidden = !blk.hidden;
      if (!blk.hidden) document.getElementById('magicEmail').focus();
    });
  }
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
  document.getElementById('altBlock').hidden = false;

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
