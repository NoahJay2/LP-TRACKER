// Lumen Peptides Tracker — single-file frontend app

// Bump on each deploy. Shown in the sidebar footer so you can confirm at a
// glance which build is actually live (handy when cache / deploy is in doubt).
const BUILD_VERSION = '2026-05-26.3';

const STORAGE_KEY = 'lumen-tracker-v1';
const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => Array.from(ctx.querySelectorAll(s));
// Stamp the build tag as soon as the DOM is ready.
(function stampBuild() {
  const set = () => { const el = document.getElementById('buildTag'); if (el) el.textContent = 'Build ' + BUILD_VERSION; };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', set);
  else set();
})();

// ---------- State ----------
let state = loadState();

function loadState() {
  let s;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) s = JSON.parse(raw);
  } catch (e) {}
  if (!s) s = JSON.parse(JSON.stringify(window.SEED_DATA));
  s.orders = migrateOrders(s.orders || []);
  s.expenses = migrateExpenses(s.expenses || []);
  s.shipments = migrateShipments(s.shipments || []);
  return s;
}

// Default existing shipments to unit='kits' so the legacy 1:1 behavior is
// preserved for old records (they're below the cutoff anyway, so no inventory
// delta is applied).
function migrateShipments(shipments) {
  return shipments.map(s => (s.unit === 'qty' || s.unit === 'kits') ? s : { ...s, unit: 'kits' });
}

// Convert legacy single-product orders into multi-item orders
function migrateOrders(orders) {
  return orders.map(o => {
    let r;
    if (Array.isArray(o.items)) {
      if (o.notes == null) o.notes = '';
      if (o.shipping == null) o.shipping = 0;
      r = o;
    } else {
      const item = {
        product: o.product || '',
        qty: Number(o.qty) || 0,
        price: Number(o.price) || 0,
        cogs: Number(o.cogs) || 0,
      };
      r = {
        id: o.id,
        customer: o.customer,
        date: o.date,
        paid: !!o.paid,
        delivered: !!o.delivered,
        items: [item],
        notes: o.notes || '',
        shipping: Number(o.shipping) || 0,
      };
    }
    // Snap every money field to whole cents so any prior floating-point noise
    // gets cleaned up the next time the file is saved. Cheap and idempotent.
    r.shipping = round2(r.shipping);
    if (Array.isArray(r.items)) {
      r.items = r.items.map(it => ({
        ...it,
        price: round2(it && it.price),
        cogs: round2(it && it.cogs),
      }));
    }
    // Discount: normalize to { type:'percent'|'amount', value } or null.
    if (r.discount && (r.discount.type === 'percent' || r.discount.type === 'amount') && Number(r.discount.value) > 0) {
      r.discount = { type: r.discount.type, value: round2(r.discount.value) };
    } else {
      r.discount = null;
    }
    // Payments array — sum represents how much the customer has paid. Legacy
    // "paid" boolean is preserved for backwards compat: if the order was fully
    // paid but has no payment records, synthesize one for the full total dated
    // to the order date so all the new accounting helpers line up.
    if (!Array.isArray(r.payments)) r.payments = [];
    r.payments = r.payments.map(p => ({ ...p, amount: round2(p && p.amount) }));
    if (r.paid && r.payments.length === 0) {
      const total = orderTotal(r);
      if (total > 0) {
        const d = new Date();
        const fallbackDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        r.payments.push({
          id: 'p-legacy-' + (r.id || Math.random().toString(36).slice(2, 8)),
          amount: total,
          date: r.date || fallbackDate,
          method: '',
          note: '',
        });
      }
    }
    syncOrderPaidFlag(r);
    // Inventory-applied flag tracks whether this order is currently deducted
    // from stock. For pre-existing orders without the flag, fall back to the
    // OLD rule (paid → deducted) so we don't double-restore or double-deduct
    // stock when the new "paid AND delivered" rule kicks in. Going forward,
    // reconcileOrderInventory() keeps the flag and stock in sync.
    if (typeof r.inventoryApplied !== 'boolean') r.inventoryApplied = !!r.paid;
    return r;
  });
}

// Convert legacy single-product expenses into multi-item expenses, and
// backfill `vendor` / `costMode` / `totalCost` for entries that pre-date them.
function migrateExpenses(expenses) {
  return expenses.map(e => {
    let r;
    if (Array.isArray(e.items) && e.items.length) {
      r = { ...e };
    } else {
      r = {
        id: e.id,
        dateOrdered: e.dateOrdered || '',
        dateReceived: e.dateReceived || '',
        items: [{ product: e.product || '', cost: Number(e.cost) || 0 }],
      };
    }
    if (typeof r.vendor !== 'string') r.vendor = '';
    if (r.costMode !== 'total' && r.costMode !== 'perItem') r.costMode = 'perItem';
    if (typeof r.totalCost !== 'number') {
      r.totalCost = (r.items || []).reduce((s, it) => s + (Number(it.cost) || 0), 0);
    }
    return r;
  });
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- Cloud sync (Supabase) ----------
const sb = (window.SUPABASE_CONFIG && window.supabase)
  ? window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.key)
  : null;

// Map between local JS shape and Postgres column names
const Adapters = {
  stock: {
    toRow: (s) => {
      const row = {
        id: s.id, name: s.name,
        cost: numOrNull(s.cost), price: numOrNull(s.price),
        qty: intOrNull(s.qty), status: s.status,
      };
      // Optional column — only send it if Supabase is known to have it, so an
      // older schema without `reorder` doesn't reject the whole row.
      if (orderColumnAvailable('reorder')) row.reorder = intOrNull(s.reorder);
      return row;
    },
    fromRow: (r) => ({
      id: r.id, name: r.name,
      cost: r.cost ?? 0, price: r.price ?? 0,
      qty: r.qty ?? 0, status: r.status || 'ACTIVE',
      reorder: r.reorder == null ? null : (Number(r.reorder) || 0),
    }),
  },
  orders: {
    toRow: (o) => {
      const row = {
        id: o.id, customer: o.customer || '',
        date: o.date || null,
        paid: !!o.paid, delivered: !!o.delivered,
        items: Array.isArray(o.items) ? o.items : [],
        notes: o.notes || '',
        shipping: Number(o.shipping) || 0,
      };
      // Only send optional columns if Supabase is known to have them — older
      // schemas without them would reject the whole row. See
      // missingOptionalOrderColumn() / orderColumnAvailable() above.
      if (orderColumnAvailable('payments')) {
        row.payments = Array.isArray(o.payments) ? o.payments : [];
      }
      if (orderColumnAvailable('discount')) {
        row.discount = o.discount || null;
      }
      // Sync the "is this order's inventory currently deducted from stock?" flag
      // so all devices agree on whether to apply or skip the inventory delta.
      if (orderColumnAvailable('inventory_applied')) {
        row.inventory_applied = !!o.inventoryApplied;
      }
      return row;
    },
    fromRow: (r) => ({
      id: r.id, customer: r.customer || '',
      date: r.date || '',
      paid: !!r.paid, delivered: !!r.delivered,
      items: Array.isArray(r.items) ? r.items : [],
      payments: Array.isArray(r.payments) ? r.payments : [],
      discount: r.discount || null,
      notes: r.notes || '',
      shipping: Number(r.shipping) || 0,
      // `undefined` (column missing or never set) is preserved so migrateOrders
      // can initialize it from the legacy paid flag on first load.
      inventoryApplied: (typeof r.inventory_applied === 'boolean') ? r.inventory_applied : undefined,
    }),
  },
  shipments: {
    toRow: (s) => ({
      id: s.id, vendor: s.vendor || '',
      date_ordered: s.dateOrdered || null,
      delivered: !!s.delivered,
      product: s.product || '', kits: s.kits == null ? '' : String(s.kits),
      unit: (s.unit === 'qty' || s.unit === 'kits') ? s.unit : 'kits',
      tracking: s.tracking || '',
    }),
    fromRow: (r) => ({
      id: r.id, vendor: r.vendor || '',
      dateOrdered: r.date_ordered || '',
      delivered: !!r.delivered,
      product: r.product || '', kits: r.kits || '',
      unit: (r.unit === 'qty' || r.unit === 'kits') ? r.unit : 'kits',
      tracking: r.tracking || '',
    }),
  },
  expenses: {
    toRow: (e) => {
      const items = Array.isArray(e.items) ? e.items : [];
      const mode = (e.costMode === 'total' || e.costMode === 'perItem') ? e.costMode : 'perItem';
      const totalCost = mode === 'total'
        ? Number(e.totalCost) || 0
        : items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
      const summary = items.length
        ? items.map(it => it.product).filter(Boolean).join(', ').slice(0, 200)
        : (e.product || '');
      return {
        id: e.id,
        vendor: e.vendor || '',
        product: summary,
        date_ordered: e.dateOrdered || null,
        date_received: e.dateReceived || null,
        cost: numOrNull(totalCost),
        cost_mode: mode,
        items,
      };
    },
    fromRow: (r) => {
      const cost = Number(r.cost) || 0;
      const items = Array.isArray(r.items) ? r.items : [];
      const itemSum = items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
      // Honor an explicit cost_mode if the schema has it. Otherwise fall back:
      // when the stored cost doesn't match the item sum the expense must have
      // been saved in "total" mode (item costs are 0) — preserve that so a
      // missing cost_mode column doesn't zero out the displayed amount.
      let costMode;
      if (r.cost_mode === 'total' || r.cost_mode === 'perItem') {
        costMode = r.cost_mode;
      } else if (cost > 0 && Math.abs(itemSum - cost) > 0.01) {
        costMode = 'total';
      } else {
        costMode = 'perItem';
      }
      return {
        id: r.id,
        vendor: r.vendor || '',
        product: r.product || '',
        dateOrdered: r.date_ordered || '',
        dateReceived: r.date_received || '',
        cost,
        costMode,
        totalCost: cost,
        items,
      };
    },
  },
};
function numOrNull(v) { return v == null || v === '' ? null : Number(v); }
function intOrNull(v) { return v == null || v === '' ? null : parseInt(v, 10); }

// ---------- Schema-presence detection (optional orders columns) ----------
// Columns added after the initial schema (payments, discount). If the Supabase
// orders table doesn't have one yet, an upsert that includes it fails and the
// whole row won't sync. We detect that once, remember it in localStorage, and
// drop just that column from future writes so everything else still syncs. The
// data stays in the local cache and repopulates cloud the moment the column is
// added (run the ALTER TABLE noted in the tooltip).
const OPTIONAL_ORDER_COLUMNS = ['payments', 'discount', 'inventory_applied'];
const OPTIONAL_STOCK_COLUMNS = ['reorder'];
// Every optional column across tables, so the missing-column detector and the
// upsert retry loop work for stock as well as orders. Column names are unique
// across our tables, so a single localStorage flag per name is unambiguous.
const ALL_OPTIONAL_COLUMNS = [...OPTIONAL_ORDER_COLUMNS, ...OPTIONAL_STOCK_COLUMNS];
function orderColumnAvailable(col) {
  try { return localStorage.getItem('lumen-supabase-missing-' + col) !== '1'; } catch { return true; }
}
function markOrderColumnMissing(col) {
  try { localStorage.setItem('lumen-supabase-missing-' + col, '1'); } catch {}
}
// Migrate the old payments-specific flag to the generic scheme.
(function migrateColumnFlags() {
  try {
    if (localStorage.getItem('lumen-supabase-payments-column') === 'missing') {
      localStorage.setItem('lumen-supabase-missing-payments', '1');
      localStorage.removeItem('lumen-supabase-payments-column');
    }
  } catch {}
})();
// If `error` is a missing-column error for one of our optional columns (and
// that column is still enabled), return its name; otherwise null. Postgres
// undefined-column is SQLSTATE 42703.
function missingOptionalOrderColumn(error) {
  if (!error) return null;
  const msg = String(error.message || '').toLowerCase();
  const code = String(error.code || '');
  if (code !== '42703' && !msg.includes('column')) return null;
  for (const col of ALL_OPTIONAL_COLUMNS) {
    if (orderColumnAvailable(col) && msg.includes(col)) return col;
  }
  return null;
}

function setCloudStatus(kind, text) {
  const el = $('#cloudStatus');
  const t = $('#cloudStatusText');
  if (!el || !t) return;
  el.classList.remove('online', 'offline', 'syncing');
  if (kind) el.classList.add(kind);
  t.textContent = text;
}

async function cloudFetchAll() {
  if (!sb) throw new Error('Supabase not configured');
  const [stock, orders, shipments, expenses] = await Promise.all([
    sb.from('stock').select('*'),
    sb.from('orders').select('*'),
    sb.from('shipments').select('*'),
    sb.from('expenses').select('*'),
  ]);
  for (const r of [stock, orders, shipments, expenses]) {
    if (r.error) throw r.error;
  }
  return {
    stock: stock.data.map(Adapters.stock.fromRow),
    orders: migrateOrders(orders.data.map(Adapters.orders.fromRow)),
    shipments: migrateShipments(shipments.data.map(Adapters.shipments.fromRow)),
    expenses: migrateExpenses(expenses.data.map(Adapters.expenses.fromRow)),
  };
}

async function cloudPushAll(s) {
  if (!sb) return;
  const tables = [
    ['stock', s.stock],
    ['orders', s.orders],
    ['shipments', s.shipments],
    ['expenses', s.expenses],
  ];
  for (const [t, items] of tables) {
    for (let i = 0; i < (items || []).length; i += 200) {
      const slice = items.slice(i, i + 200);
      // Retry while Supabase reports a missing optional column — drop it and
      // try again (up to once per optional column).
      let attempts = ALL_OPTIONAL_COLUMNS.length + 1;
      while (attempts-- > 0) {
        const { error } = await sb.from(t).upsert(slice.map(Adapters[t].toRow));
        if (!error) break;
        const col = missingOptionalOrderColumn(error);
        if (col && attempts > 0) { markOrderColumnMissing(col); continue; }
        throw error;
      }
    }
  }
}

// Upsert with automatic recovery from missing optional `orders` columns: if the
// write fails because Supabase doesn't have a column (payments / discount), we
// drop that column and retry. Data stays cached locally and syncs once the
// column is added. `cb(error)` runs with the final error (or null on success).
function upsertWithColumnRetry(table, items, attemptsLeft, cb) {
  sb.from(table).upsert(items.map(Adapters[table].toRow)).then(({ error }) => {
    if (error && attemptsLeft > 0) {
      const col = missingOptionalOrderColumn(error);
      if (col) {
        markOrderColumnMissing(col);
        toast(`Tip: add a \`${col}\` column to Supabase so it syncs to the cloud.`);
        upsertWithColumnRetry(table, items, attemptsLeft - 1, cb);
        return;
      }
    }
    cb(error || null);
  });
}

function cloudUpsert(table, item) {
  if (!sb) return;
  setCloudStatus('syncing', 'Syncing…');
  upsertWithColumnRetry(table, [item], ALL_OPTIONAL_COLUMNS.length, (error) => {
    if (error) {
      console.error('cloud upsert failed', { table, item, error });
      setCloudStatus('offline', 'Sync error');
      toast(`Cloud save failed: ${error.message}`);
    } else {
      setCloudStatus('online', 'Synced');
    }
  });
}
function cloudUpsertMany(table, items) {
  if (!sb || !items.length) return;
  setCloudStatus('syncing', 'Syncing…');
  upsertWithColumnRetry(table, items, ALL_OPTIONAL_COLUMNS.length, (error) => {
    if (error) {
      console.error('cloud upsertMany failed', { table, count: items.length, error });
      setCloudStatus('offline', 'Sync error');
      toast(`Cloud save failed: ${error.message}`);
    } else {
      setCloudStatus('online', 'Synced');
    }
  });
}
function cloudDelete(table, id) {
  if (!sb) return;
  setCloudStatus('syncing', 'Syncing…');
  // .select() returns the deleted rows so we can verify something was actually removed
  sb.from(table).delete().eq('id', id).select().then(({ data, error }) => {
    if (error) {
      console.error('cloud delete failed', { table, id, error });
      setCloudStatus('offline', 'Sync error');
      toast(`Cloud delete failed: ${error.message}`);
      return;
    }
    if (!data || data.length === 0) {
      console.warn('cloud delete: no row matched', { table, id });
      setCloudStatus('online', 'Synced');
      toast(`No matching row in cloud (id ${id}). Try Sync now.`);
      return;
    }
    console.log('cloud delete OK', { table, id, count: data.length });
    setCloudStatus('online', 'Synced');
  });
}

// Merge cloud orders with the local cache, preferring the local `payments`
// array whenever the cloud row's payments are missing/empty. This protects
// against two scenarios:
//   1. The Supabase `orders` table doesn't have a `payments` column yet, so
//      cloud reads always return `payments: []`. Without this merge a refresh
//      would silently wipe every partial payment.
//   2. Transient sync ordering where the cloud row pre-dates the latest local
//      payment update.
// We re-derive `paid` after merging so the boolean stays consistent.
function mergeCloudOrders(cloudOrders) {
  const localById = new Map((state.orders || []).map(o => [o.id, o]));
  return cloudOrders.map(o => {
    const local = localById.get(o.id);
    const cloudHasPayments = Array.isArray(o.payments) && o.payments.length > 0;
    if (!cloudHasPayments && local && Array.isArray(local.payments) && local.payments.length) {
      const merged = { ...o, payments: local.payments };
      syncOrderPaidFlag(merged);
      // Never DOWNGRADE a cloud-confirmed paid flag. The cloud `paid` column is
      // authoritative even when the payments column is missing/unsynced — so an
      // order marked Paid (e.g. on another device) that only has a partial
      // payment cached locally stays paid instead of flipping back to unpaid.
      if (o.paid) {
        merged.paid = true;
        // If the local payments don't cover the total, top them up with a
        // synthesized balance payment so the books reconcile with the paid flag.
        const bal = round2(orderTotal(merged) - orderPaymentsTotal(merged));
        if (bal > 0.005) {
          merged.payments = [...merged.payments, { id: uid('p'), amount: bal, date: o.date || todayISO(), method: '', note: '' }];
        }
      }
      return merged;
    }
    return o;
  });
}

async function initCloud() {
  if (!sb) { setCloudStatus('offline', 'No cloud configured'); return; }
  setCloudStatus('syncing', 'Loading from cloud…');
  try {
    const cloud = await cloudFetchAll();
    const cloudEmpty = !cloud.stock.length && !cloud.orders.length && !cloud.shipments.length && !cloud.expenses.length;
    const localHasData = state.orders.length > 0 || state.stock.length > 0;
    if (cloudEmpty && localHasData) {
      setCloudStatus('syncing', 'Uploading local data…');
      await cloudPushAll(state);
      toast('Local data uploaded to Supabase.');
    } else if (!cloudEmpty) {
      cloud.orders = mergeCloudOrders(cloud.orders);
      state = { ...state, ...cloud };
      saveState();
      renderAll();
    }
    setCloudStatus('online', 'Synced');
  } catch (err) {
    console.error('initCloud failed', err);
    setCloudStatus('offline', 'Offline (using cache)');
    toast('Cloud unavailable — using local cache.');
  }
}

async function manualSync() {
  if (!sb) { toast('No cloud configured.'); return; }
  setCloudStatus('syncing', 'Syncing…');
  try {
    const cloud = await cloudFetchAll();
    cloud.orders = mergeCloudOrders(cloud.orders);
    state = { ...state, ...cloud };
    saveState();
    renderAll();
    setCloudStatus('online', 'Synced');
    toast('Pulled latest from cloud.');
  } catch (err) {
    console.error(err);
    setCloudStatus('offline', 'Sync error');
    toast('Sync failed: ' + (err.message || 'unknown'));
  }
}

function resetState() {
  if (!confirm('Reset all data back to the seed (Excel) data? This will erase any changes.')) return;
  state = JSON.parse(JSON.stringify(window.SEED_DATA));
  saveState();
  renderAll();
  toast('Data reset to seed.');
}

// ---------- Helpers ----------
const fmt$ = (n) => {
  const v = Number(n) || 0;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
const uid = (p) => p + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
// Snap a value to whole cents — defends against floating-point noise like
// 0.1 + 0.2 = 0.30000000000000004 that would otherwise surface in pending
// totals as $225.02 when the user only typed whole-dollar amounts.
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
// Local-time YYYY-MM-DD. `Date.toISOString()` is UTC, so using it for "today"
// rolls the day forward in evening hours west of UTC and we'd show tomorrow's
// data. These getters read the device's local calendar date instead.
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthKey = (iso) => (iso || '').slice(0, 7); // YYYY-MM
// Compact "M/D" formatter (no zero-padding) for table date columns. Falls back
// to whatever was passed if the input isn't a YYYY-MM-DD ISO string.
const fmtDateShort = (iso) => {
  if (!iso || typeof iso !== 'string' || iso.length < 10) return iso || '';
  const [, m, d] = iso.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
};
// Long human-readable format for the invoice (e.g. "May 5, 2026"). Built from
// local components so we don't accidentally roll into UTC the way `new Date(iso)`
// would for naked ISO date strings.
const fmtDateLong = (iso) => {
  if (!iso || typeof iso !== 'string' || iso.length < 10) return iso || '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};
const monthName = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
};
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2000);
}

// Per-order computed values (sums across all line items + shipping charge)
function orderItems(o) { return Array.isArray(o.items) ? o.items : []; }
function orderShipping(o) { return Number(o && o.shipping) || 0; }
// Items-only revenue (excluding shipping / discount). Invoice subtotal line.
function orderItemsTotal(o) {
  return orderItems(o).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
}
// Subtotal of the items eligible for a discount. Items flagged
// `excludeDiscount` (e.g. a product the user doesn't want marked down) are
// left out of the base the discount is computed against.
function orderDiscountableSubtotal(o) {
  return orderItems(o).reduce(
    (s, it) => (it && it.excludeDiscount ? s : s + (Number(it.qty) || 0) * (Number(it.price) || 0)),
    0
  );
}
// Discount applied to the eligible items subtotal (shipping and any excluded
// items are never discounted). `discount` is { type:'percent'|'amount', value }.
// The resolved discount ALWAYS rounds UP to a whole dollar — 8% of $80 = $6.40
// → $7, and even a flat $6.20 → $7 — so the books stay on round numbers. Never
// exceeds the eligible subtotal. The 1e-9 epsilon keeps an exact whole-dollar
// result (e.g. 6.00000001 from float math) from jumping to the next dollar.
function orderDiscountAmount(o) {
  const d = o && o.discount;
  const value = Number(d && d.value) || 0;
  if (!d || value <= 0) return 0;
  const base = orderDiscountableSubtotal(o);
  const raw = d.type === 'percent' ? (base * value / 100) : value;
  const amt = Math.ceil(raw - 1e-9);
  return Math.min(base, Math.max(0, amt));
}
// Total amount the customer pays (items − discount + shipping). Shipping is
// collected from the customer so it counts as revenue everywhere.
function orderTotal(o) {
  return orderItemsTotal(o) - orderDiscountAmount(o) + orderShipping(o);
}
// Profit = items profit − discount + shipping. The discount comes straight off
// the bottom line (COGS is fixed); shipping is treated as pass-through.
function orderProfit(o) {
  const itemsProfit = orderItems(o).reduce((s, it) => s + ((Number(it.price) || 0) - (Number(it.cogs) || 0)) * (Number(it.qty) || 0), 0);
  return itemsProfit - orderDiscountAmount(o) + orderShipping(o);
}
function orderQty(o) {
  return orderItems(o).reduce((s, it) => s + (Number(it.qty) || 0), 0);
}
// Partial-payment accounting. `payments` is an array of { id, amount, date, method, note }.
// Sum represents how much the customer has actually paid. The boolean `o.paid`
// is kept in sync — true iff sum >= total (within a 0.5¢ epsilon for rounding).
function orderPayments(o) { return Array.isArray(o && o.payments) ? o.payments : []; }
function orderPaymentsTotal(o) {
  return orderPayments(o).reduce((s, p) => s + (Number(p && p.amount) || 0), 0);
}
function orderBalance(o) {
  return Math.max(0, orderTotal(o) - orderPaymentsTotal(o));
}
function orderIsFullyPaid(o) {
  const total = orderTotal(o);
  // Treat $0 orders with no items as not-paid (avoid revenue inflation).
  if (total <= 0) return false;
  return orderPaymentsTotal(o) >= total - 0.005;
}
function orderIsPartiallyPaid(o) {
  return orderPaymentsTotal(o) > 0.005 && !orderIsFullyPaid(o);
}
// Revenue recognized in cash terms — paid amount capped at the order total
// (defends against an over-payment data error inflating books).
function orderPaidRevenue(o) {
  return Math.min(orderPaymentsTotal(o), orderTotal(o));
}
// All-or-nothing profit recognition. The instant an order is marked Paid, its
// full profit lands in the dashboard's Gross Profit / True Net Profit; while
// it sits unpaid (or partially paid) the full profit waits in Pending Net.
// Rounded to whole dollars per order so legacy fractional-cent prices can't
// bleed into dashboard totals.
//
// We honor BOTH signals: the persisted `o.paid` flag (what every row toggle and
// the orders table show the user) AND the payments-derived orderIsFullyPaid().
// Trusting `o.paid` keeps the KPI consistent with the UI even if some path
// flipped the flag without keeping the payments array exactly in sync.
//
//   For David: $410 total, $207 profit, $200 paid (not fully paid).
//     paid profit   = $0      (profit hasn't landed yet)
//     unpaid profit = $207    (full profit still pending)
function orderHasLandedProfit(o) {
  return !!o && (o.paid === true || orderIsFullyPaid(o));
}
function orderPaidProfit(o) {
  return orderHasLandedProfit(o) ? Math.round(orderProfit(o)) : 0;
}
function orderUnpaidProfit(o) {
  return orderHasLandedProfit(o) ? 0 : Math.round(orderProfit(o));
}
// Source-of-truth for the boolean `paid` flag. Called any time payments mutate
// so existing code (cloud sync, KPIs, inventory deduction) sees a coherent state.
function syncOrderPaidFlag(o) {
  o.paid = orderIsFullyPaid(o);
}
// Shortcut for the row-level / group-level Paid toggle. Checking the toggle
// tops payments up to the full balance (dated today); unchecking it clears
// every payment so the order reverts to "Unpaid". Granular control still lives
// in the order modal's Payments section.
function setOrderFullyPaid(o, fullyPaid) {
  if (!Array.isArray(o.payments)) o.payments = [];
  if (fullyPaid) {
    const balance = round2(Math.max(0, orderTotal(o) - orderPaymentsTotal(o)));
    if (balance > 0.005) {
      o.payments.push({
        id: uid('p'),
        amount: balance,
        date: todayISO(),
        method: '',
        note: '',
      });
    }
  } else {
    o.payments = [];
  }
  syncOrderPaidFlag(o);
}
// Inventory consumption rule: an order only counts against stock once it is
// BOTH fully paid AND marked delivered. Partial payments and pending deliveries
// leave stock untouched. The per-order `inventoryApplied` flag tracks whether
// the deduction is currently in place so toggles stay idempotent and consistent
// across devices (synced via the optional `inventory_applied` column).
function orderConsumesInventory(o) {
  return !!(o && o.paid && o.delivered);
}
// Apply / undo the inventory delta for an order so its actual deduction state
// matches the rule. No-op when already in sync. Returns the touched stock items
// (callers push them to the cloud).
function reconcileOrderInventory(o) {
  if (!o) return [];
  const want = orderConsumesInventory(o);
  if (want === !!o.inventoryApplied) return [];
  const touched = applyOrderInventoryDelta(o.items, want ? -1 : +1);
  o.inventoryApplied = want;
  return touched;
}
// Render a single line-item as a pill (for the 1-item case in any items column).
function itemPill(it) {
  if (!it) return '<span class="muted">No items</span>';
  return `<span class="item-pill"><span class="ip-name">${escapeHtml(it.product || '')}</span><span class="ip-qty">×${fmtN(it.qty || 0)}</span></span>`;
}
// Render an items column for a record: pill if 1 item, "N items" badge otherwise.
function itemsCellInline(items) {
  if (!items || !items.length) return '<span class="muted">No items</span>';
  if (items.length === 1) return itemPill(items[0]);
  return `<span class="grp-badge">${items.length} items</span>`;
}

// ---------- Navigation ----------
$$('.nav-item').forEach(b => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});
$$('[data-view]').forEach(el => {
  if (el.classList.contains('nav-item')) return;
  el.addEventListener('click', () => switchView(el.dataset.view));
});

// Detect iOS standalone (home-screen PWA) mode. In standalone mode we
// AGGRESSIVELY avoid any custom touch/focus handling because iOS treats the
// standalone webview's input/keyboard activation very strictly — any
// document-level touch handler, hidden focusable element, or programmatic
// focus chain can silently prevent the on-screen keyboard from appearing.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_STANDALONE =
  (typeof navigator.standalone === 'boolean' && navigator.standalone === true) ||
  (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
  (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches);
const IS_IOS_PWA = IS_IOS && IS_STANDALONE;

// iOS Safari (in a regular tab) sometimes loses the user-gesture association
// when we focus a freshly-appended input. The helper-focus trick fixes that —
// but ONLY in a regular Safari tab. In iOS standalone PWA mode it can backfire,
// so we fall back to plain native focus() there. Plain native focus from a
// click handler is the most reliable path in standalone mode.
let __kbdHelper = null;
function ensureKeyboardHelper() {
  if (__kbdHelper) return __kbdHelper;
  __kbdHelper = document.createElement('input');
  __kbdHelper.type = 'text';
  __kbdHelper.setAttribute('aria-hidden', 'true');
  __kbdHelper.tabIndex = -1;
  __kbdHelper.style.cssText =
    'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;' +
    'border:0;padding:0;margin:0;font-size:16px;z-index:-1;' +
    'transform:translateZ(0);pointer-events:none;';
  document.body.appendChild(__kbdHelper);
  return __kbdHelper;
}
function focusForKeyboard(targetInput) {
  if (!targetInput) return;
  // Desktop / Android → plain focus, no helper games.
  if (!IS_IOS) {
    targetInput.focus();
    return;
  }
  // iOS (both Safari and standalone PWA) — use the helper-focus-transfer
  // dance so the on-screen keyboard reliably appears when focusing a row
  // that was just appended to the DOM.
  const helper = ensureKeyboardHelper();
  helper.focus();
  void targetInput.offsetHeight;
  setTimeout(() => {
    try { targetInput.focus(); } catch {}
  }, 0);
}

const VIEW_STORAGE_KEY = 'lumen-tracker-view';
const VALID_VIEWS = ['dashboard', 'orders', 'inventory', 'shipments', 'expenses', 'income', 'monthly'];

function switchView(name) {
  if (!VALID_VIEWS.includes(name)) name = 'dashboard';
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $('#view-' + name).classList.add('active');
  $$('.nav-item').forEach(n => { if (n.dataset.view === name) n.classList.add('active'); });
  try { localStorage.setItem(VIEW_STORAGE_KEY, name); } catch (e) {}
  if (name === 'dashboard') renderDashboard();
  if (name === 'orders') renderOrders();
  if (name === 'inventory') renderInventory();
  if (name === 'shipments') renderShipments();
  if (name === 'expenses') renderExpenses();
  if (name === 'income') renderIncome();
  if (name === 'monthly') renderMonthly();
}

function restoreLastView() {
  let saved;
  try { saved = localStorage.getItem(VIEW_STORAGE_KEY); } catch (e) {}
  if (saved && VALID_VIEWS.includes(saved) && saved !== 'dashboard') switchView(saved);
}

// ---------- Modal ----------
const modal = $('#modal');
let modalOnSave = null;
function openModal(title, fields, onSave, initial = {}) {
  $('#modalTitle').textContent = title;
  const form = $('#modalForm');
  form.innerHTML = '';
  fields.forEach(f => {
    if (f.type === 'row') {
      const row = document.createElement('div');
      row.className = 'row-2';
      f.fields.forEach(sub => row.appendChild(buildField(sub, initial)));
      form.appendChild(row);
    } else {
      form.appendChild(buildField(f, initial));
    }
  });
  modalOnSave = () => {
    const data = {};
    fields.flatMap(f => f.type === 'row' ? f.fields : [f]).forEach(f => {
      const el = form.querySelector(`[name="${f.name}"]`);
      if (!el) return;
      if (f.type === 'checkbox') data[f.name] = el.checked;
      else if (f.type === 'number') data[f.name] = el.value === '' ? null : Number(el.value);
      else data[f.name] = el.value;
    });
    if (onSave(data) !== false) closeModal();
  };
  showModal();
  setTimeout(() => form.querySelector('input,select,textarea')?.focus(), 50);
}
function buildField(f, initial) {
  const lbl = document.createElement('label');
  if (f.type !== 'checkbox') {
    const span = document.createElement('span');
    span.textContent = f.label;
    if (f.required) span.classList.add('req');
    lbl.appendChild(span);
  }
  let el;
  if (f.type === 'select') {
    el = document.createElement('select');
    f.options.forEach(o => {
      const opt = document.createElement('option');
      opt.value = typeof o === 'object' ? o.value : o;
      opt.textContent = typeof o === 'object' ? o.label : o;
      el.appendChild(opt);
    });
    el.value = initial[f.name] ?? f.default ?? '';
  } else if (f.type === 'checkbox') {
    lbl.classList.add('check-row');
    el = document.createElement('input');
    el.type = 'checkbox';
    el.checked = !!initial[f.name];
    lbl.appendChild(el);
    const span = document.createElement('span');
    span.textContent = f.label;
    lbl.appendChild(span);
  } else if (f.type === 'textarea') {
    el = document.createElement('textarea');
    el.rows = 3;
    el.value = initial[f.name] ?? '';
  } else {
    el = document.createElement('input');
    el.type = f.type || 'text';
    if (f.type === 'number') { el.step = f.step ?? 'any'; if (f.min != null) el.min = f.min; }
    el.value = initial[f.name] ?? f.default ?? '';
    if (f.placeholder) el.placeholder = f.placeholder;
  }
  el.name = f.name;
  if (f.required) el.required = true;
  if (f.type !== 'checkbox') lbl.appendChild(el);
  return lbl;
}
// Lock body scroll while a modal is open. Uses position:fixed so iOS Safari
// doesn't fall back to letting touch-scroll the underlying content. Stores the
// scroll position so it can be restored when the modal closes.
let __savedScrollY = 0;
function lockBodyScroll() {
  if (document.body.classList.contains('modal-open')) return;
  __savedScrollY = window.scrollY;
  document.body.style.top = `-${__savedScrollY}px`;
  document.body.classList.add('modal-open');
}
function unlockBodyScroll() {
  if (!document.body.classList.contains('modal-open')) return;
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  window.scrollTo(0, __savedScrollY);
}
function showModal() { modal.classList.add('open'); lockBodyScroll(); }
function closeModal() {
  modal.classList.remove('open');
  // Reset any read-only popup styling so the next regular modal opens with the
  // standard Save/Cancel button setup.
  modal.classList.remove('modal-readonly');
  $('#modalCancel').textContent = 'Cancel';
  modalOnSave = null;
  unlockBodyScroll();
}
$('#modalClose').addEventListener('click', closeModal);
$('#modalCancel').addEventListener('click', closeModal);
$('#modalSave').addEventListener('click', () => modalOnSave && modalOnSave());
// Backdrop dismiss only fires when the user BOTH presses down and clicks on
// the backdrop. Without this guard, dragging out of an input (e.g. selecting
// text in a number field, or releasing a slider thumb) lands the click on
// the backdrop and closes the modal mid-edit.
let __modalMouseDownOnBackdrop = false;
modal.addEventListener('mousedown', (e) => {
  __modalMouseDownOnBackdrop = (e.target === modal);
});
modal.addEventListener('click', (e) => {
  if (e.target === modal && __modalMouseDownOnBackdrop) closeModal();
  __modalMouseDownOnBackdrop = false;
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('open')) closeModal(); });

// ---------- DASHBOARD ----------
// `readonly` skips paid/delivered toggles (used by the Recently Completed card,
// where everything is paid AND delivered — toggling there would un-complete it).
function renderRecentOrderGroup(g, readonly = false) {
  if (g.orders.length === 1) return renderRecentOrderRow(g.orders[0], readonly);

  const groupId = 'rg_' + (g.customer || '').replace(/\W+/g, '_') + '_' + (g.date || '').replace(/\W+/g, '');
  const totalQty = g.orders.reduce((s, o) => s + orderQty(o), 0);
  const totalAmt = g.orders.reduce((s, o) => s + orderTotal(o), 0);
  const totalLineItems = g.orders.reduce((s, o) => s + orderItems(o).length, 0);
  const allPaid = g.orders.every(o => o.paid);
  // Treat partial-payment orders as mixed so the user sees a "Mixed" pill (and
  // can drill in) instead of an unchecked toggle that misrepresents the state.
  const noPaid = g.orders.every(o => orderPaymentsTotal(o) <= 0.005);
  const allDelivered = g.orders.every(o => o.delivered);
  const noDelivered = g.orders.every(o => !o.delivered);
  const orderIds = g.orders.map(o => o.id).join(',');
  const childFlags = g.orders.map(o => orderStatusFlag(o));
  const aggCls = [
    'group-row',
    childFlags.includes('unpaid')  ? 'has-flag-unpaid'  : '',
    childFlags.includes('pending') ? 'has-flag-pending' : '',
  ].filter(Boolean).join(' ');

  // Toggleable switches when all children share the state, "Mixed" pill otherwise.
  // Empty cells in readonly mode (Recently Completed table — those columns are CSS-hidden anyway).
  const paidCell = readonly ? '' : (allPaid || noPaid)
    ? `<label class="switch"><input type="checkbox" data-group-paid="${orderIds}" ${allPaid ? 'checked' : ''} /><span class="slider"></span></label>`
    : `<span class="pill mixed" data-expand-group="${groupId}" title="Mixed — expand to see each">Mixed</span>`;
  const deliveredCell = readonly ? '' : (allDelivered || noDelivered)
    ? `<label class="switch"><input type="checkbox" data-group-delivered="${orderIds}" ${allDelivered ? 'checked' : ''} /><span class="slider"></span></label>`
    : `<span class="pill mixed" data-expand-group="${groupId}" title="Mixed — expand to see each">Mixed</span>`;

  const totalProfit = g.orders.reduce((s, o) => s + orderProfit(o), 0);
  let html = `
    <tr class="${aggCls}">
      <td>${fmtDateShort(g.date)}</td>
      <td><b>${escapeHtml(g.customer || '')}</b><span class="customer-sub">${totalLineItems} item${totalLineItems === 1 ? '' : 's'}</span></td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${totalLineItems} item${totalLineItems === 1 ? '' : 's'}</span></td>
      <td class="num">${fmtN(totalQty)}</td>
      <td class="num">${fmt$(totalAmt)}</td>
      <td class="num">${fmt$(totalProfit)}</td>
      <td>${paidCell}</td>
      <td>${deliveredCell}</td>
    </tr>`;
  html += g.orders.map(o => {
    const flag = orderStatusFlag(o);
    const cls = ['child-row'];
    if (flag) cls.push(`row-flag-${flag}`);
    const childToggles = readonly ? '' : `
          <span class="cs-toggle"><span class="cs-tlabel">Paid</span><label class="switch"><input type="checkbox" data-toggle-paid="${o.id}" ${o.paid ? 'checked' : ''} /><span class="slider"></span></label>${partialPaidPill(o)}</span>
          <span class="cs-toggle"><span class="cs-tlabel">Delivered</span><label class="switch"><input type="checkbox" data-toggle-delivered="${o.id}" ${o.delivered ? 'checked' : ''} /><span class="slider"></span></label></span>`;
    return `
    <tr class="${cls.join(' ')}" data-parent="${groupId}" hidden>
      <td colspan="8" class="child-cell">
        <div class="child-strip">
          <span class="cs-label">↳${statusFlagBadge(flag)}</span>
          <span class="cs-items">${itemsCellInline(orderItems(o))}</span>
          <span class="cs-stat"><span class="cs-tlabel">Total</span><b class="cs-stat-total">${fmt$(orderTotal(o))}</b></span>
          <span class="cs-stat"><span class="cs-tlabel">Profit</span><b>${fmt$(orderProfit(o))}</b></span>${childToggles}
        </div>
      </td>
    </tr>`;
  }).join('');
  return html;
}

function renderRecentOrderRow(o, readonly = false) {
  const items = orderItems(o);
  const flag = orderStatusFlag(o);
  const flagCls = flag ? ` row-flag-${flag}` : '';
  // Sub-line below customer name (visible on mobile): product name when single
  // item with qty, "N items" when multi.
  let sub = '';
  if (items.length === 1) {
    const it = items[0];
    sub = `<span class="customer-sub">${escapeHtml(it.product || '')}${(Number(it.qty) || 0) > 0 ? ` ×${fmtN(it.qty)}` : ''}</span>`;
  } else if (items.length > 1) {
    sub = `<span class="customer-sub">${items.length} items</span>`;
  }
  const paidCellTd = readonly ? '<td></td>' : `<td><div class="paid-cell"><label class="switch"><input type="checkbox" data-toggle-paid="${o.id}" ${o.paid ? 'checked' : ''} /><span class="slider"></span></label>${partialPaidPill(o)}</div></td>`;
  const deliveredCellTd = readonly ? '<td></td>' : `<td><label class="switch"><input type="checkbox" data-toggle-delivered="${o.id}" ${o.delivered ? 'checked' : ''} /><span class="slider"></span></label></td>`;
  if (items.length <= 1) {
    return `<tr class="${flagCls.trim()}">
      <td>${fmtDateShort(o.date)}</td>
      <td>${escapeHtml(o.customer || '')}${statusFlagBadge(flag)}${sub}</td>
      <td class="items-cell">${itemsCellInline(items)}</td>
      <td class="num">${fmtN(orderQty(o))}</td>
      <td class="num">${fmt$(orderTotal(o))}</td>
      <td class="num">${fmt$(orderProfit(o))}</td>
      ${paidCellTd}
      ${deliveredCellTd}
    </tr>`;
  }
  // Multi-item: parent row with chevron, plus child rows for each line item.
  const groupId = 'roi_' + String(o.id || '').replace(/\W+/g, '_');
  let html = `
    <tr class="group-row${flagCls}">
      <td>${fmtDateShort(o.date)}</td>
      <td>${escapeHtml(o.customer || '')}${statusFlagBadge(flag)}${sub}</td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${items.length} items</span></td>
      <td class="num">${fmtN(orderQty(o))}</td>
      <td class="num">${fmt$(orderTotal(o))}</td>
      <td class="num">${fmt$(orderProfit(o))}</td>
      ${paidCellTd}
      ${deliveredCellTd}
    </tr>`;
  html += items.map(it => `
    <tr class="child-row" data-parent="${groupId}" hidden>
      <td colspan="8" class="child-cell">
        <div class="child-strip">
          <span class="cs-label">↳</span>
          <span class="cs-items">${itemPill(it)}</span>
          <span class="cs-stat"><span class="cs-tlabel">Total</span><b class="cs-stat-total">${fmt$((Number(it.qty)||0)*(Number(it.price)||0))}</b></span>
          <span class="cs-stat"><span class="cs-tlabel">Profit</span><b>${fmt$(((Number(it.price)||0)-(Number(it.cogs)||0))*(Number(it.qty)||0))}</b></span>
        </div>
      </td>
    </tr>`).join('');
  return html;
}

function renderDashboard() {
  const orders = state.orders;
  // Cash-basis revenue/profit — count the paid portion of every order, including
  // partial payments. The unpaid balance shows up as Pending below. round2()
  // strips floating-point drift that accumulates when summing many orders.
  const grossRevenue = round2(orders.reduce((s, o) => s + orderPaidRevenue(o), 0));
  const grossProfit = round2(orders.reduce((s, o) => s + orderPaidProfit(o), 0));
  const pendingGross = round2(orders.reduce((s, o) => s + orderBalance(o), 0));
  const pendingNet = round2(orders.reduce((s, o) => s + orderUnpaidProfit(o), 0));
  const expSum = round2(state.expenses.reduce((s, e) => s + expenseCost(e), 0));

  // True Net Profit = Gross Profit − Total Expenses (what actually lands in the business account).
  const trueNetProfit = round2(grossProfit - expSum);

  $('#kpiGross').textContent = fmt$(grossRevenue);
  $('#kpiExp').textContent = fmt$(expSum);
  $('#kpiNet').textContent = fmt$(grossProfit);
  $('#kpiNetTrue').textContent = fmt$(trueNetProfit);
  $('#kpiPending').textContent = fmt$(pendingGross);
  $('#kpiPendingNet').textContent = fmt$(pendingNet);

  // "This Month" card — current calendar month only, with a See more link to the
  // Monthly page. Revenue / Net Profit tiles use cash-basis (paid portion of
  // each order, including partials). The card surfaces whenever there's any
  // activity for the month, even if no order is fully paid yet.
  const curMonthKey = monthKey(todayISO());
  const inMonth = (o) => monthKey(o.date) === curMonthKey;
  const monthOrders = orders.filter(inMonth);
  const monthPending = monthOrders.filter(o => orderBalance(o) > 0.005);
  const monthRev = round2(monthOrders.reduce((s, o) => s + orderPaidRevenue(o), 0));
  const monthNet = round2(monthOrders.reduce((s, o) => s + orderPaidProfit(o), 0));
  const monthLabel = monthName(curMonthKey + '-01');
  const tmCard = $('#thisMonthCard');
  // Keep monthPending in the hasAny check so a month with only pending orders
  // still renders the card (the empty state otherwise reads "no orders yet"
  // which would be misleading when there ARE orders, just none completed).
  const hasAny = monthOrders.length || monthPending.length;
  if (tmCard) {
    tmCard.innerHTML = hasAny
      ? `
        <div class="this-month-head">${monthLabel}</div>
        <div class="this-month-stats">
          <div class="tm-stat tm-stat-revenue"><span class="tm-label">Revenue</span><b>${fmt$(monthRev)}</b></div>
          <div class="tm-stat tm-stat-net"><span class="tm-label">Net Profit</span><b>${fmt$(monthNet)}</b></div>
        </div>
      `
      : `<div class="this-month-head">${monthLabel}</div><div class="muted" style="padding:6px 0;">No orders yet this month.</div>`;
  }

  // "Today" snapshot — orders dated today, regardless of paid/delivered status,
  // so the user sees real-time pulse of the day's activity. Split totals by paid
  // status so the user can see actual revenue vs money still owed.
  const todayKey = todayISO();
  const todayOrders = orders.filter(o => o.date === todayKey);
  const todayPendingOrders = todayOrders.filter(o => orderBalance(o) > 0.005);
  const todayOrderCount = new Set(
    todayOrders.map(o => (o.customer || '').toLowerCase().trim())
  ).size;
  // Today's tiles also follow cash basis: paid portion (incl. partials) on the
  // top row, outstanding balance on the bottom.
  const todayPaidRev = round2(todayOrders.reduce((s, o) => s + orderPaidRevenue(o), 0));
  const todayPaidNet = round2(todayOrders.reduce((s, o) => s + orderPaidProfit(o), 0));
  const todayPendingRev = round2(todayOrders.reduce((s, o) => s + orderBalance(o), 0));
  const todayPendingNet = round2(todayOrders.reduce((s, o) => s + orderUnpaidProfit(o), 0));
  const todayLabel = fmtDateShort(todayKey);

  // Group today's orders by customer so each customer is one row in To Do /
  // Completed. A customer goes to "Completed" only if ALL their orders today
  // are both paid AND delivered — otherwise they appear in "To Do" with pills
  // showing what's still outstanding.
  const todayCustomers = new Map();
  for (const o of todayOrders) {
    const key = (o.customer || '').toLowerCase().trim();
    if (!todayCustomers.has(key)) {
      todayCustomers.set(key, { name: o.customer || '', total: 0, allPaid: true, allDelivered: true });
    }
    const bucket = todayCustomers.get(key);
    bucket.total += orderTotal(o);
    if (!o.paid) bucket.allPaid = false;
    if (!o.delivered) bucket.allDelivered = false;
  }
  const todoList = [];
  const doneList = [];
  for (const c of todayCustomers.values()) {
    if (c.allPaid && c.allDelivered) doneList.push(c);
    else todoList.push(c);
  }

  // Overdue — incomplete orders with a date BEFORE today. Grouped by
  // customer+date so a customer with two outstanding past dates shows as two
  // rows. Sorted oldest first so the most-aged work surfaces at the top.
  const overdueGroupsMap = new Map();
  for (const o of orders) {
    if (o.paid && o.delivered) continue;
    if (!o.date || o.date >= todayKey) continue;
    const ck = (o.customer || '').toLowerCase().trim();
    const key = ck + '|' + o.date;
    if (!overdueGroupsMap.has(key)) {
      overdueGroupsMap.set(key, {
        name: o.customer || '', custKey: ck, date: o.date,
        total: 0, allPaid: true, allDelivered: true,
      });
    }
    const bucket = overdueGroupsMap.get(key);
    bucket.total += orderTotal(o);
    if (!o.paid) bucket.allPaid = false;
    if (!o.delivered) bucket.allDelivered = false;
  }
  const overdueList = [...overdueGroupsMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const daysLate = (iso) => {
    const a = new Date(iso + 'T00:00:00');
    const b = new Date(todayKey + 'T00:00:00');
    return Math.max(0, Math.round((b - a) / 86400000));
  };

  const customerKey = (c) => (c.name || '').toLowerCase().trim();
  // Pills always show both Pay and Send status — green confirms a step is done,
  // amber flags it as still owed. "Send" covers both shipments and in-person
  // deliveries since either way it leaves the user's hands.
  const statusTags = (c) => {
    const pay = c.allPaid
      ? `<span class="pill green">Paid</span>`
      : `<span class="pill amber">Pay</span>`;
    const send = c.allDelivered
      ? `<span class="pill green">Sent</span>`
      : `<span class="pill amber">Send</span>`;
    return `${pay}${send}`;
  };
  const todoRow = (c) => `<div class="today-row" data-today-customer="${escapeHtml(customerKey(c))}" role="button" tabindex="0">
    <span class="today-name">${escapeHtml(c.name)}</span>
    <span class="today-amount">${fmt$(c.total)}</span>
    <span class="today-tags">${statusTags(c)}</span>
  </div>`;
  const doneRow = (c) => `<div class="today-row today-row-done" data-today-customer="${escapeHtml(customerKey(c))}" role="button" tabindex="0">
    <span class="today-name">${escapeHtml(c.name)}</span>
    <span class="today-amount">${fmt$(c.total)}</span>
    <span class="today-tags">${statusTags(c)}</span>
  </div>`;
  const overdueRow = (c) => {
    const days = daysLate(c.date);
    return `<div class="today-row today-row-overdue" data-today-customer="${escapeHtml(c.custKey)}" data-today-date="${c.date}" role="button" tabindex="0">
      <span class="today-name">${escapeHtml(c.name)}<span class="today-row-date">${fmtDateShort(c.date)} · ${days}d late</span></span>
      <span class="today-amount">${fmt$(c.total)}</span>
      <span class="today-tags">${statusTags(c)}</span>
    </div>`;
  };

  const overdueSectionHtml = overdueList.length ? `
    <div class="today-section today-section-overdue">
      <div class="today-section-head today-section-head-overdue">Overdue <span class="muted">(${overdueList.length})</span></div>
      <div class="today-list">${overdueList.map(overdueRow).join('')}</div>
    </div>
  ` : '';

  const tdCard = $('#todayCard');
  if (tdCard) {
    if (todayOrders.length) {
      tdCard.innerHTML = `
        <div class="this-month-head">${todayLabel} <span class="muted">· ${fmtN(todayOrderCount)} order${todayOrderCount === 1 ? '' : 's'}</span></div>
        <div class="this-month-stats">
          <div class="tm-stat tm-stat-revenue"><span class="tm-label">Total Paid</span><b>${fmt$(todayPaidRev)}</b></div>
          <div class="tm-stat tm-stat-net"><span class="tm-label">Net Profit Paid</span><b>${fmt$(todayPaidNet)}</b></div>
          <div class="tm-stat tm-stat-pending"><span class="tm-label">Total Pending</span><b>${fmt$(todayPendingRev)}</b></div>
          <div class="tm-stat tm-stat-pending"><span class="tm-label">Profit Pending</span><b>${fmt$(todayPendingNet)}</b></div>
        </div>
        ${overdueSectionHtml}
        <div class="today-section">
          <div class="today-section-head">To Do <span class="muted">(${todoList.length})</span></div>
          <div class="today-list">${
            todoList.length
              ? todoList.map(todoRow).join('')
              : `<div class="today-empty">All caught up.</div>`
          }</div>
        </div>
        <div class="today-section">
          <div class="today-section-head">Completed <span class="muted">(${doneList.length})</span></div>
          <div class="today-list">${
            doneList.length
              ? doneList.map(doneRow).join('')
              : `<div class="today-empty">No completed orders yet.</div>`
          }</div>
        </div>
      `;
    } else if (overdueList.length) {
      // No orders today, but past orders still need attention — surface them
      // so the dashboard doesn't read as "nothing to do" while work is overdue.
      tdCard.innerHTML = `
        <div class="this-month-head">${todayLabel} <span class="muted">· No orders today</span></div>
        ${overdueSectionHtml}
      `;
    } else {
      tdCard.innerHTML = `<div class="this-month-head">${todayLabel}</div><div class="muted" style="padding:6px 0;">No orders today yet.</div>`;
    }
    // Tap a customer row to see what they ordered. Overdue rows include a
    // data-today-date attribute so the popup loads that customer's past orders
    // for the right day instead of defaulting to today.
    tdCard.querySelectorAll('[data-today-customer]').forEach(el => {
      const open = () => openTodayOrderDetail(el.dataset.todayCustomer, el.dataset.todayDate || todayISO());
      el.addEventListener('click', open);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  // Recently Completed Orders — last 5 customer-day groups across fully completed orders
  // (paid AND delivered). In-flight orders show up under Pending Orders below.
  const completedOrders = orders.filter(o => o.paid && o.delivered);
  const sortedOrders = [...completedOrders].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const recentGroupsMap = new Map();
  for (const o of sortedOrders) {
    const key = (o.customer || '').toLowerCase().trim() + '|' + (o.date || '');
    if (!recentGroupsMap.has(key)) recentGroupsMap.set(key, { customer: o.customer, date: o.date, orders: [] });
    recentGroupsMap.get(key).orders.push(o);
  }
  const recentGroups = [...recentGroupsMap.values()].slice(0, 5);
  const recentBody = $('#recentOrdersBody');
  const recentExpanded = getExpandedGroupIds(recentBody);
  recentBody.innerHTML = recentGroups.map(g => renderRecentOrderGroup(g, true)).join('') ||
    `<tr><td colspan="8" class="muted">No completed orders yet.</td></tr>`;
  restoreGroupExpansion(recentBody, recentExpanded);
  wireGroupExpand(recentBody);

  // Pending orders — anything not fully completed (unpaid OR undelivered).
  // Sorted oldest-first so the user can fulfill them in date order (5/2 before 5/5).
  const incompleteOrders = orders.filter(o => !o.paid || !o.delivered);
  const pendingOrdersList = [...incompleteOrders].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const pendingGroupsMap = new Map();
  for (const o of pendingOrdersList) {
    const key = (o.customer || '').toLowerCase().trim() + '|' + (o.date || '');
    if (!pendingGroupsMap.has(key)) pendingGroupsMap.set(key, { customer: o.customer, date: o.date, orders: [] });
    pendingGroupsMap.get(key).orders.push(o);
  }
  const pendingGroups = [...pendingGroupsMap.values()];
  const pendingBody = $('#pendingOrdersBody');
  const pendingExpanded = getExpandedGroupIds(pendingBody);
  pendingBody.innerHTML = pendingGroups.length
    ? pendingGroups.map(g => renderRecentOrderGroup(g)).join('')
    : `<tr><td colspan="8" class="muted">No pending orders.</td></tr>`;
  restoreGroupExpansion(pendingBody, pendingExpanded);
  wireGroupExpand(pendingBody);
  wireOrderInteractions(pendingBody);
  // Pending header total/profit = outstanding balance only. Paid-but-undelivered
  // orders contribute $0 here (cash already collected); partial orders contribute
  // just the unpaid portion.
  const pendingUnpaidTotal = round2(incompleteOrders.reduce((s, o) => s + orderBalance(o), 0));
  const pendingUnpaidProfit = round2(incompleteOrders.reduce((s, o) => s + orderUnpaidProfit(o), 0));
  const pendingCountEl = $('#pendingOrdersCount');
  pendingCountEl.innerHTML = incompleteOrders.length
    ? `${incompleteOrders.length} pending · <span class="foot-label">Total</span>${fmt$(pendingUnpaidTotal)} · <span class="foot-label">Profit</span>${fmt$(pendingUnpaidProfit)}`
    : '';

  // Reorder alerts — active products at/below their reorder level (out of stock
  // sorts to the top). Each product's level is its own `reorder` value, or a
  // global default when unset. See stockNeedsReorder().
  const low = state.stock.filter(stockNeedsReorder)
    .sort((a, b) => (Number(a.qty) || 0) - (Number(b.qty) || 0));
  const reorderCountEl = $('#reorderCount');
  if (reorderCountEl) reorderCountEl.textContent = low.length ? `${low.length} to reorder` : '';
  $('#lowStock').innerHTML = low.length
    ? low.slice(0, 8).map(p => {
        const q = Number(p.qty) || 0;
        const right = q <= 0 ? `<b class="reorder-out">Out</b>` : `<b>${fmtN(q)} left</b>`;
        return `<li><span>${escapeHtml(p.name)}</span>${right}</li>`;
      }).join('')
    : '<li class="muted">All products well-stocked.</li>';

  // Pending shipments — consolidate by vendor+date OR shared tracking number.
  const pendingShipments = state.shipments
    .filter(s => !s.delivered)
    .sort((a, b) => (b.dateOrdered || '').localeCompare(a.dateOrdered || ''));
  const psGroups = consolidateShipments(pendingShipments).slice(0, 8);
  const pendingShipsEl = $('#pendingShips');
  if (!psGroups.length) {
    pendingShipsEl.innerHTML = '<li class="muted">No pending shipments.</li>';
  } else {
    pendingShipsEl.innerHTML = psGroups.map((g, i) => {
      if (g.shipments.length === 1) {
        const s = g.shipments[0];
        return `<li><span><b>${escapeHtml(s.vendor || '')}</b> <span class="muted">— ${escapeHtml(s.product || '')}</span></span><b>${escapeHtml(String(s.kits || ''))}</b></li>`;
      }
      const groupId = `pds_${i}`;
      const totalKits = g.shipments.reduce((sum, s) => {
        const n = parseInt(s.kits, 10);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0);
      const headRight = totalKits > 0 ? fmtN(totalKits) : `${g.shipments.length}`;
      const children = g.shipments.map(s =>
        `<li class="ps-child"><span>${escapeHtml(s.product || '')}</span><b>${escapeHtml(String(s.kits || ''))}</b></li>`
      ).join('');
      return `<li class="ps-group">
        <div class="ps-head" data-ps-toggle="${groupId}">
          <span><span class="chevron">▶</span><b>${escapeHtml(g.vendor || '')}</b> <span class="muted">— ${g.shipments.length} items</span></span>
          <b>${headRight}</b>
        </div>
        <ul class="ps-children" data-ps-children="${groupId}" hidden>${children}</ul>
      </li>`;
    }).join('');
    pendingShipsEl.querySelectorAll('[data-ps-toggle]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.psToggle;
        const chev = el.querySelector('.chevron');
        const child = pendingShipsEl.querySelector(`[data-ps-children="${id}"]`);
        const expanded = chev.classList.toggle('expanded');
        if (child) child.hidden = !expanded;
      });
    });
  }
}

function pillBool(v, yes, no) {
  return v ? `<span class="pill green">${yes}</span>` : `<span class="pill amber">${no}</span>`;
}

// Flag mismatched payment/delivery states so the row stands out.
//   'unpaid'  = delivered but not paid (need to collect payment)
//   'pending' = paid but not delivered (need to ship)
//   'partial' = any payments made but balance still > 0
function orderStatusFlag(o) {
  if (o.delivered && !o.paid) return 'unpaid';
  if (o.paid && !o.delivered) return 'pending';
  if (orderIsPartiallyPaid(o)) return 'partial';
  return null;
}
function statusFlagBadge(flag) {
  if (flag === 'unpaid')  return ' <span class="status-flag danger" title="Delivered but not paid — collect payment">⚠</span>';
  if (flag === 'pending') return ' <span class="status-flag success" title="Paid but not yet delivered — needs to ship">⏳</span>';
  if (flag === 'partial') return ' <span class="status-flag warn" title="Partial payment received — balance still owed">◐</span>';
  return '';
}
// Compact "$40" chip rendered next to the Paid toggle on rows for partially-
// paid orders — shows how much has been collected so far. Tooltip carries the
// full breakdown so the row itself stays tidy.
function partialPaidPill(o) {
  if (!orderIsPartiallyPaid(o)) return '';
  const paid = orderPaymentsTotal(o);
  const total = orderTotal(o);
  const balance = Math.max(0, total - paid);
  return `<button type="button" class="partial-chip" data-open-payments="${o.id}" title="${fmt$(paid)} of ${fmt$(total)} paid · ${fmt$(balance)} due">${fmt$(paid)}</button>`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Renders the invoice template into the modal form. Reusable from both the
// Today popup (multi-order group, editable notes) and the order edit/new form
// (single in-progress draft, notes are read-only here since they're edited in
// the order form itself).
//   formEl         the <form> element to render into (always #modalForm)
//   orders         array of order-like objects (each has items[], notes)
//   customerName   what shows under "Bill To"
//   dateKey        ISO date for the invoice "Date" line
//   onBack         called when the user taps ← Back
//   allowNotesEdit true → user can add/edit notes inside the invoice
//   onNotesSave    called with the new text when notes are saved (edit mode)
function renderInvoiceView({ formEl, orders, customerName, dateKey, onBack, allowNotesEdit, onNotesSave }) {
  // Build per-line items, allocating each order's discount proportionally across
  // its eligible lines so a discounted line can show its reduced price with the
  // original struck through. The remainder is applied to the last eligible line
  // so the per-line discounts sum exactly to the order's discount.
  const lineItems = orders.flatMap(o => {
    const base = orderDiscountableSubtotal(o);
    const totalDisc = orderDiscountAmount(o);
    const rows = orderItems(o).map(it => {
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      return { product: it.product || '', qty, price, lineTotal: qty * price, excluded: !!it.excludeDiscount, disc: 0 };
    });
    if (totalDisc > 0 && base > 0) {
      // Allocate the whole-dollar discount across eligible lines in WHOLE
      // dollars (remainder on the last line) so every discounted line total
      // stays a clean whole number — no cents on the invoice.
      const incl = rows.filter(r => !r.excluded && r.lineTotal > 0);
      let allocated = 0;
      incl.forEach((r, i) => {
        if (i === incl.length - 1) { r.disc = Math.round(totalDisc - allocated); }
        else { r.disc = Math.round(totalDisc * r.lineTotal / base); allocated += r.disc; }
      });
    }
    return rows;
  });
  const itemsSubtotal = round2(orders.reduce((s, o) => s + orderItemsTotal(o), 0));
  const shipping = round2(orders.reduce((s, o) => s + orderShipping(o), 0));
  const discountAmt = round2(orders.reduce((s, o) => s + orderDiscountAmount(o), 0));
  const discountedSubtotal = round2(itemsSubtotal - discountAmt);
  // Discount line label — include the percentage when the invoice has a single
  // percentage discount and no flat-dollar discount mixed in.
  const discountPcts = new Set(
    orders.filter(o => orderDiscountAmount(o) > 0 && o.discount && o.discount.type === 'percent')
          .map(o => Number(o.discount.value))
  );
  const anyFlatDiscount = orders.some(o => orderDiscountAmount(o) > 0 && (!o.discount || o.discount.type !== 'percent'));
  const discountLabel = (discountPcts.size === 1 && !anyFlatDiscount)
    ? `You saved (${[...discountPcts][0]}% off)`
    : 'You saved';
  const total = round2(orders.reduce((s, o) => s + orderTotal(o), 0));
  const paidSoFar = round2(orders.reduce((s, o) => s + orderPaidRevenue(o), 0));
  const balanceDue = round2(Math.max(0, total - paidSoFar));
  const hasPartial = paidSoFar > 0.005 && balanceDue > 0.005;
  const isFullyPaid = total > 0 && paidSoFar > 0.005 && balanceDue <= 0.005;
  // Individual payment records across all orders in this invoice, sorted by date,
  // so the customer can see each payment they've made.
  const paymentList = orders
    .flatMap(o => orderPayments(o))
    .filter(p => (Number(p.amount) || 0) > 0.005)
    .map(p => ({ amount: round2(p.amount), date: p.date || '' }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const combinedNotes = () => {
    const all = orders.map(o => (o.notes || '').trim()).filter(Boolean);
    return [...new Set(all)].join('\n');
  };

  formEl.innerHTML = `
    <div class="invoice-view">
      <div class="invoice-paper">
        <img class="invoice-watermark" src="public/lplogo.png" alt="" />
        <div class="invoice-header">
          <div class="invoice-title">Order Invoice</div>
          <div class="invoice-meta">
            <div class="invoice-meta-row"><span class="invoice-meta-label">Date</span><span>${fmtDateLong(dateKey)}</span></div>
            ${isFullyPaid ? `<div class="invoice-meta-row"><span class="invoice-paid-stamp">PAID</span></div>` : ''}
          </div>
        </div>
        <div class="invoice-items">
          <div class="invoice-items-head">
            <span>Item</span><span>Qty</span><span>Price</span><span>Total</span>
          </div>
          ${lineItems.length ? lineItems.map(r => {
            const isDisc = r.disc > 0.005;
            // Whole dollars only on the invoice — no cents on price or total.
            const dTotal = Math.round(r.lineTotal - r.disc);
            const dUnit = r.qty > 0 ? Math.round((r.lineTotal - r.disc) / r.qty) : r.price;
            const priceCell = isDisc
              ? `<span class="invoice-price-was">${fmt$(r.price)}</span><span class="invoice-price-now">${fmt$(dUnit)}</span>`
              : fmt$(r.price);
            const totalCell = isDisc
              ? `<span class="invoice-price-was">${fmt$(r.lineTotal)}</span><span class="invoice-price-now">${fmt$(dTotal)}</span>`
              : fmt$(r.lineTotal);
            return `
              <div class="invoice-item-row">
                <span class="invoice-item-name">${escapeHtml(r.product)}</span>
                <span>${fmtN(r.qty)}</span>
                <span>${priceCell}</span>
                <span>${totalCell}</span>
              </div>
            `;
          }).join('') : `<div class="invoice-item-row" style="opacity:.5"><span>(no items)</span><span></span><span></span><span></span></div>`}
        </div>
        ${(shipping > 0 || discountAmt > 0) ? `
          <div class="invoice-subtotal-rows">
            <div class="invoice-subtotal-row"><span>Subtotal</span><span>${fmt$(discountAmt > 0 ? discountedSubtotal : itemsSubtotal)}</span></div>
            ${discountAmt > 0 ? `<div class="invoice-subtotal-row invoice-discount-row"><span>${discountLabel}</span><span>${fmt$(discountAmt)}</span></div>` : ''}
            ${shipping > 0 ? `<div class="invoice-subtotal-row"><span>Shipping</span><span>${fmt$(shipping)}</span></div>` : ''}
          </div>
        ` : ''}
        <div class="invoice-total-row">
          <span class="invoice-total-label">${(hasPartial || isFullyPaid) ? 'Order Total' : 'Total Due'}</span>
          <span class="invoice-total-amount">${fmt$(total)}</span>
        </div>
        ${paymentList.length ? `
          <div class="invoice-subtotal-rows invoice-balance-rows">
            ${paymentList.map(p => `
              <div class="invoice-subtotal-row">
                <span>Payment${p.date ? ` · ${fmtDateShort(p.date)}` : ''}</span>
                <span>−${fmt$(p.amount)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${hasPartial ? `
          <div class="invoice-total-row invoice-balance-row">
            <span class="invoice-total-label">Balance Due</span>
            <span class="invoice-total-amount">${fmt$(balanceDue)}</span>
          </div>
        ` : ''}
        ${isFullyPaid ? `
          <div class="invoice-total-row invoice-paid-row">
            <span class="invoice-total-label">Balance Due</span>
            <span class="invoice-total-amount">${fmt$(0)}</span>
          </div>
        ` : ''}
        ${isFullyPaid ? '' : `
        <div class="invoice-payment-block">
          <div class="invoice-payment-label">Payment Methods</div>
          <div class="invoice-payment-list">
            <div class="invoice-payment-row">
              <span class="invoice-payment-method">Zelle</span>
              <a class="invoice-payment-value" href="tel:5125731342">512-573-1342</a>
            </div>
            <div class="invoice-payment-row">
              <span class="invoice-payment-method">Apple Pay</span>
              <span class="invoice-payment-value">512-573-1342</span>
            </div>
            <div class="invoice-payment-row">
              <span class="invoice-payment-method">CashApp</span>
              <span class="invoice-payment-value">$NoahJx2</span>
            </div>
            <div class="invoice-payment-row">
              <span class="invoice-payment-method">Cash</span>
              <span class="invoice-payment-value">In person</span>
            </div>
          </div>
          <div class="invoice-payment-note">
            <b>Heads up — CashApp is strict.</b> If sending via CashApp, please put
            <b>"for food"</b> or just a <b>"."</b> in the memo so the payment isn't flagged.
          </div>
        </div>
        `}
        <div class="invoice-notes-block" id="invoiceNotesBlock"></div>
      </div>
      <div class="invoice-actions">
        <button type="button" class="btn ghost" id="invoiceBackBtn">← Back</button>
      </div>
    </div>
  `;

  function renderNotesView(editing) {
    const block = formEl.querySelector('#invoiceNotesBlock');
    const text = combinedNotes();
    if (!allowNotesEdit) {
      block.innerHTML = text
        ? `<div class="invoice-notes-label">Notes</div><div class="invoice-notes-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`
        : '';
      return;
    }
    if (editing) {
      block.innerHTML = `
        <div class="invoice-notes-label">Notes</div>
        <textarea class="invoice-notes-input" rows="3" placeholder="Add a note (e.g. payment instructions)…">${escapeHtml(text)}</textarea>
        <div class="invoice-notes-actions">
          <button type="button" class="btn ghost" id="invoiceNotesCancel">Cancel</button>
          <button type="button" class="btn primary" id="invoiceNotesSave">Save</button>
        </div>
      `;
      const ta = block.querySelector('textarea');
      setTimeout(() => ta.focus(), 30);
      block.querySelector('#invoiceNotesCancel').addEventListener('click', () => renderNotesView(false));
      block.querySelector('#invoiceNotesSave').addEventListener('click', () => {
        if (typeof onNotesSave === 'function') onNotesSave(ta.value.trim());
        renderNotesView(false);
      });
    } else if (text) {
      block.innerHTML = `
        <div class="invoice-notes-label">Notes</div>
        <div class="invoice-notes-text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
        <button type="button" class="link invoice-notes-edit" id="invoiceNotesEdit">Edit notes</button>
      `;
      block.querySelector('#invoiceNotesEdit').addEventListener('click', () => renderNotesView(true));
    } else {
      block.innerHTML = `<button type="button" class="btn ghost invoice-notes-add" id="invoiceNotesAdd">+ Add Notes</button>`;
      block.querySelector('#invoiceNotesAdd').addEventListener('click', () => renderNotesView(true));
    }
  }
  renderNotesView(false);
  formEl.querySelector('#invoiceBackBtn').addEventListener('click', onBack);
}

// Read-only popup invoked from the dashboard's Today card. Shows a quick summary
// of everything a customer ordered on a given day — items, qty, price, totals,
// and paid/delivered state — without opening the full order edit modal. Has a
// "Show Invoice" button that swaps to a screenshot-friendly invoice view.
// dateKey defaults to today; the Today card also passes past dates for overdue
// rows so the popup shows that customer's old order day.
function openTodayOrderDetail(customerKey, dateKey) {
  const todayKey = dateKey || todayISO();
  const orders = state.orders.filter(o =>
    o.date === todayKey &&
    (o.customer || '').toLowerCase().trim() === customerKey
  );
  if (!orders.length) return;
  const customerName = orders[0].customer || '';

  $('#modalTitle').textContent = customerName;
  const form = $('#modalForm');

  function persistOrders(updated, stockTouched) {
    if (!updated.length) return;
    saveState();
    cloudUpsertMany('orders', updated);
    if (stockTouched && stockTouched.size) cloudUpsertMany('stock', [...stockTouched]);
    renderOrders(); renderInventory(); renderDashboard();
  }

  // Combined notes from all orders in the group. If they all share the same
  // text we just show it once; otherwise join distinct values with newlines.
  function combinedNotes() {
    const all = orders.map(o => (o.notes || '').trim()).filter(Boolean);
    return [...new Set(all)].join('\n');
  }
  function setNotesOnAll(text) {
    const updated = [];
    for (const o of orders) {
      if ((o.notes || '') !== text) {
        o.notes = text;
        updated.push(o);
      }
    }
    persistOrders(updated, null);
  }

  function renderDetail() {
    const allItems = orders.flatMap(o => orderItems(o));
    const total = orders.reduce((s, o) => s + orderTotal(o), 0);
    const profit = orders.reduce((s, o) => s + orderProfit(o), 0);
    const paidSoFar = orders.reduce((s, o) => s + orderPaidRevenue(o), 0);
    const balance = Math.max(0, total - paidSoFar);
    const allPaid = orders.every(o => o.paid);
    const allDelivered = orders.every(o => o.delivered);
    const anyPartial = orders.some(o => orderIsPartiallyPaid(o));

    form.innerHTML = `
      <div class="readonly-detail">
        <div class="rd-meta">
          <span class="rd-date">${fmtDateShort(todayKey)}</span>
        </div>
        <div class="rd-toggles">
          <label class="toggle-row">
            <span class="toggle-row-label">Paid</span>
            <span class="switch"><input type="checkbox" id="rdPaid" ${allPaid ? 'checked' : ''} /><span class="slider"></span></span>
          </label>
          <label class="toggle-row">
            <span class="toggle-row-label">Delivered</span>
            <span class="switch"><input type="checkbox" id="rdDelivered" ${allDelivered ? 'checked' : ''} /><span class="slider"></span></span>
          </label>
        </div>
        <div class="rd-items">
          ${allItems.map(it => {
            const qty = Number(it.qty) || 0;
            const price = Number(it.price) || 0;
            return `
              <div class="rd-item">
                <span class="rd-item-name">${escapeHtml(it.product || '')}</span>
                <span class="rd-item-qty">×${fmtN(qty)}</span>
                <span class="rd-item-price muted">${fmt$(price)} ea</span>
                <span class="rd-item-total">${fmt$(qty * price)}</span>
              </div>
            `;
          }).join('')}
        </div>
        <div class="rd-totals">
          <div class="rd-total-row">
            <span class="rd-total-label">Total</span>
            <b class="rd-total-value">${fmt$(total)}</b>
          </div>
          ${(paidSoFar > 0.005 && balance > 0.005) ? `
            <div class="rd-total-row">
              <span class="rd-total-label muted">Paid So Far</span>
              <b class="rd-total-value">${fmt$(paidSoFar)}</b>
            </div>
            <div class="rd-total-row">
              <span class="rd-total-label muted">Balance Due</span>
              <b class="rd-total-value">${fmt$(balance)}</b>
            </div>
          ` : ''}
          <div class="rd-total-row">
            <span class="rd-total-label muted">Net Profit</span>
            <b class="rd-total-value">${fmt$(profit)}</b>
          </div>
        </div>
        ${anyPartial ? '<button type="button" class="btn ghost" id="editPaymentsBtn">Edit Payments</button>' : ''}
        <button type="button" class="btn primary rd-invoice-btn" id="showInvoiceBtn">Show Invoice</button>
      </div>
    `;

    // Toggling Paid / Delivered updates every order in this customer-day group
    // at once. Either toggle can now flip an order's inventory state — stock is
    // only deducted once the order is BOTH paid AND delivered — so each handler
    // runs reconcileOrderInventory after the change.
    form.querySelector('#rdPaid').addEventListener('change', (e) => {
      const isPaid = e.target.checked;
      const stockTouched = new Set();
      const updated = [];
      for (const o of orders) {
        if (!!o.paid === isPaid) continue;
        setOrderFullyPaid(o, isPaid);
        reconcileOrderInventory(o).forEach(p => stockTouched.add(p));
        updated.push(o);
      }
      persistOrders(updated, stockTouched);
    });
    form.querySelector('#rdDelivered').addEventListener('change', (e) => {
      const isDelivered = e.target.checked;
      const stockTouched = new Set();
      const updated = [];
      for (const o of orders) {
        if (!!o.delivered === isDelivered) continue;
        o.delivered = isDelivered;
        reconcileOrderInventory(o).forEach(p => stockTouched.add(p));
        updated.push(o);
      }
      persistOrders(updated, stockTouched);
    });
    form.querySelector('#showInvoiceBtn').addEventListener('click', renderInvoice);
    const editPaymentsBtn = form.querySelector('#editPaymentsBtn');
    if (editPaymentsBtn) {
      editPaymentsBtn.addEventListener('click', () => {
        // The Today popup can span multiple same-day orders for a customer.
        // Open the first partially-paid one in the full editor so the user can
        // adjust its payments.
        const target = orders.find(o => orderIsPartiallyPaid(o)) || orders[0];
        if (target) orderModal(target);
      });
    }
  }

  function renderInvoice() {
    renderInvoiceView({
      formEl: form,
      orders,
      customerName,
      dateKey: todayKey,
      onBack: renderDetail,
      allowNotesEdit: true,
      onNotesSave: setNotesOnAll,
    });
  }

  renderDetail();

  modalOnSave = null;
  modal.classList.add('modal-readonly');
  $('#modalCancel').textContent = 'Close';
  showModal();
}

// ---------- ORDERS ----------
// Persist a filter input/select to localStorage so the user's selection sticks
// across navigation and reloads. For text inputs the saved value always
// applies; for <select> we only restore values that exist as options.
function persistFilter(el, key) {
  if (!el) return;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) {
      if (el.tagName === 'SELECT') {
        if ([...el.options].some(o => o.value === saved)) el.value = saved;
      } else {
        el.value = saved;
      }
    }
  } catch {}
  el.addEventListener('input', () => {
    try { localStorage.setItem(key, el.value); } catch {}
  });
}

// Reset a list of filter controls back to their defaults (first option for
// selects, empty for text inputs) and dispatch input events so persistFilter
// re-saves the defaults and any subscribed render functions re-run.
function resetFilters(elements) {
  elements.forEach(el => {
    if (!el) return;
    if (el.tagName === 'SELECT') {
      // Prefer the option marked `selected` in the HTML — it's the page's
      // intended default (e.g. Top Products defaults to "Top 10", not first).
      const def = el.querySelector('option[selected]');
      el.value = def?.value ?? el.options[0]?.value ?? '';
    } else {
      el.value = '';
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// Wire a custom × button inside a `.search-wrap` to clear its <input> and re-fire
// the input event so any subscribed render runs. Clears localStorage too.
function wireSearchClear(input) {
  const wrap = input.closest('.search-wrap');
  if (!wrap) return;
  const btn = wrap.querySelector('.search-clear');
  if (!btn) return;
  const update = () => wrap.classList.toggle('has-text', !!input.value);
  input.addEventListener('input', update);
  btn.addEventListener('click', () => {
    input.value = '';
    update();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
  update();
}

const ordSearch = $('#ordSearch');
const ordFilter = $('#ordFilter');
const ordMonth = $('#ordMonth');
const ordDay = $('#ordDay');
const ordSort = $('#ordSort');
wireSearchClear(ordSearch);
const ORD_MONTH_KEY = 'lumen.orders.month';
const ORD_DAY_KEY = 'lumen.orders.day';
persistFilter(ordSearch, 'lumen.orders.search');
persistFilter(ordFilter, 'lumen.orders.filter');
persistFilter(ordMonth, ORD_MONTH_KEY);
persistFilter(ordDay, ORD_DAY_KEY);
persistFilter(ordSort, 'lumen.orders.sort');
[ordSearch, ordFilter, ordMonth, ordDay, ordSort].forEach(el => el.addEventListener('input', renderOrders));
$('#ordReset').addEventListener('click', () => resetFilters([ordSearch, ordFilter, ordMonth, ordDay, ordSort]));

$('#addOrderBtn').addEventListener('click', () => orderModal());

function refreshMonthDropdown() {
  const months = Array.from(new Set(state.orders.map(o => monthKey(o.date)).filter(Boolean))).sort();
  const stored = (() => { try { return localStorage.getItem(ORD_MONTH_KEY) || ''; } catch { return ''; } })();
  // Capture before innerHTML wipes the value, fall back to localStorage on first render.
  const cur = ordMonth.value || stored;
  ordMonth.innerHTML = `<option value="all">All Months</option>` +
    months.map(m => `<option value="${m}">${monthName(m + '-01')}</option>`).join('');
  if (cur === 'all' || months.includes(cur)) ordMonth.value = cur;
}

// Day dropdown lists every distinct date in the orders. When a specific month
// is chosen above, days are scoped to that month so the user only sees relevant
// dates. Selection persists via localStorage; falls back to "all" if the saved
// day is no longer valid (e.g., switched months).
function refreshDayDropdown() {
  const mo = ordMonth.value;
  const allDates = state.orders.map(o => o.date).filter(Boolean);
  const scoped = mo === 'all' ? allDates : allDates.filter(d => monthKey(d) === mo);
  const days = Array.from(new Set(scoped)).sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(ORD_DAY_KEY) || ''; } catch { return ''; } })();
  const cur = ordDay.value || stored;
  ordDay.innerHTML = `<option value="all">All Days</option>` +
    days.map(d => `<option value="${d}">${fmtDateShort(d)}</option>`).join('');
  if (cur === 'all' || days.includes(cur)) ordDay.value = cur;
  else ordDay.value = 'all';
}

function renderOrders() {
  refreshMonthDropdown();
  refreshDayDropdown();
  const q = ordSearch.value.toLowerCase().trim();
  const f = ordFilter.value;
  const mo = ordMonth.value;
  const dy = ordDay.value;
  // 'asc' → oldest first; anything else → newest first (default).
  const ordDir = ordSort.value === 'asc' ? 1 : -1;
  let rows = [...state.orders].sort((a, b) =>
    ordDir * ((a.date || '').localeCompare(b.date || ''))
  );
  if (q) rows = rows.filter(o => {
    if ((o.customer || '').toLowerCase().includes(q)) return true;
    return orderItems(o).some(it => (it.product || '').toLowerCase().includes(q));
  });
  if (mo !== 'all') rows = rows.filter(o => monthKey(o.date) === mo);
  if (dy !== 'all') rows = rows.filter(o => o.date === dy);
  if (f === 'unpaid') rows = rows.filter(o => !o.paid);
  if (f === 'partial') rows = rows.filter(o => orderIsPartiallyPaid(o));
  if (f === 'paid') rows = rows.filter(o => o.paid);
  if (f === 'undelivered') rows = rows.filter(o => !o.delivered);
  if (f === 'delivered') rows = rows.filter(o => o.delivered);
  if (f === 'pending') rows = rows.filter(o => !o.paid && !o.delivered);

  // Group rows by customer + date so multiple same-day orders collapse into one row
  const groupsMap = new Map();
  for (const o of rows) {
    const key = (o.customer || '').toLowerCase().trim() + '|' + (o.date || '');
    if (!groupsMap.has(key)) groupsMap.set(key, { customer: o.customer, date: o.date, orders: [] });
    groupsMap.get(key).orders.push(o);
  }
  const groups = [...groupsMap.values()].sort((a, b) =>
    ordDir * ((a.date || '').localeCompare(b.date || ''))
  );

  const body = $('#ordersBody');
  const expandedBefore = getExpandedGroupIds(body);
  body.innerHTML = groups.map(g => renderOrderGroup(g)).join('') ||
    `<tr><td colspan="9" class="muted" style="padding:24px;text-align:center;">No orders match.</td></tr>`;
  restoreGroupExpansion(body, expandedBefore);

  const totalQty = rows.reduce((s, o) => s + orderQty(o), 0);
  const groupCount = groups.length;
  $('#ordCount').innerHTML =
    `<span class="foot-label">Total Orders</span> <span>${fmtN(groupCount)}</span>` +
    ` <span class="muted">· ${fmtN(totalQty)} item${totalQty === 1 ? '' : 's'}</span>`;
  $('#ordSumQty').textContent = fmtN(totalQty);
  // Footer Total = sum of full order totals (what was sold), Profit = full
  // potential profit. Cash-basis collection numbers live on the dashboard /
  // income statement; here the user is looking at the orders themselves.
  $('#ordSumTotal').textContent = fmt$(round2(rows.reduce((s, o) => s + orderTotal(o), 0)));
  $('#ordSumProfit').textContent = fmt$(round2(rows.reduce((s, o) => s + orderProfit(o), 0)));

  // Per-order toggles + edit/delete + group-level paid/delivered. Shared so the
  // dashboard's pending/recent cards get the same interactions as the Orders page.
  wireOrderInteractions(body);

  // Group expand/collapse + row-click + Mixed-pill behavior (shared helper)
  wireGroupExpand(body);
}

// Wire paid/delivered toggles, group toggles, edit, and delete buttons inside
// any tbody that renders order rows (orders page, dashboard recent, dashboard pending).
function wireOrderInteractions(body) {
  body.querySelectorAll('[data-toggle-paid]').forEach(el => el.addEventListener('change', e => {
    const o = state.orders.find(x => x.id === e.target.dataset.togglePaid);
    if (!o) return;
    setOrderFullyPaid(o, e.target.checked);
    const stockTouched = reconcileOrderInventory(o);
    saveState();
    cloudUpsert('orders', o);
    if (stockTouched.length) cloudUpsertMany('stock', stockTouched);
    renderOrders(); renderInventory(); renderDashboard();
  }));
  body.querySelectorAll('[data-toggle-delivered]').forEach(el => el.addEventListener('change', e => {
    const o = state.orders.find(x => x.id === e.target.dataset.toggleDelivered);
    if (!o) return;
    o.delivered = e.target.checked;
    const stockTouched = reconcileOrderInventory(o);
    saveState();
    cloudUpsert('orders', o);
    if (stockTouched.length) cloudUpsertMany('stock', stockTouched);
    renderOrders(); renderInventory(); renderDashboard();
  }));
  body.querySelectorAll('[data-edit-order]').forEach(el => el.addEventListener('click', () => {
    const o = state.orders.find(x => x.id === el.dataset.editOrder);
    if (o) orderModal(o);
  }));
  body.querySelectorAll('[data-del-order]').forEach(el => el.addEventListener('click', () => {
    if (!confirm('Delete this order?')) return;
    const id = el.dataset.delOrder;
    const o = state.orders.find(x => x.id === id);
    const restored = (o && o.inventoryApplied) ? applyOrderInventoryDelta(o.items, +1) : [];
    state.orders = state.orders.filter(x => x.id !== id);
    saveState();
    cloudDelete('orders', id);
    if (restored.length) cloudUpsertMany('stock', restored);
    renderOrders();
    renderInventory();
    renderDashboard();
    toast('Order deleted.');
  }));
  // Open the partial-payment editor straight from a row pill, so the user
  // doesn't have to remember to use the pencil icon.
  body.querySelectorAll('[data-open-payments]').forEach(el => el.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const o = state.orders.find(x => x.id === el.dataset.openPayments);
    if (o) orderModal(o);
  }));
  body.querySelectorAll('[data-group-paid]').forEach(el => el.addEventListener('change', () => {
    const updated = [];
    const stockTouched = new Set();
    el.dataset.groupPaid.split(',').forEach(id => {
      const o = state.orders.find(x => x.id === id);
      if (!o) return;
      setOrderFullyPaid(o, el.checked);
      reconcileOrderInventory(o).forEach(p => stockTouched.add(p));
      updated.push(o);
    });
    saveState();
    cloudUpsertMany('orders', updated);
    if (stockTouched.size) cloudUpsertMany('stock', [...stockTouched]);
    renderOrders(); renderInventory(); renderDashboard();
  }));
  body.querySelectorAll('[data-group-delivered]').forEach(el => el.addEventListener('change', () => {
    const updated = [];
    const stockTouched = new Set();
    el.dataset.groupDelivered.split(',').forEach(id => {
      const o = state.orders.find(x => x.id === id);
      if (!o) return;
      o.delivered = el.checked;
      reconcileOrderInventory(o).forEach(p => stockTouched.add(p));
      updated.push(o);
    });
    saveState();
    cloudUpsertMany('orders', updated);
    if (stockTouched.size) cloudUpsertMany('stock', [...stockTouched]);
    renderOrders(); renderInventory(); renderDashboard();
  }));
}

function renderOrderGroup(g) {
  if (g.orders.length === 1) return renderSingleOrderRow(g.orders[0]);

  const groupId = 'g_' + (g.customer || '').replace(/\W+/g, '_') + '_' + (g.date || '').replace(/\W+/g, '');
  const totalQty = g.orders.reduce((s, o) => s + orderQty(o), 0);
  const totalAmt = g.orders.reduce((s, o) => s + orderTotal(o), 0);
  const totalProfit = g.orders.reduce((s, o) => s + orderProfit(o), 0);
  const totalLineItems = g.orders.reduce((s, o) => s + orderItems(o).length, 0);
  const allPaid = g.orders.every(o => o.paid);
  // Treat partial-payment orders as mixed so the user sees a "Mixed" pill (and
  // can drill in) instead of an unchecked toggle that misrepresents the state.
  const noPaid = g.orders.every(o => orderPaymentsTotal(o) <= 0.005);
  const allDelivered = g.orders.every(o => o.delivered);
  const noDelivered = g.orders.every(o => !o.delivered);

  const orderIds = g.orders.map(o => o.id).join(',');
  const childFlags = g.orders.map(o => orderStatusFlag(o));
  const aggCls = [
    'group-row',
    childFlags.includes('unpaid')  ? 'has-flag-unpaid'  : '',
    childFlags.includes('pending') ? 'has-flag-pending' : '',
  ].filter(Boolean).join(' ');

  const paidCell = (allPaid || noPaid)
    ? `<label class="switch"><input type="checkbox" data-group-paid="${orderIds}" ${allPaid ? 'checked' : ''} /><span class="slider"></span></label>`
    : `<span class="pill mixed" data-expand-group="${groupId}" title="Mixed — expand to see each">Mixed</span>`;
  const deliveredCell = (allDelivered || noDelivered)
    ? `<label class="switch"><input type="checkbox" data-group-delivered="${orderIds}" ${allDelivered ? 'checked' : ''} /><span class="slider"></span></label>`
    : `<span class="pill mixed" data-expand-group="${groupId}" title="Mixed — expand to see each">Mixed</span>`;

  let html = `
    <tr class="${aggCls}">
      <td>${fmtDateShort(g.date)}</td>
      <td><b>${escapeHtml(g.customer || '')}</b><span class="customer-sub">${totalLineItems} item${totalLineItems === 1 ? '' : 's'}</span></td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${totalLineItems} item${totalLineItems === 1 ? '' : 's'}</span></td>
      <td class="num">${fmtN(totalQty)}</td>
      <td class="num">${fmt$(totalAmt)}</td>
      <td class="num">${fmt$(totalProfit)}</td>
      <td>${paidCell}</td>
      <td>${deliveredCell}</td>
      <td></td>
    </tr>`;
  html += g.orders.map(o => {
    const flag = orderStatusFlag(o);
    const cls = ['child-row'];
    if (flag) cls.push(`row-flag-${flag}`);
    return `
    <tr class="${cls.join(' ')}" data-parent="${groupId}" hidden>
      <td colspan="9" class="child-cell">
        <div class="child-strip">
          <span class="cs-label">↳${statusFlagBadge(flag)}</span>
          <span class="cs-items">${itemsCellInline(orderItems(o))}</span>
          <span class="cs-stat"><span class="cs-tlabel">Total</span><b class="cs-stat-total">${fmt$(orderTotal(o))}</b></span>
          <span class="cs-stat"><span class="cs-tlabel">Profit</span><b>${fmt$(orderProfit(o))}</b></span>
          <span class="cs-toggle"><span class="cs-tlabel">Paid</span><label class="switch"><input type="checkbox" data-toggle-paid="${o.id}" ${o.paid ? 'checked' : ''} /><span class="slider"></span></label>${partialPaidPill(o)}</span>
          <span class="cs-toggle"><span class="cs-tlabel">Delivered</span><label class="switch"><input type="checkbox" data-toggle-delivered="${o.id}" ${o.delivered ? 'checked' : ''} /><span class="slider"></span></label></span>
          <span class="cs-actions">
            <button class="icon-btn" data-edit-order="${o.id}" title="Edit">✎</button>
            <button class="icon-btn danger" data-del-order="${o.id}" title="Delete">🗑</button>
          </span>
        </div>
      </td>
    </tr>`;
  }).join('');
  return html;
}

function renderSingleOrderRow(o) {
  const items = orderItems(o);
  const flag = orderStatusFlag(o);
  const flagCls = flag ? ` row-flag-${flag}` : '';
  if (items.length <= 1) {
    const it = items[0];
    const sub = it ? `<span class="customer-sub">${escapeHtml(it.product || '')}${(Number(it.qty) || 0) > 0 ? ` ×${fmtN(it.qty)}` : ''}</span>` : '';
    return `<tr class="${flagCls.trim()}">
      <td>${fmtDateShort(o.date)}</td>
      <td>${escapeHtml(o.customer || '')}${statusFlagBadge(flag)}${sub}</td>
      <td class="items-cell">${itemsCellInline(items)}</td>
      <td class="num">${fmtN(orderQty(o))}</td>
      <td class="num">${fmt$(orderTotal(o))}</td>
      <td class="num">${fmt$(orderProfit(o))}</td>
      <td><div class="paid-cell"><label class="switch"><input type="checkbox" data-toggle-paid="${o.id}" ${o.paid ? 'checked' : ''} /><span class="slider"></span></label>${partialPaidPill(o)}</div></td>
      <td><label class="switch"><input type="checkbox" data-toggle-delivered="${o.id}" ${o.delivered ? 'checked' : ''} /><span class="slider"></span></label></td>
      <td style="white-space:nowrap;">
        <button class="icon-btn" data-edit-order="${o.id}" title="Edit">✎</button>
        <button class="icon-btn danger" data-del-order="${o.id}" title="Delete">🗑</button>
      </td>
    </tr>`;
  }
  // Multi-item: parent row with chevron, plus child rows for each line item.
  const groupId = 'oi_' + String(o.id || '').replace(/\W+/g, '_');
  let html = `
    <tr class="group-row${flagCls}">
      <td>${fmtDateShort(o.date)}</td>
      <td>${escapeHtml(o.customer || '')}${statusFlagBadge(flag)}<span class="customer-sub">${items.length} items</span></td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${items.length} items</span></td>
      <td class="num">${fmtN(orderQty(o))}</td>
      <td class="num">${fmt$(orderTotal(o))}</td>
      <td class="num">${fmt$(orderProfit(o))}</td>
      <td><div class="paid-cell"><label class="switch"><input type="checkbox" data-toggle-paid="${o.id}" ${o.paid ? 'checked' : ''} /><span class="slider"></span></label>${partialPaidPill(o)}</div></td>
      <td><label class="switch"><input type="checkbox" data-toggle-delivered="${o.id}" ${o.delivered ? 'checked' : ''} /><span class="slider"></span></label></td>
      <td style="white-space:nowrap;">
        <button class="icon-btn" data-edit-order="${o.id}" title="Edit">✎</button>
        <button class="icon-btn danger" data-del-order="${o.id}" title="Delete">🗑</button>
      </td>
    </tr>`;
  html += items.map(it => `
    <tr class="child-row" data-parent="${groupId}" hidden>
      <td colspan="9" class="child-cell">
        <div class="child-strip">
          <span class="cs-label">↳</span>
          <span class="cs-items">${itemPill(it)}</span>
          <span class="cs-stat"><span class="cs-tlabel">Total</span><b class="cs-stat-total">${fmt$((Number(it.qty)||0)*(Number(it.price)||0))}</b></span>
          <span class="cs-stat"><span class="cs-tlabel">Profit</span><b>${fmt$(((Number(it.price)||0)-(Number(it.cogs)||0))*(Number(it.qty)||0))}</b></span>
        </div>
      </td>
    </tr>`).join('');
  return html;
}

function orderModal(existing, draft) {
  // `draft` is set when re-opening the form after the user previewed the
  // invoice — preserves their unsaved changes. Otherwise we hydrate from the
  // existing order (edit) or blank state (new).
  const data = draft
    ? JSON.parse(JSON.stringify(draft))
    : existing
      ? JSON.parse(JSON.stringify(existing))
      : { customer: '', date: todayISO(), paid: false, delivered: false, items: [], payments: [], notes: '', shipping: 0, discount: null };
  if (!Array.isArray(data.items)) data.items = [];
  if (data.items.length === 0) data.items.push(blankItem());
  if (!Array.isArray(data.payments)) data.payments = [];
  data.shipping = Number(data.shipping) || 0;
  // Normalize discount to { type, value } or null.
  if (!(data.discount && (data.discount.type === 'percent' || data.discount.type === 'amount') && Number(data.discount.value) > 0)) {
    data.discount = null;
  }

  $('#modalTitle').textContent = existing ? 'Edit Order' : 'New Order';
  // Reset any read-only popup state left over from a prior modal (invoice view,
  // Today popup, etc.) so the Save/Cancel footer is back to normal.
  modal.classList.remove('modal-readonly');
  $('#modalCancel').textContent = 'Cancel';
  const form = $('#modalForm');
  // Datalist values feed the typeable product input — typing filters matches.
  const productOptions = state.stock
    .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
    .join('');
  // Unique past customer names for autocomplete — typing filters, but any new name is accepted.
  const customerNames = [...new Set(
    state.orders.map(o => (o.customer || '').trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
  const customerOptions = customerNames
    .map(n => `<option value="${escapeHtml(n)}"></option>`)
    .join('');

  form.innerHTML = `
    <datalist id="orderProductList">${productOptions}</datalist>
    <datalist id="orderCustomerList">${customerOptions}</datalist>
    <div class="row-2">
      <label><span class="req">Customer</span><input type="text" name="customer" list="orderCustomerList" autocomplete="off" required value="${escapeHtml(data.customer || '')}" placeholder="Search or add customer…" /></label>
      <label><span class="req">Order Date</span><input type="date" name="date" required value="${data.date || todayISO()}" /></label>
    </div>
    <div class="items-section">
      <div class="items-head">
        <span class="label">Items</span>
        <button type="button" class="btn ghost add-item-btn" id="addItemBtn">+ Add Item</button>
      </div>
      <div class="items-col-head">
        <span>Product</span><span>Qty</span><span>Price</span><span></span>
      </div>
      <div id="itemsList"></div>
      <div class="items-summary">
        <span><span class="muted">Items</span> <b id="sumCount">0</b></span>
        <span><span class="muted">Qty</span> <b id="sumQty">0</b></span>
        <span><span class="muted">Total</span> <b id="sumTotal">$0</b></span>
        <span><span class="muted">Profit</span> <b id="sumProfit">$0</b></span>
      </div>
    </div>
    <div class="discount-section">
      <button type="button" class="btn ghost discount-toggle-btn" id="discountToggleBtn"${data.discount ? ' hidden' : ''}>+ Add Discount</button>
      <div class="discount-field"${data.discount ? '' : ' hidden'}>
        <label>
          <span>Discount</span>
          <div class="discount-input-wrap">
            <select id="discountType" name="discountType">
              <option value="amount"${(!data.discount || data.discount.type === 'amount') ? ' selected' : ''}>$ Off</option>
              <option value="percent"${(data.discount && data.discount.type === 'percent') ? ' selected' : ''}>% Off</option>
            </select>
            <input type="number" inputmode="numeric" id="discountValue" min="0" step="1" value="${data.discount ? data.discount.value : ''}" placeholder="0" />
            <span class="discount-applied" id="discountApplied"></span>
            <button type="button" class="icon-btn danger discount-remove" id="discountRemoveBtn" title="Remove discount">×</button>
          </div>
        </label>
        <div class="discount-exclude" id="discountExclude" hidden>
          <div class="discount-exclude-label">Apply discount to</div>
          <div id="discountExcludeList"></div>
        </div>
      </div>
    </div>
    <div class="row-2">
      <label class="toggle-row">
        <span class="toggle-row-label">Paid in Full</span>
        <span class="switch"><input type="checkbox" name="paid" ${data.paid ? 'checked' : ''} /><span class="slider"></span></span>
      </label>
      <label class="toggle-row">
        <span class="toggle-row-label">Delivered</span>
        <span class="switch"><input type="checkbox" name="delivered" ${data.delivered ? 'checked' : ''} /><span class="slider"></span></span>
      </label>
    </div>
    <div class="payments-section">
      <div class="payments-head">
        <span class="label">Payments</span>
        <button type="button" class="btn ghost add-payment-btn" id="addPaymentBtn">+ Add Payment</button>
      </div>
      <div class="payments-col-head">
        <span>Amount</span><span>Date</span><span></span>
      </div>
      <div id="paymentsList"></div>
      <div class="payments-summary">
        <span><span class="muted">Paid</span> <b id="sumPaid">$0</b></span>
        <span><span class="muted">Balance</span> <b id="sumBalance">$0</b></span>
        <span class="payments-status" id="sumPayStatus"></span>
      </div>
    </div>
    <div class="shipping-section">
      <button type="button" class="btn ghost shipping-toggle-btn" id="shippingToggleBtn"${(Number(data.shipping) || 0) > 0 ? ' hidden' : ''}>+ Add Shipping Charge</button>
      <label class="shipping-field"${(Number(data.shipping) || 0) > 0 ? '' : ' hidden'}>
        <span>Shipping Charge</span>
        <div class="shipping-input-wrap">
          <span class="shipping-prefix">$</span>
          <input type="number" name="shipping" step="0.01" min="0" value="${Number(data.shipping) || 0}" />
          <button type="button" class="icon-btn danger shipping-remove" id="shippingRemoveBtn" title="Remove shipping">×</button>
        </div>
      </label>
    </div>
    <div class="notes-section">
      <button type="button" class="btn ghost notes-toggle-btn" id="notesToggleBtn"${data.notes ? ' hidden' : ''}>+ Add Notes</button>
      <label class="notes-field"${data.notes ? '' : ' hidden'}>
        <span>Notes</span>
        <textarea name="notes" rows="3" placeholder="Add a note for this order…">${escapeHtml(data.notes || '')}</textarea>
      </label>
    </div>
    <button type="button" class="btn ghost" id="viewInvoiceBtn">View Invoice</button>
    ${existing ? '<button type="button" class="btn danger-outline" id="orderDeleteBtn">Delete Order</button>' : ''}
  `;

  function blankItem() {
    return { product: '', qty: 1, price: 0, cogs: 0 };
  }

  // Build a single item row. Handlers close over the item reference (not an
  // index) so removing a row doesn't leave stale data-idx values behind, and
  // we never have to rebuild the entire list when one row changes — that's the
  // root cause of the keyboard-dismiss / input-jank that used to hit users on
  // mobile after typing in the second or third line.
  function buildItemRow(it) {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <input type="text" list="orderProductList" data-field="product" value="${escapeHtml(it.product || '')}" placeholder="Search product…" autocomplete="off" />
      <input type="number" inputmode="numeric" min="1" step="1" data-field="qty" value="${it.qty ?? ''}" placeholder="Qty" />
      <input type="number" inputmode="decimal" min="0" step="any" data-field="price" value="${it.price ?? ''}" placeholder="Price" />
      <button type="button" class="icon-btn danger" data-remove title="Remove">×</button>
    `;
    const priceInput = row.querySelector('[data-field="price"]');
    row.querySelectorAll('[data-field]').forEach(el => {
      el.addEventListener('input', () => {
        const field = el.dataset.field;
        let val = el.value;
        if (field !== 'product') val = val === '' ? null : Number(val);
        it[field] = val;
        if (field === 'product') {
          const p = state.stock.find(s => (s.name || '').toLowerCase() === String(val || '').toLowerCase());
          if (p) {
            it.price = Number(p.price) || 0;
            it.cogs = Number(p.cost) || 0;
            if (priceInput) priceInput.value = it.price;
            // Dismiss the on-screen keyboard / datalist popover after a pick
            // so the user can scroll on to the next field without an extra tap.
            el.blur();
          }
        }
        updateSummary();
      });
    });
    row.querySelector('[data-remove]').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = data.items.indexOf(it);
      if (idx < 0) return;
      if (data.items.length === 1) {
        // Last row — clear in place instead of vanishing the editor.
        const blank = blankItem();
        Object.assign(it, blank);
        // Repopulate inputs from the cleared item without rebuilding the row,
        // so focus and scroll position are preserved.
        row.querySelector('[data-field="product"]').value = blank.product;
        row.querySelector('[data-field="qty"]').value = blank.qty;
        row.querySelector('[data-field="price"]').value = blank.price;
      } else {
        data.items.splice(idx, 1);
        row.remove();
      }
      updateSummary();
    });
    return row;
  }

  function renderItems() {
    const list = form.querySelector('#itemsList');
    list.innerHTML = '';
    data.items.forEach(it => list.appendChild(buildItemRow(it)));
    updateSummary();
  }

  function updateSummary() {
    form.querySelector('#sumCount').textContent = data.items.length;
    form.querySelector('#sumQty').textContent = fmtN(orderQty(data));
    form.querySelector('#sumTotal').textContent = fmt$(orderTotal(data));
    form.querySelector('#sumProfit').textContent = fmt$(orderProfit(data));
    // Show the resolved discount amount (e.g. "−$23" for a rounded 10%).
    const applied = form.querySelector('#discountApplied');
    if (applied) {
      const amt = orderDiscountAmount(data);
      applied.textContent = amt > 0 ? `−${fmt$(amt)}` : '';
    }
    renderDiscountExclusions();
    updatePaymentsSummary();
  }

  // "Apply discount to" checklist — one toggle per item, shown only when a
  // discount is active and there are 2+ items. Unchecking an item sets its
  // excludeDiscount flag so the discount skips it. Rebuilt from data each time
  // so product names stay current; checkbox state is read back from the item.
  function renderDiscountExclusions() {
    const wrap = form.querySelector('#discountExclude');
    const list = form.querySelector('#discountExcludeList');
    if (!wrap || !list) return;
    const field = form.querySelector('.discount-field');
    // Show the per-item checklist whenever the discount section is open and
    // there's more than one item — even before a value is typed — so it's
    // discoverable. Each item defaults to included; uncheck to exclude.
    const show = field && !field.hidden && data.items.length >= 2;
    wrap.hidden = !show;
    if (!show) return;
    list.innerHTML = '';
    data.items.forEach((it, idx) => {
      const row = document.createElement('label');
      row.className = 'discount-exclude-item';
      const name = (it.product || '').trim() || `Item ${idx + 1}`;
      const lineTotal = (Number(it.qty) || 0) * (Number(it.price) || 0);
      row.innerHTML = `
        <input type="checkbox" ${it.excludeDiscount ? '' : 'checked'} />
        <span class="dx-name">${escapeHtml(name)}</span>
        <span class="dx-amt muted">${fmt$(round2(lineTotal))}</span>
      `;
      row.querySelector('input').addEventListener('change', (e) => {
        it.excludeDiscount = !e.target.checked;
        updateSummary();
      });
      list.appendChild(row);
    });
  }

  form.querySelector('#addItemBtn').addEventListener('click', () => {
    const it = blankItem();
    data.items.push(it);
    const row = buildItemRow(it);
    form.querySelector('#itemsList').appendChild(row);
    updateSummary();
    // Drop focus onto the new product field so the user can immediately start
    // typing — uses focusForKeyboard to bring up the iOS keyboard reliably.
    focusForKeyboard(row.querySelector('[data-field="product"]'));
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // ---- Payments section ----
  // Row-level closures (no data-idx) so rows can be added or removed without
  // rebuilding the list — keyboard / scroll position stay put.
  function buildPaymentRow(p) {
    const row = document.createElement('div');
    row.className = 'payment-row';
    row.innerHTML = `
      <div class="payment-amount-wrap">
        <span class="payment-prefix">$</span>
        <input type="number" inputmode="numeric" min="0" step="1" data-pfield="amount" value="${p.amount ?? ''}" placeholder="0" />
      </div>
      <input type="date" data-pfield="date" value="${escapeHtml(p.date || '')}" />
      <button type="button" class="icon-btn danger" data-premove title="Remove payment">×</button>
    `;
    row.querySelectorAll('[data-pfield]').forEach(el => {
      el.addEventListener('input', () => {
        const field = el.dataset.pfield;
        let val = el.value;
        if (field === 'amount') val = val === '' ? 0 : Number(val);
        p[field] = val;
        updatePaymentsSummary();
      });
    });
    row.querySelector('[data-premove]').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = data.payments.indexOf(p);
      if (idx >= 0) data.payments.splice(idx, 1);
      row.remove();
      // Show the empty-state hint again if we just removed the last payment.
      if (!data.payments.length) ensurePaymentsEmptyState();
      updatePaymentsSummary();
    });
    return row;
  }

  function ensurePaymentsEmptyState() {
    const list = form.querySelector('#paymentsList');
    if (list.querySelector('.payments-empty')) return;
    if (data.payments.length) return;
    const empty = document.createElement('div');
    empty.className = 'payments-empty muted';
    empty.textContent = 'No payments yet. Add one to track partial or full payments.';
    list.appendChild(empty);
  }

  function renderPayments() {
    const list = form.querySelector('#paymentsList');
    list.innerHTML = '';
    if (!data.payments.length) {
      ensurePaymentsEmptyState();
    } else {
      data.payments.forEach(p => list.appendChild(buildPaymentRow(p)));
    }
    updatePaymentsSummary();
  }

  function updatePaymentsSummary() {
    const paid = orderPaymentsTotal(data);
    const total = orderTotal(data);
    const balance = Math.max(0, total - paid);
    const sumPaidEl = form.querySelector('#sumPaid');
    const sumBalEl = form.querySelector('#sumBalance');
    const statusEl = form.querySelector('#sumPayStatus');
    if (sumPaidEl) sumPaidEl.textContent = fmt$(paid);
    if (sumBalEl) sumBalEl.textContent = fmt$(balance);
    if (statusEl) {
      statusEl.innerHTML = '';
      if (total <= 0) {
        // No items yet — nothing meaningful to badge.
      } else if (paid <= 0.005) {
        statusEl.innerHTML = `<span class="pill amber">Unpaid</span>`;
      } else if (paid >= total - 0.005) {
        statusEl.innerHTML = `<span class="pill green">Paid in Full</span>`;
      } else {
        // "Paid $X · Balance $Y" labels above already carry the numbers; the
        // pill just colors the state.
        statusEl.innerHTML = `<span class="pill partial">Partial</span>`;
      }
    }
    // Keep the "Paid in Full" toggle reflecting reality. Don't bother dispatching
    // an event — the toggle is only inspected at save time.
    const paidToggle = form.querySelector('[name="paid"]');
    if (paidToggle) paidToggle.checked = paid >= total - 0.005 && total > 0;
  }

  form.querySelector('#addPaymentBtn').addEventListener('click', () => {
    // amount: null so the row renders an empty input — no need for a
    // programmatic .value reset, which can break iOS focus chaining.
    const p = {
      id: uid('p'),
      amount: null,
      date: todayISO(),
      method: '',
      note: '',
    };
    data.payments.push(p);
    const list = form.querySelector('#paymentsList');
    list.querySelector('.payments-empty')?.remove();
    const row = buildPaymentRow(p);
    list.appendChild(row);
    updatePaymentsSummary();
    // focusForKeyboard() handles the iOS quirk where focusing a freshly-
    // appended input silently fails to open the keyboard.
    const amountInput = row.querySelector('[data-pfield="amount"]');
    focusForKeyboard(amountInput);
    // Bring the new row into view AFTER focus, in the next frame, so the
    // scroll animation doesn't interrupt the keyboard activation.
    requestAnimationFrame(() => {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });

  // "Paid in Full" toggle is a shortcut: checking it tops up payments to the
  // full balance, unchecking it wipes payments. Granular control still lives
  // in the payments list below.
  const paidToggle = form.querySelector('[name="paid"]');
  paidToggle.addEventListener('change', () => {
    if (paidToggle.checked) {
      const balance = round2(Math.max(0, orderTotal(data) - orderPaymentsTotal(data)));
      if (balance > 0.005) {
        data.payments.push({
          id: uid('p'),
          amount: balance,
          date: todayISO(),
          method: '',
          note: '',
        });
      }
    } else {
      data.payments = [];
    }
    renderPayments();
  });

  // "+ Add Notes" reveals a textarea; once shown it stays visible (the button
  // hides). Existing orders with notes show the textarea expanded by default.
  const notesBtn = form.querySelector('#notesToggleBtn');
  const notesField = form.querySelector('.notes-field');
  notesBtn.addEventListener('click', () => {
    notesBtn.hidden = true;
    notesField.hidden = false;
    notesField.querySelector('textarea').focus();
  });

  // Shipping charge — same toggle pattern as Notes. The × button on the field
  // clears the amount and collapses back to the "+ Add Shipping Charge" button.
  const shipBtn = form.querySelector('#shippingToggleBtn');
  const shipField = form.querySelector('.shipping-field');
  const shipInput = shipField.querySelector('[name="shipping"]');
  const shipRemoveBtn = form.querySelector('#shippingRemoveBtn');
  shipBtn.addEventListener('click', () => {
    shipBtn.hidden = true;
    shipField.hidden = false;
    shipInput.focus();
    shipInput.select();
  });
  shipRemoveBtn.addEventListener('click', () => {
    shipInput.value = '0';
    data.shipping = 0;
    shipField.hidden = true;
    shipBtn.hidden = false;
    updateSummary();
  });
  // Live-update the items summary when shipping changes so Total reflects it.
  shipInput.addEventListener('input', () => {
    data.shipping = Number(shipInput.value) || 0;
    updateSummary();
  });

  // Discount — same toggle pattern. The type selector ($ off / % off) and value
  // both write back to data.discount; the × clears it. updateSummary() shows
  // the resolved amount (percentages round up to a whole dollar).
  const discountBtn = form.querySelector('#discountToggleBtn');
  const discountField = form.querySelector('.discount-field');
  const discountType = form.querySelector('#discountType');
  const discountValue = form.querySelector('#discountValue');
  const discountRemoveBtn = form.querySelector('#discountRemoveBtn');
  function syncDiscountFromInputs() {
    const v = Number(discountValue.value) || 0;
    data.discount = v > 0 ? { type: discountType.value === 'percent' ? 'percent' : 'amount', value: v } : null;
    updateSummary();
  }
  discountBtn.addEventListener('click', () => {
    discountBtn.hidden = true;
    discountField.hidden = false;
    updateSummary(); // render the "Apply discount to" checklist immediately
    focusForKeyboard(discountValue);
  });
  discountRemoveBtn.addEventListener('click', () => {
    discountValue.value = '';
    data.discount = null;
    discountField.hidden = true;
    discountBtn.hidden = false;
    updateSummary();
  });
  discountType.addEventListener('change', syncDiscountFromInputs);
  discountValue.addEventListener('input', syncDiscountFromInputs);

  renderItems();
  renderPayments();

  modalOnSave = () => {
    const customer = form.querySelector('[name="customer"]').value.trim();
    const date = form.querySelector('[name="date"]').value;
    const delivered = form.querySelector('[name="delivered"]').checked;
    const notes = form.querySelector('[name="notes"]').value.trim();
    // If the shipping section is hidden the user has no charge — save 0
    // regardless of whatever stale value is in the input.
    const shipping = shipField.hidden ? 0 : (Number(shipInput.value) || 0);
    if (!customer) { alert('Customer is required.'); return; }
    if (!date) { alert('Date is required.'); return; }
    if (!data.items.length) { alert('Add at least one item.'); return; }
    for (const it of data.items) {
      if (!it.product) { alert('Each item needs a product.'); return; }
      if (!it.qty || it.qty <= 0) { alert('Each item needs a quantity > 0.'); return; }
    }
    // Sanitize payments — snap amounts to whole cents (no FP drift surviving
    // a round trip) and drop entries the user added but never filled in.
    const cleanPayments = data.payments
      .map(p => ({
        id: p.id || uid('p'),
        amount: round2(p.amount),
        date: p.date || date,
        method: (p.method || '').trim(),
        note: (p.note || '').trim(),
      }))
      .filter(p => p.amount > 0.005);
    // Discount: keep it whenever there's a positive value entered. Driven by
    // the value alone (not the field's hidden state) so it saves reliably.
    // Removing a discount clears the input, so value 0/empty → null.
    const discount = Number(discountValue.value) > 0
      ? { type: discountType.value === 'percent' ? 'percent' : 'amount', value: round2(Number(discountValue.value)) }
      : null;
    const payload = {
      customer, date, delivered,
      items: data.items, payments: cleanPayments,
      notes, shipping, discount,
    };
    // `paid` is derived from payments — compute it from the payload, don't
    // trust the toggle (the user may have left the payments section in a state
    // that disagrees with the toggle).
    payload.paid = orderIsFullyPaid(payload);
    let saved;
    const stockTouched = new Set();
    // Inventory is only adjusted once an order is BOTH paid AND delivered.
    // Strategy: undo the existing applied deduction (using its OLD items so
    // mid-edit item changes don't strand stock), then reapply the new state via
    // reconcileOrderInventory once the payload is in place.
    if (existing) {
      if (existing.inventoryApplied) {
        applyOrderInventoryDelta(existing.items, +1).forEach(p => stockTouched.add(p));
        existing.inventoryApplied = false;
      }
      Object.assign(existing, payload);
      saved = existing;
      toast('Order updated.');
    } else {
      saved = { id: uid('o'), inventoryApplied: false, ...payload };
      state.orders.push(saved);
      toast('Order added.');
    }
    reconcileOrderInventory(saved).forEach(p => stockTouched.add(p));
    saveState();
    cloudUpsert('orders', saved);
    if (stockTouched.size) cloudUpsertMany('stock', [...stockTouched]);
    renderOrders();
    renderInventory();
    renderDashboard();
    closeModal();
  };

  // "View Invoice" — preview the invoice for this order without saving. Captures
  // the user's current form values into a draft so re-opening the form via the
  // Back button preserves their unsaved edits.
  form.querySelector('#viewInvoiceBtn').addEventListener('click', () => {
    const draft = {
      customer: form.querySelector('[name="customer"]').value.trim(),
      date: form.querySelector('[name="date"]').value || todayISO(),
      paid: form.querySelector('[name="paid"]').checked,
      delivered: form.querySelector('[name="delivered"]').checked,
      notes: form.querySelector('[name="notes"]').value.trim(),
      shipping: shipField.hidden ? 0 : (Number(shipInput.value) || 0),
      items: data.items,
      payments: data.payments,
      discount: data.discount || null,
    };
    modal.classList.add('modal-readonly');
    $('#modalCancel').textContent = 'Close';
    renderInvoiceView({
      formEl: form,
      orders: [draft],
      customerName: draft.customer || 'Customer',
      dateKey: draft.date,
      onBack: () => orderModal(existing, draft),
      allowNotesEdit: false,
    });
  });

  if (existing) {
    form.querySelector('#orderDeleteBtn').addEventListener('click', () => {
      if (!confirm('Delete this order? This cannot be undone.')) return;
      // Restore inventory only if this order was currently deducting stock
      // (inventoryApplied flag). Avoids double-restoring orders that never
      // consumed inventory in the first place.
      const restored = existing.inventoryApplied ? applyOrderInventoryDelta(existing.items, +1) : [];
      const id = existing.id;
      state.orders = state.orders.filter(x => x.id !== id);
      saveState();
      cloudDelete('orders', id);
      if (restored.length) cloudUpsertMany('stock', restored);
      renderOrders();
      renderInventory();
      renderDashboard();
      toast('Order deleted.');
      closeModal();
    });
  }

  showModal();
  setTimeout(() => form.querySelector('[name="customer"]').focus(), 50);
}

// ---------- INVENTORY ----------
const stkSearch = $('#stkSearch');
const stkFilter = $('#stkFilter');
persistFilter(stkSearch, 'lumen.stock.search');
persistFilter(stkFilter, 'lumen.stock.filter');
wireSearchClear(stkSearch);
[stkSearch, stkFilter].forEach(el => el.addEventListener('input', renderInventory));
$('#stkReset').addEventListener('click', () => resetFilters([stkSearch, stkFilter]));
$('#addStockBtn').addEventListener('click', () => stockModal());

// Apply a delta to stock for a list of order items.
// direction = -1 to deduct (a new sale), +1 to restore (deletion / undo).
// Returns the list of stock products that were modified, so callers can sync to cloud.
function applyOrderInventoryDelta(items, direction) {
  const updated = [];
  for (const it of items || []) {
    if (!it || !it.product) continue;
    const qty = Number(it.qty) || 0;
    if (qty <= 0) continue;
    const target = (it.product || '').toLowerCase().trim();
    const product = state.stock.find(p => (p.name || '').toLowerCase().trim() === target);
    if (!product) continue;
    product.qty = Math.max(0, (Number(product.qty) || 0) + direction * qty);
    if (product.qty > 0 && product.status !== 'ACTIVE') product.status = 'ACTIVE';
    if (!updated.includes(product)) updated.push(product);
  }
  return updated;
}

// Reorder thresholds. A product's reorder level is its own `reorder` value when
// set (> 0), otherwise a sensible global default. "Needs reorder" = an active
// product whose qty has fallen to or below that level (out-of-stock included).
const DEFAULT_REORDER_LEVEL = 5;
function stockReorderLevel(s) {
  const v = Number(s && s.reorder);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_REORDER_LEVEL;
}
function stockIsActive(s) { return ((s && s.status) || 'ACTIVE') === 'ACTIVE'; }
function stockIsOut(s) { return stockIsActive(s) && (Number(s && s.qty) || 0) <= 0; }
function stockNeedsReorder(s) {
  return stockIsActive(s) && (Number(s && s.qty) || 0) <= stockReorderLevel(s);
}

function renderInventory() {
  const q = stkSearch.value.toLowerCase().trim();
  const f = stkFilter.value;
  let rows = [...state.stock];
  if (q) rows = rows.filter(p => (p.name || '').toLowerCase().includes(q));
  if (f === 'active') rows = rows.filter(p => p.status === 'ACTIVE');
  if (f === 'oos') rows = rows.filter(p => p.status !== 'ACTIVE' || Number(p.qty) === 0);
  if (f === 'low') rows = rows.filter(p => stockNeedsReorder(p));

  // sort: active first, then qty desc
  rows.sort((a, b) => (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1) || (b.qty - a.qty));

  $('#stockBody').innerHTML = rows.map(p => {
    const margin = (Number(p.price) || 0) - (Number(p.cost) || 0);
    const valNet = margin * (Number(p.qty) || 0);
    const valGross = (Number(p.price) || 0) * (Number(p.qty) || 0);
    const isActive = p.status === 'ACTIVE';
    const out = stockIsOut(p);
    const needs = stockNeedsReorder(p);
    const lvl = stockReorderLevel(p);
    const customLvl = Number(p.reorder) > 0;
    const statusPill = !isActive
      ? `<span class="pill red">Out of Stock</span>`
      : out
        ? `<span class="pill red">Reorder · Out</span>`
        : needs
          ? `<span class="pill amber">Reorder</span>`
          : `<span class="pill green">Active</span>`;
    return `<tr${needs ? ' class="row-reorder"' : ''}>
      <td><b>${escapeHtml(p.name)}</b></td>
      <td class="num">${fmt$(p.cost)}</td>
      <td class="num">${fmt$(p.price)}</td>
      <td class="num"><b>${fmtN(p.qty)}</b></td>
      <td class="num muted${customLvl ? ' reorder-custom' : ''}" title="${customLvl ? 'Custom reorder level' : 'Default reorder level'}">${fmtN(lvl)}</td>
      <td class="num">${fmt$(margin)}</td>
      <td class="num">${fmt$(valNet)}</td>
      <td class="num">${fmt$(valGross)}</td>
      <td>${statusPill}</td>
      <td style="white-space:nowrap;">
        <button class="icon-btn" data-edit-stock="${p.id}" title="Edit">✎</button>
        <button class="icon-btn danger" data-del-stock="${p.id}" title="Delete">🗑</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="10" class="muted" style="padding:24px;text-align:center;">No products match.</td></tr>`;

  // Summary tiles at the top of the page — respect the current search/filter so
  // they reflect exactly what's visible (e.g. filtering to Low Stock recalcs).
  const sumNet = rows.reduce((s, p) => s + ((Number(p.price) || 0) - (Number(p.cost) || 0)) * (Number(p.qty) || 0), 0);
  const sumGross = rows.reduce((s, p) => s + (Number(p.price) || 0) * (Number(p.qty) || 0), 0);
  const margin = sumGross > 0 ? (sumNet / sumGross) * 100 : 0;
  $('#invKpiCount').textContent = fmtN(rows.length);
  $('#invKpiGross').textContent = fmt$(sumGross);
  $('#invKpiNet').textContent = fmt$(sumNet);
  $('#invKpiMargin').textContent = `${margin.toFixed(1)}%`;

  $$('#stockBody [data-edit-stock]').forEach(el => el.addEventListener('click', () => {
    const p = state.stock.find(x => x.id === el.dataset.editStock);
    if (p) stockModal(p);
  }));
  $$('#stockBody [data-del-stock]').forEach(el => el.addEventListener('click', () => {
    if (!confirm('Delete this product?')) return;
    const id = el.dataset.delStock;
    state.stock = state.stock.filter(x => x.id !== id);
    saveState(); cloudDelete('stock', id); renderInventory(); renderDashboard(); toast('Product deleted.');
  }));
}

function stockModal(existing) {
  const initial = existing ? { ...existing } : { name: '', cost: 0, price: 0, qty: 0, status: 'ACTIVE', reorder: '' };
  openModal(existing ? 'Edit Product' : 'New Product', [
    { name: 'name', label: 'Product Name', required: true },
    { type: 'row', fields: [
      { name: 'cost', label: 'Purchase Price (Cost)', type: 'number', min: 0 },
      { name: 'price', label: 'Selling Price', type: 'number', min: 0 },
    ]},
    { type: 'row', fields: [
      { name: 'qty', label: 'Quantity Available', type: 'number', min: 0 },
      { name: 'reorder', label: 'Reorder At', type: 'number', min: 0, placeholder: `Alert level (default ${DEFAULT_REORDER_LEVEL})` },
    ]},
    { name: 'status', label: 'Status', type: 'select', options: [
      { value: 'ACTIVE', label: 'Active' },
      { value: 'OUT OF STOCK', label: 'Out of Stock' },
    ]},
  ], (data) => {
    if (!data.name) { alert('Name is required.'); return false; }
    let saved;
    let renameSummary = null;
    if (existing) {
      const oldName = (existing.name || '').trim();
      const newName = (data.name || '').trim();
      // Cascade rename: if the product name changed, update every shipment
      // and order line item that referenced the old name (case-insensitive
      // match) so inventory linkage stays intact.
      if (oldName && newName && oldName.toLowerCase() !== newName.toLowerCase()) {
        const target = oldName.toLowerCase();
        const shipMatches = state.shipments.filter(s =>
          (s.product || '').toLowerCase().trim() === target
        );
        const orderMatches = state.orders.filter(o =>
          (o.items || []).some(it => (it.product || '').toLowerCase().trim() === target)
        );
        const refCount = shipMatches.length + orderMatches.length;
        if (refCount > 0) {
          const ok = confirm(
            `Rename "${oldName}" → "${newName}"?\n\n` +
            `${shipMatches.length} shipment${shipMatches.length === 1 ? '' : 's'} and ` +
            `${orderMatches.length} order${orderMatches.length === 1 ? '' : 's'} reference this product. ` +
            `They'll be updated to the new name so inventory tracking keeps working.`
          );
          if (!ok) return false;
          shipMatches.forEach(s => { s.product = newName; });
          orderMatches.forEach(o => {
            (o.items || []).forEach(it => {
              if ((it.product || '').toLowerCase().trim() === target) it.product = newName;
            });
          });
          renameSummary = { ships: shipMatches, orders: orderMatches };
        }
      }
      Object.assign(existing, data);
      saved = existing;
    } else {
      saved = { id: uid('s'), ...data };
      state.stock.push(saved);
    }
    saveState();
    cloudUpsert('stock', saved);
    if (renameSummary) {
      if (renameSummary.ships.length) cloudUpsertMany('shipments', renameSummary.ships);
      if (renameSummary.orders.length) cloudUpsertMany('orders', renameSummary.orders);
      renderShipments();
      renderOrders();
    }
    renderInventory();
    renderDashboard();
    if (renameSummary) {
      const total = renameSummary.ships.length + renameSummary.orders.length;
      toast(`Renamed. ${total} reference${total === 1 ? '' : 's'} updated.`);
    } else {
      toast(existing ? 'Product updated.' : 'Product added.');
    }
  }, initial);
}

// ---------- SHIPMENTS ----------
const shipSearch = $('#shipSearch');
const shipFilter = $('#shipFilter');
const shipSort = $('#shipSort');
persistFilter(shipSearch, 'lumen.shipments.search');
persistFilter(shipFilter, 'lumen.shipments.filter');
persistFilter(shipSort, 'lumen.shipments.sort');
[shipSearch, shipFilter, shipSort].forEach(el => el.addEventListener('input', renderShipments));
$('#shipReset').addEventListener('click', () => resetFilters([shipSearch, shipFilter, shipSort]));
$('#addShipBtn').addEventListener('click', () => shipModal());

// Adjust the matching stock product's qty when a shipment's delivered state flips.
// Returns the affected stock row (or null) so callers can sync it to the cloud.
// Cutoff date — only shipments ordered AFTER this date contribute to inventory.
// Prior shipments are treated as historical and don't affect stock counts.
const SHIPMENT_INVENTORY_CUTOFF = '2026-04-14';

// 1 kit = 10 vials. Shipments default to "kits" unless explicitly set to "qty".
const KIT_TO_VIAL_MULTIPLIER = 10;

function shipmentVialCount(shipment) {
  const n = parseInt(shipment.kits, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = shipment.unit === 'qty' ? 'qty' : 'kits';
  return unit === 'kits' ? n * KIT_TO_VIAL_MULTIPLIER : n;
}

function applyShipmentInventoryDelta(shipment, isDelivered) {
  if (!shipment || !shipment.product) return null;
  // Skip shipments ordered on/before the cutoff.
  if ((shipment.dateOrdered || '') <= SHIPMENT_INVENTORY_CUTOFF) return null;
  const vials = shipmentVialCount(shipment);
  if (vials <= 0) return null;
  const target = (shipment.product || '').toLowerCase().trim();
  const product = state.stock.find(p => (p.name || '').toLowerCase().trim() === target);
  if (!product) return null;
  const delta = isDelivered ? vials : -vials;
  product.qty = Math.max(0, (Number(product.qty) || 0) + delta);
  if (product.qty > 0 && product.status !== 'ACTIVE') product.status = 'ACTIVE';
  return product;
}

// Find an existing stock product by case-insensitive name; create one if none
// matches. Used by the shipment flow so a typed-but-new product gets added to
// inventory automatically (qty 0 until the shipment is delivered).
function ensureStockProduct(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return { product: null, created: false };
  const target = trimmed.toLowerCase();
  let product = state.stock.find(p => (p.name || '').toLowerCase().trim() === target);
  if (product) return { product, created: false };
  product = { id: uid('p'), name: trimmed, cost: 0, price: 0, qty: 0, status: 'ACTIVE' };
  state.stock.push(product);
  return { product, created: true };
}

// Capture which groups are currently expanded inside a tbody so we can restore
// them after a re-render. Without this, toggling paid/delivered re-renders the
// whole table and the user's open dropdowns collapse.
function getExpandedGroupIds(body) {
  if (!body) return new Set();
  return new Set(
    Array.from(body.querySelectorAll('[data-toggle-group].expanded'))
      .map(el => el.dataset.toggleGroup)
  );
}
function restoreGroupExpansion(body, ids) {
  if (!body || !ids || !ids.size) return;
  ids.forEach(id => {
    const chev = body.querySelector(`[data-toggle-group="${id}"]`);
    if (!chev) return;
    chev.classList.add('expanded');
    chev.closest('tr')?.classList.add('expanded');
    body.querySelectorAll(`[data-parent="${id}"]`).forEach(c => c.hidden = false);
  });
}

// Shared helper: wire up the expand/collapse chevron + tap-to-expand cell + Mixed-pill
// behavior for any tbody that uses the .group-row / .child-row pattern.
function wireGroupExpand(body) {
  body.querySelectorAll('[data-toggle-group]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = el.dataset.toggleGroup;
    const expanded = el.classList.toggle('expanded');
    el.closest('tr')?.classList.toggle('expanded', expanded);
    body.querySelectorAll(`[data-parent="${id}"]`).forEach(c => c.hidden = !expanded);
  }));
  body.querySelectorAll('[data-expand-group]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const chev = body.querySelector(`[data-toggle-group="${el.dataset.expandGroup}"]`);
    if (chev && !chev.classList.contains('expanded')) chev.click();
  }));

  // Restrict tap-to-expand to identifier cells (items column + vendor/customer
  // column). Date / qty / total / switches / actions cells no longer trigger
  // expansion when tapped.
  function tapToExpand(cell, e) {
    if (e.target.closest('label.switch, button, input, .pill, [data-toggle-group]')) return;
    const chev = cell.closest('tr')?.querySelector('[data-toggle-group]');
    if (chev) chev.click();
  }
  body.querySelectorAll('.group-row .items-cell').forEach(cell => {
    cell.addEventListener('click', (e) => tapToExpand(cell, e));
  });
  // Per-table: also enable tap-to-expand on the vendor/customer cell.
  let extraSelector = null;
  if (body.id === 'shipBody' || body.id === 'expBody') {
    extraSelector = '.group-row > td:first-child';                  // vendor
  } else if (body.id === 'ordersBody' || body.id === 'recentOrdersBody' || body.id === 'pendingOrdersBody') {
    extraSelector = '.group-row > td:nth-child(2)';                  // customer
  }
  if (extraSelector) {
    body.querySelectorAll(extraSelector).forEach(cell => {
      cell.addEventListener('click', (e) => tapToExpand(cell, e));
    });
  }
}

function renderShipments() {
  const q = shipSearch.value.toLowerCase().trim();
  const f = shipFilter.value;
  const shipDir = shipSort.value === 'asc' ? 1 : -1;
  let rows = [...state.shipments].sort((a, b) =>
    shipDir * ((a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
  );
  if (q) rows = rows.filter(s => [s.vendor, s.product, s.tracking].join(' ').toLowerCase().includes(q));
  if (f === 'pending') rows = rows.filter(s => !s.delivered);
  if (f === 'delivered') rows = rows.filter(s => s.delivered);

  // Group by vendor + date + tracking — same vendor/day OR same tracking number
  // collapses into one row with a dropdown. Re-sort the groups to honor the
  // user's chosen direction (consolidateShipments hard-codes desc internally).
  const groups = consolidateShipments(rows).sort((a, b) =>
    shipDir * ((a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
  );

  const body = $('#shipBody');
  const expandedBefore = getExpandedGroupIds(body);
  body.innerHTML = groups.map(g => renderShipmentGroup(g)).join('') ||
    `<tr><td colspan="7" class="muted" style="padding:24px;text-align:center;">No shipments match.</td></tr>`;
  restoreGroupExpansion(body, expandedBefore);

  body.querySelectorAll('[data-ship-delivered]').forEach(el => el.addEventListener('change', e => {
    const s = state.shipments.find(x => x.id === el.dataset.shipDelivered);
    if (!s) return;
    const wasDelivered = !!s.delivered;
    s.delivered = e.target.checked;
    let stockChanged = null;
    if (wasDelivered !== s.delivered) stockChanged = applyShipmentInventoryDelta(s, s.delivered);
    saveState();
    cloudUpsert('shipments', s);
    if (stockChanged) {
      cloudUpsert('stock', stockChanged);
      toast(`Inventory updated: ${stockChanged.name} now ${fmtN(stockChanged.qty)}.`);
    }
    renderShipments(); renderInventory(); renderDashboard();
  }));
  body.querySelectorAll('[data-edit-ship]').forEach(el => el.addEventListener('click', () => {
    const s = state.shipments.find(x => x.id === el.dataset.editShip);
    if (s) shipModal(s);
  }));
  body.querySelectorAll('[data-del-ship]').forEach(el => el.addEventListener('click', () => {
    if (!confirm('Delete this shipment?')) return;
    const id = el.dataset.delShip;
    state.shipments = state.shipments.filter(x => x.id !== id);
    saveState(); cloudDelete('shipments', id); renderShipments(); toast('Shipment deleted.');
  }));
  body.querySelectorAll('[data-edit-ship-group]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    const ids = el.dataset.editShipGroup.split(',');
    const groupShipments = ids.map(id => state.shipments.find(x => x.id === id)).filter(Boolean);
    if (groupShipments.length) shipGroupModal(groupShipments);
  }));
  body.querySelectorAll('[data-group-ship-delivered]').forEach(el => el.addEventListener('change', () => {
    const updated = [];
    const stockUpdated = [];
    el.dataset.groupShipDelivered.split(',').forEach(id => {
      const s = state.shipments.find(x => x.id === id);
      if (!s) return;
      const wasDelivered = !!s.delivered;
      s.delivered = el.checked;
      updated.push(s);
      if (wasDelivered !== s.delivered) {
        const p = applyShipmentInventoryDelta(s, s.delivered);
        if (p && !stockUpdated.includes(p)) stockUpdated.push(p);
      }
    });
    saveState();
    cloudUpsertMany('shipments', updated);
    if (stockUpdated.length) cloudUpsertMany('stock', stockUpdated);
    renderShipments(); renderInventory(); renderDashboard();
  }));
  wireGroupExpand(body);
}

// Group shipments into one row when they share vendor+date OR a tracking number.
// We walk shipments in order and union-find them by either matching key.
function consolidateShipments(shipments) {
  const groups = [];
  const byVendorDate = new Map();
  const byTracking = new Map();
  for (const s of shipments) {
    const vd = (s.vendor || '').toLowerCase().trim() + '|' + (s.dateOrdered || '');
    const tk = (s.tracking || '').trim().toLowerCase();
    let group = byVendorDate.get(vd) || (tk && byTracking.get(tk));
    if (!group) {
      group = { vendor: s.vendor, dateOrdered: s.dateOrdered, shipments: [] };
      groups.push(group);
    }
    group.shipments.push(s);
    byVendorDate.set(vd, group);
    if (tk) byTracking.set(tk, group);
  }
  return groups.sort((a, b) => (b.dateOrdered || '').localeCompare(a.dateOrdered || ''));
}

function renderShipmentGroup(g) {
  if (g.shipments.length === 1) return renderSingleShipmentRow(g.shipments[0]);

  const groupId = 'sg_' + (g.vendor || '').replace(/\W+/g, '_') + '_' + (g.dateOrdered || '').replace(/\W+/g, '');
  const allDelivered = g.shipments.every(s => s.delivered);
  const noDelivered = g.shipments.every(s => !s.delivered);
  const shipIds = g.shipments.map(s => s.id).join(',');

  const deliveredCell = (allDelivered || noDelivered)
    ? `<label class="switch"><input type="checkbox" data-group-ship-delivered="${shipIds}" ${allDelivered ? 'checked' : ''} /><span class="slider"></span></label>`
    : `<span class="pill mixed" data-expand-group="${groupId}" title="Mixed — expand to see each">Mixed</span>`;

  // Show shared tracking number (if all the same) on the parent row.
  const trackings = g.shipments.map(s => (s.tracking || '').trim()).filter(Boolean);
  const distinctTrackings = [...new Set(trackings)];
  const groupTracking = distinctTrackings[0] || '';
  const groupTrackingCell = groupTracking
    ? `<span style="font-family:monospace;font-size:12px;">${escapeHtml(groupTracking)}</span>${distinctTrackings.length > 1 ? ' <span class="muted" title="Children have different tracking numbers — expand to see each">+' + (distinctTrackings.length - 1) + '</span>' : ''}`
    : '<span class="muted">—</span>';

  let html = `
    <tr class="group-row">
      <td><b>${escapeHtml(g.vendor || '')}</b></td>
      <td>${fmtDateShort(g.dateOrdered)}</td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${g.shipments.length} item${g.shipments.length === 1 ? '' : 's'}</span></td>
      <td>${groupTrackingCell}</td>
      <td>${deliveredCell}</td>
      <td><button class="icon-btn" data-edit-ship-group="${shipIds}" title="Edit group">✎</button></td>
    </tr>`;
  html += g.shipments.map(s => {
    const n = Number(s.kits) || 0;
    const amtInner = s.unit === 'qty'
      ? `×${fmtN(n)}`
      : `×${fmtN(n)} Kit${n === 1 ? '' : 's'}`;
    // Pill matches the order modal's item-pill: product name + qty in muted color.
    const pill = `<span class="item-pill"><span class="ip-name">${escapeHtml(s.product || '')}</span><span class="ip-qty">${amtInner}</span></span>`;
    return `
    <tr class="child-row child-row-cells" data-parent="${groupId}" hidden>
      <td colspan="3" class="cs-product-cell"><span class="cs-label">↳</span> ${pill}</td>
      <td></td>
      <td><label class="switch"><input type="checkbox" data-ship-delivered="${s.id}" ${s.delivered ? 'checked' : ''}/><span class="slider"></span></label></td>
      <td style="white-space:nowrap;">
        <button class="icon-btn" data-edit-ship="${s.id}" title="Edit">✎</button>
        <button class="icon-btn danger" data-del-ship="${s.id}" title="Delete">🗑</button>
      </td>
    </tr>`;
  }).join('');
  return html;
}

function renderSingleShipmentRow(s) {
  const n = Number(s.kits) || 0;
  const amtInner = n > 0
    ? (s.unit === 'qty' ? `×${fmtN(n)}` : `×${fmtN(n)} Kit${n === 1 ? '' : 's'}`)
    : '';
  // Match the dropdown child rows: product + amount as a single pill.
  const pill = `<span class="item-pill"><span class="ip-name">${escapeHtml(s.product || '')}</span>${amtInner ? `<span class="ip-qty">${amtInner}</span>` : ''}</span>`;
  return `<tr>
    <td>${escapeHtml(s.vendor || '')}</td>
    <td>${fmtDateShort(s.dateOrdered)}</td>
    <td>${pill}</td>
    <td><span style="font-family:monospace;font-size:12px;">${escapeHtml(s.tracking || '')}</span></td>
    <td><label class="switch"><input type="checkbox" data-ship-delivered="${s.id}" ${s.delivered ? 'checked' : ''}/><span class="slider"></span></label></td>
    <td style="white-space:nowrap;">
      <button class="icon-btn" data-edit-ship="${s.id}" title="Edit">✎</button>
      <button class="icon-btn danger" data-del-ship="${s.id}" title="Delete">🗑</button>
    </td>
  </tr>`;
}

function shipModal(existing) {
  // Edit path: single shipment record. Custom form so we get the same
  // typeable product field (with datalist autocomplete from inventory) and
  // labeled Unit dropdown that the New Shipment modal uses.
  if (existing) {
    const ed = {
      vendor: existing.vendor || '',
      dateOrdered: existing.dateOrdered || '',
      tracking: existing.tracking || '',
      delivered: !!existing.delivered,
      product: existing.product || '',
      kits: existing.kits == null ? '' : String(existing.kits),
      unit: existing.unit === 'qty' ? 'qty' : 'kits',
    };

    $('#modalTitle').textContent = 'Edit Shipment';
    const form = $('#modalForm');

    const productOptions = state.stock
      .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
      .join('');

    form.innerHTML = `
      <datalist id="shipEditProductList">${productOptions}</datalist>
      <div class="row-2">
        <label><span class="req">Vendor</span><input type="text" name="vendor" required value="${escapeHtml(ed.vendor)}" placeholder="e.g. Lumen Peptides" /></label>
        <label><span>Date Ordered</span><input type="date" name="dateOrdered" value="${ed.dateOrdered}" /></label>
      </div>
      <label><span class="req">Product</span><input type="text" name="product" list="shipEditProductList" autocomplete="off" required value="${escapeHtml(ed.product)}" placeholder="Search or add product…" /></label>
      <div class="row-2">
        <label><span>Amount</span><input type="number" name="kits" min="0" step="1" value="${escapeHtml(ed.kits)}" placeholder="e.g. 5" /></label>
        <label><span>Unit</span>
          <select name="unit">
            <option value="kits" ${ed.unit === 'kits' ? 'selected' : ''}>Kits (×10)</option>
            <option value="qty" ${ed.unit === 'qty' ? 'selected' : ''}>Qty</option>
          </select>
        </label>
      </div>
      <div class="row-2">
        <label><span>Tracking Number</span><input type="text" name="tracking" value="${escapeHtml(ed.tracking)}" placeholder="optional" /></label>
        <label class="toggle-row">
          <span class="toggle-row-label">Delivered</span>
          <span class="switch"><input type="checkbox" name="delivered" ${ed.delivered ? 'checked' : ''} /><span class="slider"></span></span>
        </label>
      </div>
      <button type="button" class="btn danger-outline" id="shipDeleteBtn">Delete Shipment</button>
    `;

    modalOnSave = () => {
      const vendor = form.querySelector('[name="vendor"]').value.trim();
      const dateOrdered = form.querySelector('[name="dateOrdered"]').value;
      const product = form.querySelector('[name="product"]').value.trim();
      const kits = form.querySelector('[name="kits"]').value;
      const unit = form.querySelector('[name="unit"]').value === 'qty' ? 'qty' : 'kits';
      const tracking = form.querySelector('[name="tracking"]').value.trim();
      const delivered = form.querySelector('[name="delivered"]').checked;
      if (!vendor) { alert('Vendor is required.'); return; }
      if (!product) { alert('Product is required.'); return; }

      const wasDelivered = !!existing.delivered;
      // Reverse the OLD inventory contribution (using the old product/kits/unit)
      // before applying the new one — handles product or amount or unit changes
      // while delivered=true.
      const stockTouched = [];
      if (wasDelivered) {
        const reverted = applyShipmentInventoryDelta(existing, false);
        if (reverted && !stockTouched.includes(reverted)) stockTouched.push(reverted);
      }
      Object.assign(existing, { vendor, dateOrdered, product, kits, unit, tracking, delivered });
      const saved = existing;

      const { product: ensuredProduct, created: createdNew } = ensureStockProduct(saved.product);
      if (createdNew && ensuredProduct && !stockTouched.includes(ensuredProduct)) {
        stockTouched.push(ensuredProduct);
      }
      let stockChanged = null;
      if (delivered) {
        stockChanged = applyShipmentInventoryDelta(saved, true);
        if (stockChanged && !stockTouched.includes(stockChanged)) stockTouched.push(stockChanged);
      }

      saveState();
      cloudUpsert('shipments', saved);
      if (stockTouched.length) cloudUpsertMany('stock', stockTouched);

      if (stockChanged) {
        toast(`Inventory updated: ${stockChanged.name} now ${fmtN(stockChanged.qty)}.`);
      } else if (createdNew) {
        toast(`Shipment updated. "${ensuredProduct.name}" added to inventory.`);
      } else {
        toast('Shipment updated.');
      }
      renderShipments(); renderInventory(); renderDashboard();
      closeModal();
    };

    form.querySelector('#shipDeleteBtn').addEventListener('click', () => {
      if (!confirm('Delete this shipment? This cannot be undone.')) return;
      // If the shipment was contributing to inventory, reverse it first.
      const stockTouched = [];
      if (existing.delivered) {
        const reverted = applyShipmentInventoryDelta(existing, false);
        if (reverted) stockTouched.push(reverted);
      }
      const id = existing.id;
      state.shipments = state.shipments.filter(x => x.id !== id);
      saveState();
      cloudDelete('shipments', id);
      if (stockTouched.length) cloudUpsertMany('stock', stockTouched);
      renderShipments(); renderInventory(); renderDashboard();
      toast('Shipment deleted.');
      closeModal();
    });

    showModal();
    setTimeout(() => form.querySelector('[name="vendor"]')?.focus(), 50);
    return;
  }

  // New shipment: multi-line entry. One record is created per product line,
  // all sharing the same vendor / date / tracking / delivered.
  const data = {
    vendor: '',
    dateOrdered: todayISO(),
    tracking: '',
    delivered: false,
    items: [{ product: '', kits: '', unit: 'kits' }],
  };

  $('#modalTitle').textContent = 'New Shipment';
  const form = $('#modalForm');

  // Datalist with current inventory so the user can pick an existing product
  // OR type a brand-new one (which gets auto-added to stock on save).
  const productOptions = state.stock
    .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
    .join('');

  form.innerHTML = `
    <datalist id="shipProductList">${productOptions}</datalist>
    <div class="row-2">
      <label><span class="req">Vendor</span><input type="text" name="vendor" required placeholder="e.g. Lumen Peptides" /></label>
      <label><span>Date Ordered</span><input type="date" name="dateOrdered" value="${data.dateOrdered}" /></label>
    </div>
    <div class="row-2">
      <label><span>Tracking Number</span><input type="text" name="tracking" placeholder="optional" /></label>
      <label class="toggle-row">
        <span class="toggle-row-label">Delivered</span>
        <span class="switch"><input type="checkbox" name="delivered" /><span class="slider"></span></span>
      </label>
    </div>
    <div class="items-section">
      <div class="items-head">
        <span class="label">Products</span>
        <button type="button" class="btn ghost add-item-btn" id="addItemBtn">+ Add Product</button>
      </div>
      <div class="items-col-head ship-col-head">
        <span>Product</span><span>Amount</span><span>Unit</span><span></span>
      </div>
      <div id="itemsList"></div>
    </div>
  `;

  // Per-row closures so add / remove don't have to rebuild the whole list —
  // keeps the keyboard up on mobile and avoids the brief freeze users hit when
  // tapping "+ Add Product" mid-entry.
  function refreshRemoveButtons() {
    const list = form.querySelector('#itemsList');
    const onlyOne = data.items.length === 1;
    list.querySelectorAll('[data-remove]').forEach(btn => { btn.disabled = onlyOne; });
  }
  function buildShipItemRow(it) {
    const row = document.createElement('div');
    row.className = 'item-row ship-item-row';
    const unit = it.unit === 'qty' ? 'qty' : 'kits';
    row.innerHTML = `
      <input type="text" list="shipProductList" autocomplete="off" data-field="product" value="${escapeHtml(it.product || '')}" placeholder="Search or add product…" />
      <input type="number" inputmode="numeric" min="0" step="1" data-field="kits" value="${escapeHtml(it.kits || '')}" placeholder="e.g. 5" />
      <select data-field="unit">
        <option value="kits" ${unit === 'kits' ? 'selected' : ''}>Kits</option>
        <option value="qty" ${unit === 'qty' ? 'selected' : ''}>Qty</option>
      </select>
      <button type="button" class="icon-btn danger" data-remove title="Remove">×</button>
    `;
    row.querySelectorAll('[data-field]').forEach(el => {
      const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(eventName, () => { it[el.dataset.field] = el.value; });
    });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if (data.items.length === 1) return;
      const idx = data.items.indexOf(it);
      if (idx >= 0) data.items.splice(idx, 1);
      row.remove();
      refreshRemoveButtons();
    });
    return row;
  }

  function renderItems() {
    const list = form.querySelector('#itemsList');
    list.innerHTML = '';
    data.items.forEach(it => list.appendChild(buildShipItemRow(it)));
    refreshRemoveButtons();
  }

  form.querySelector('#addItemBtn').addEventListener('click', () => {
    const it = { product: '', kits: '', unit: 'kits' };
    data.items.push(it);
    const row = buildShipItemRow(it);
    form.querySelector('#itemsList').appendChild(row);
    refreshRemoveButtons();
    // Focus stays synchronous so iOS brings the keyboard up inside the tap
    // gesture; the scroll is deferred to the next frame so it doesn't stutter
    // fighting the keyboard animation + layout reflow that focus kicks off.
    focusForKeyboard(row.querySelector('[data-field="product"]'));
    requestAnimationFrame(() => {
      try { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
    });
  });

  renderItems();

  modalOnSave = () => {
    const vendor = form.querySelector('[name="vendor"]').value.trim();
    const dateOrdered = form.querySelector('[name="dateOrdered"]').value;
    const tracking = form.querySelector('[name="tracking"]').value.trim();
    const delivered = form.querySelector('[name="delivered"]').checked;
    if (!vendor) { alert('Vendor is required.'); return; }
    if (!data.items.length) { alert('Add at least one product.'); return; }
    for (const it of data.items) {
      if (!it.product || !it.product.trim()) { alert('Each line needs a product.'); return; }
    }

    const created = data.items.map(it => ({
      id: uid('sh'),
      vendor, dateOrdered, tracking, delivered,
      product: it.product.trim(),
      kits: it.kits || '',
      unit: it.unit === 'qty' ? 'qty' : 'kits',
    }));
    state.shipments.push(...created);

    // Ensure every product on the shipment exists in inventory. Brand-new
    // names get added as a stock row (qty 0) so they're tracked from now on.
    const stockUpdated = [];
    let createdStockCount = 0;
    for (const s of created) {
      const { product, created: wasCreated } = ensureStockProduct(s.product);
      if (product && !stockUpdated.includes(product)) stockUpdated.push(product);
      if (wasCreated) createdStockCount++;
    }
    // Then, if the shipment is already delivered AND past the cutoff, add kits.
    if (delivered) {
      for (const s of created) {
        const p = applyShipmentInventoryDelta(s, true);
        if (p && !stockUpdated.includes(p)) stockUpdated.push(p);
      }
    }

    saveState();
    cloudUpsertMany('shipments', created);
    if (stockUpdated.length) cloudUpsertMany('stock', stockUpdated);

    const label = created.length === 1 ? 'Shipment added.' : `${created.length} shipments added.`;
    const newProductLabel = createdStockCount
      ? ` (${createdStockCount} new product${createdStockCount === 1 ? '' : 's'} added to inventory)`
      : '';
    if (delivered && stockUpdated.some(p => Number(p.qty) > 0)) {
      const summary = stockUpdated.map(p => `${p.name} → ${fmtN(p.qty)}`).join(', ');
      toast(`${label}${newProductLabel} Inventory: ${summary}.`);
    } else {
      toast(`${label}${newProductLabel}`);
    }

    renderShipments(); renderInventory(); renderDashboard();
    closeModal();
  };

  showModal();
  setTimeout(() => form.querySelector('[name="vendor"]')?.focus(), 50);
}

// Edit-the-whole-group modal: lets the user update shared fields (vendor,
// date, tracking, delivered) once and have them propagate to every child
// shipment, plus edit each line's product / amount / unit, plus add or
// remove lines. Existing children are matched by id; new lines get fresh ids;
// removed lines get deleted from state and Supabase.
function shipGroupModal(groupShipments) {
  if (!groupShipments || !groupShipments.length) return;
  // Pick the first record's shared fields as the starting point. Tracking
  // numbers may differ between children — show the first one and let the
  // user overwrite (which then applies to all on save).
  const first = groupShipments[0];
  const ed = {
    vendor: first.vendor || '',
    dateOrdered: first.dateOrdered || '',
    tracking: first.tracking || '',
    delivered: !!first.delivered,
    items: groupShipments.map(s => ({
      id: s.id,                    // keep existing id so we update in place
      product: s.product || '',
      kits: s.kits == null ? '' : String(s.kits),
      unit: s.unit === 'qty' ? 'qty' : 'kits',
    })),
  };
  // Mark all children as having the same delivered state by default.
  // If they differ, pick the most common.
  const allDelivered = groupShipments.every(s => s.delivered);
  const noDelivered = groupShipments.every(s => !s.delivered);
  ed.delivered = allDelivered;
  const mixedDelivery = !allDelivered && !noDelivered;

  $('#modalTitle').textContent = 'Edit Shipment Group';
  const form = $('#modalForm');

  const productOptions = state.stock
    .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
    .join('');

  form.innerHTML = `
    <datalist id="shipGroupProductList">${productOptions}</datalist>
    <div class="row-2">
      <label><span class="req">Vendor</span><input type="text" name="vendor" required value="${escapeHtml(ed.vendor)}" placeholder="e.g. Lumen Peptides" /></label>
      <label><span>Date Ordered</span><input type="date" name="dateOrdered" value="${ed.dateOrdered}" /></label>
    </div>
    <div class="row-2">
      <label><span>Tracking Number</span><input type="text" name="tracking" value="${escapeHtml(ed.tracking)}" placeholder="optional — applied to all lines" /></label>
      <label class="toggle-row">
        <span class="toggle-row-label">Delivered${mixedDelivery ? ' <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500;">(was mixed)</span>' : ''}</span>
        <span class="switch"><input type="checkbox" name="delivered" ${ed.delivered ? 'checked' : ''} /><span class="slider"></span></span>
      </label>
    </div>
    <div class="items-section">
      <div class="items-head">
        <span class="label">Products</span>
        <button type="button" class="btn ghost add-item-btn" id="addItemBtn">+ Add Product</button>
      </div>
      <div class="items-col-head ship-col-head">
        <span>Product</span><span>Amount</span><span>Unit</span><span></span>
      </div>
      <div id="itemsList"></div>
    </div>
    <button type="button" class="btn danger-outline" id="shipGroupDeleteBtn">Delete Entire Group</button>
  `;

  function refreshRemoveButtons() {
    const list = form.querySelector('#itemsList');
    const onlyOne = ed.items.length === 1;
    list.querySelectorAll('[data-remove]').forEach(btn => { btn.disabled = onlyOne; });
  }
  function buildShipGroupRow(it) {
    const row = document.createElement('div');
    row.className = 'item-row ship-item-row';
    const unit = it.unit === 'qty' ? 'qty' : 'kits';
    row.innerHTML = `
      <input type="text" list="shipGroupProductList" autocomplete="off" data-field="product" value="${escapeHtml(it.product || '')}" placeholder="Search or add product…" />
      <input type="number" inputmode="numeric" min="0" step="1" data-field="kits" value="${escapeHtml(it.kits || '')}" placeholder="e.g. 5" />
      <select data-field="unit">
        <option value="kits" ${unit === 'kits' ? 'selected' : ''}>Kits</option>
        <option value="qty" ${unit === 'qty' ? 'selected' : ''}>Qty</option>
      </select>
      <button type="button" class="icon-btn danger" data-remove title="Remove">×</button>
    `;
    row.querySelectorAll('[data-field]').forEach(el => {
      const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(eventName, () => { it[el.dataset.field] = el.value; });
    });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if (ed.items.length === 1) return;
      const idx = ed.items.indexOf(it);
      if (idx >= 0) ed.items.splice(idx, 1);
      row.remove();
      refreshRemoveButtons();
    });
    return row;
  }

  function renderItems() {
    const list = form.querySelector('#itemsList');
    list.innerHTML = '';
    ed.items.forEach(it => list.appendChild(buildShipGroupRow(it)));
    refreshRemoveButtons();
  }

  form.querySelector('#addItemBtn').addEventListener('click', () => {
    const it = { id: null, product: '', kits: '', unit: 'kits' };
    ed.items.push(it);
    const row = buildShipGroupRow(it);
    form.querySelector('#itemsList').appendChild(row);
    refreshRemoveButtons();
    // Keyboard focus synchronous (iOS gesture); scroll deferred a frame so the
    // two don't collide and stutter — keeps adding a line feeling instant.
    focusForKeyboard(row.querySelector('[data-field="product"]'));
    requestAnimationFrame(() => {
      try { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
    });
  });

  renderItems();

  form.querySelector('#shipGroupDeleteBtn').addEventListener('click', () => {
    if (!confirm(`Delete all ${groupShipments.length} shipment${groupShipments.length === 1 ? '' : 's'} in this group? This cannot be undone.`)) return;
    const stockTouched = [];
    for (const s of groupShipments) {
      if (s.delivered) {
        const reverted = applyShipmentInventoryDelta(s, false);
        if (reverted && !stockTouched.includes(reverted)) stockTouched.push(reverted);
      }
    }
    const ids = new Set(groupShipments.map(s => s.id));
    state.shipments = state.shipments.filter(s => !ids.has(s.id));
    saveState();
    for (const id of ids) cloudDelete('shipments', id);
    if (stockTouched.length) cloudUpsertMany('stock', stockTouched);
    renderShipments(); renderInventory(); renderDashboard();
    toast(`${groupShipments.length} shipment${groupShipments.length === 1 ? '' : 's'} deleted.`);
    closeModal();
  });

  modalOnSave = () => {
    const vendor = form.querySelector('[name="vendor"]').value.trim();
    const dateOrdered = form.querySelector('[name="dateOrdered"]').value;
    const tracking = form.querySelector('[name="tracking"]').value.trim();
    const delivered = form.querySelector('[name="delivered"]').checked;
    if (!vendor) { alert('Vendor is required.'); return; }
    if (!ed.items.length) { alert('Add at least one product.'); return; }
    for (const it of ed.items) {
      if (!it.product || !String(it.product).trim()) { alert('Each line needs a product.'); return; }
    }

    const stockTouched = [];
    // Step 1: reverse OLD inventory contributions for any child that was
    // previously delivered, using its old product/kits/unit.
    for (const s of groupShipments) {
      if (s.delivered) {
        const reverted = applyShipmentInventoryDelta(s, false);
        if (reverted && !stockTouched.includes(reverted)) stockTouched.push(reverted);
      }
    }

    // Step 2: figure out which existing rows survived, which got removed.
    const keptIds = new Set(ed.items.filter(it => it.id).map(it => it.id));
    const removedShipments = groupShipments.filter(s => !keptIds.has(s.id));
    state.shipments = state.shipments.filter(s => !removedShipments.some(r => r.id === s.id));

    // Step 3: update kept shipments and create new ones; collect them all.
    const updated = [];
    const created = [];
    for (const it of ed.items) {
      const product = String(it.product || '').trim();
      const kits = it.kits || '';
      const unit = it.unit === 'qty' ? 'qty' : 'kits';
      if (it.id) {
        const live = state.shipments.find(s => s.id === it.id);
        if (live) {
          Object.assign(live, { vendor, dateOrdered, tracking, delivered, product, kits, unit });
          updated.push(live);
        }
      } else {
        const fresh = {
          id: uid('sh'),
          vendor, dateOrdered, tracking, delivered,
          product, kits, unit,
        };
        state.shipments.push(fresh);
        created.push(fresh);
      }
    }

    // Step 4: ensure each (potentially new) product exists in stock.
    let createdStockCount = 0;
    for (const s of [...updated, ...created]) {
      const { product: ensured, created: wasCreated } = ensureStockProduct(s.product);
      if (ensured && !stockTouched.includes(ensured)) stockTouched.push(ensured);
      if (wasCreated) createdStockCount++;
    }

    // Step 5: re-apply inventory contributions for the new state.
    if (delivered) {
      for (const s of [...updated, ...created]) {
        const p = applyShipmentInventoryDelta(s, true);
        if (p && !stockTouched.includes(p)) stockTouched.push(p);
      }
    }

    saveState();
    if (updated.length) cloudUpsertMany('shipments', updated);
    if (created.length) cloudUpsertMany('shipments', created);
    for (const r of removedShipments) cloudDelete('shipments', r.id);
    if (stockTouched.length) cloudUpsertMany('stock', stockTouched);

    const newProductLabel = createdStockCount
      ? ` (${createdStockCount} new product${createdStockCount === 1 ? '' : 's'} added to inventory)`
      : '';
    toast(`Group updated.${newProductLabel}`);
    renderShipments(); renderInventory(); renderDashboard();
    closeModal();
  };

  showModal();
  setTimeout(() => form.querySelector('[name="vendor"]')?.focus(), 50);
}

// ---------- EXPENSES ----------
const expSearch = $('#expSearch');
const expMonth = $('#expMonth');
const expDay = $('#expDay');
const expSort = $('#expSort');
const EXP_MONTH_KEY = 'lumen.expenses.month';
const EXP_DAY_KEY = 'lumen.expenses.day';
persistFilter(expSearch, 'lumen.expenses.search');
persistFilter(expMonth, EXP_MONTH_KEY);
persistFilter(expDay, EXP_DAY_KEY);
persistFilter(expSort, 'lumen.expenses.sort');
wireSearchClear(expSearch);
[expSearch, expMonth, expDay, expSort].forEach(el => el.addEventListener('input', renderExpenses));
$('#expReset').addEventListener('click', () => resetFilters([expSearch, expMonth, expDay, expSort]));
$('#addExpBtn').addEventListener('click', () => expModal());

function expenseItems(e) { return Array.isArray(e.items) ? e.items : []; }
function expenseCost(e) {
  if (e && e.costMode === 'total') return Number(e.totalCost) || 0;
  return expenseItems(e).reduce((s, it) => s + (Number(it.cost) || 0), 0);
}
// Format an expense line item label with qty + unit info, e.g. "Retatrutide ×3 kits"
// or "Tape ×2". Skips the suffix when no qty is recorded so legacy items still
// look clean.
function expenseItemLabel(it) {
  const product = (it && it.product) || '';
  const qty = Number(it && it.qty) || 0;
  const unit = (it && it.unit === 'kits') ? 'kits' : '';
  // Pill matches the order modal / shipment row style: product on the left,
  // amount in muted color on the right, kits get pluralized.
  const amtInner = qty > 0
    ? (unit
      ? `×${fmtN(qty)} Kit${qty === 1 ? '' : 's'}`
      : `×${fmtN(qty)}`)
    : '';
  const amtSpan = amtInner ? `<span class="ip-qty">${amtInner}</span>` : '';
  return `<span class="item-pill"><span class="ip-name">${escapeHtml(product)}</span>${amtSpan}</span>`;
}

function refreshExpMonthDropdown() {
  const months = Array.from(new Set(state.expenses.map(e => monthKey(e.dateOrdered)).filter(Boolean)))
    .sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(EXP_MONTH_KEY) || ''; } catch { return ''; } })();
  const cur = expMonth.value || stored;
  expMonth.innerHTML = `<option value="all">All Months</option>` +
    months.map(m => `<option value="${m}">${monthName(m + '-01')}</option>`).join('');
  if (cur === 'all' || months.includes(cur)) expMonth.value = cur;
}

function refreshExpDayDropdown() {
  const mo = expMonth.value;
  const allDates = state.expenses.map(e => e.dateOrdered).filter(Boolean);
  const scoped = mo === 'all' ? allDates : allDates.filter(d => monthKey(d) === mo);
  const days = Array.from(new Set(scoped)).sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(EXP_DAY_KEY) || ''; } catch { return ''; } })();
  const cur = expDay.value || stored;
  expDay.innerHTML = `<option value="all">All Days</option>` +
    days.map(d => `<option value="${d}">${fmtDateShort(d)}</option>`).join('');
  if (cur === 'all' || days.includes(cur)) expDay.value = cur;
  else expDay.value = 'all';
}

function renderExpenses() {
  refreshExpMonthDropdown();
  refreshExpDayDropdown();
  const q = expSearch.value.toLowerCase().trim();
  const mo = expMonth.value;
  const dy = expDay.value;
  const expDir = expSort.value === 'asc' ? 1 : -1;
  let rows = [...state.expenses].sort((a, b) =>
    expDir * ((a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
  );
  if (mo !== 'all') rows = rows.filter(e => monthKey(e.dateOrdered) === mo);
  if (dy !== 'all') rows = rows.filter(e => e.dateOrdered === dy);
  if (q) rows = rows.filter(e =>
    (e.vendor || '').toLowerCase().includes(q) ||
    expenseItems(e).some(it => (it.product || '').toLowerCase().includes(q))
  );

  // consolidateExpenses sorts internally desc — re-sort here so the user's
  // chosen direction wins.
  const groups = consolidateExpenses(rows).sort((a, b) =>
    expDir * ((a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
  );

  const body = $('#expBody');
  const expandedBefore = getExpandedGroupIds(body);
  body.innerHTML = groups.map(g => renderExpenseGroup(g)).join('') ||
    `<tr><td colspan="5" class="muted" style="padding:24px;text-align:center;">No expenses match.</td></tr>`;
  restoreGroupExpansion(body, expandedBefore);

  const expCount = rows.length;
  const itemCount = rows.reduce((s, e) => s + expenseItems(e).length, 0);
  $('#expCount').textContent = itemCount === expCount
    ? `${expCount} expense${expCount === 1 ? '' : 's'}`
    : `${expCount} expense${expCount === 1 ? '' : 's'} · ${itemCount} item${itemCount === 1 ? '' : 's'}`;
  $('#expSum').textContent = fmt$(rows.reduce((s, e) => s + expenseCost(e), 0));

  body.querySelectorAll('[data-edit-exp]').forEach(el => el.addEventListener('click', () => {
    const e = state.expenses.find(x => x.id === el.dataset.editExp);
    if (e) expModal(e);
  }));
  body.querySelectorAll('[data-del-exp]').forEach(el => el.addEventListener('click', () => {
    if (!confirm('Delete this expense?')) return;
    const id = el.dataset.delExp;
    state.expenses = state.expenses.filter(x => x.id !== id);
    saveState(); cloudDelete('expenses', id); renderExpenses(); toast('Expense deleted.');
  }));
  wireGroupExpand(body);
}

// Consolidate expenses by shared vendor + date — multiple receipts on the same
// day from the same vendor collapse into one drop-down row.
function consolidateExpenses(expenses) {
  const groups = [];
  const byKey = new Map();
  for (const e of expenses) {
    const key = (e.vendor || '').toLowerCase().trim() + '|' + (e.dateOrdered || '');
    let g = byKey.get(key);
    if (!g) {
      g = { vendor: e.vendor, dateOrdered: e.dateOrdered, expenses: [] };
      groups.push(g);
      byKey.set(key, g);
    }
    g.expenses.push(e);
  }
  return groups.sort((a, b) => (b.dateOrdered || '').localeCompare(a.dateOrdered || ''));
}

function renderExpenseGroup(g) {
  if (g.expenses.length === 1) return renderExpenseRow(g.expenses[0]);

  const groupId = 'xg_' + (g.vendor || '').replace(/\W+/g, '_') + '_' + (g.dateOrdered || '').replace(/\W+/g, '');
  const totalCost = g.expenses.reduce((s, e) => s + expenseCost(e), 0);
  const totalItems = g.expenses.reduce((s, e) => s + expenseItems(e).length, 0);

  let html = `
    <tr class="group-row">
      <td><b>${escapeHtml(g.vendor || '')}</b><span class="grp-badge">${g.expenses.length} expense${g.expenses.length === 1 ? '' : 's'}</span></td>
      <td>${g.dateOrdered ? fmtDateShort(g.dateOrdered) : '<span class="muted">—</span>'}</td>
      <td class="items-cell"><span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${totalItems} item${totalItems === 1 ? '' : 's'}</span></td>
      <td class="num"><b>${fmt$(totalCost)}</b></td>
      <td></td>
    </tr>`;
  html += g.expenses.map(e => {
    const items = expenseItems(e);
    const productsCell = items.length === 1
      ? expenseItemLabel(items[0])
      : `<span class="grp-badge">${items.length} items</span>`;
    return `
      <tr class="child-row" data-parent="${groupId}" hidden>
        <td colspan="5" class="child-cell">
          <div class="child-strip">
            <span class="cs-label">↳</span>
            <span class="cs-items">${productsCell}</span>
            <span class="cs-total">${fmt$(expenseCost(e))}</span>
            <span class="cs-actions">
              <button class="icon-btn" data-edit-exp="${e.id}" title="Edit">✎</button>
              <button class="icon-btn danger" data-del-exp="${e.id}" title="Delete">🗑</button>
            </span>
          </div>
        </td>
      </tr>`;
  }).join('');
  return html;
}

function renderExpenseRow(e) {
  const items = expenseItems(e);
  if (items.length <= 1) return renderSingleExpenseRow(e);

  const groupId = 'eg_' + String(e.id || '').replace(/\W+/g, '_');
  const totalCost = expenseCost(e);

  let html = `
    <tr class="group-row">
      <td><b>${escapeHtml(e.vendor || '')}</b></td>
      <td>${e.dateOrdered ? fmtDateShort(e.dateOrdered) : '<span class="muted">—</span>'}</td>
      <td class="items-cell">
        <span class="chevron" data-toggle-group="${groupId}">▶</span><span class="grp-badge">${items.length} items</span>
      </td>
      <td class="num"><b>${fmt$(totalCost)}</b></td>
      <td style="white-space:nowrap;">
        <button class="icon-btn" data-edit-exp="${e.id}" title="Edit">✎</button>
        <button class="icon-btn danger" data-del-exp="${e.id}" title="Delete">🗑</button>
      </td>
    </tr>`;
  // Show per-item cost only when the expense is tracked per-item — in total
  // mode every line's cost is 0, so showing it just clutters the dropdown.
  const showPerItemCost = e.costMode === 'perItem';
  html += items.map(it => `
    <tr class="child-row" data-parent="${groupId}" hidden>
      <td colspan="5" class="child-cell">
        <div class="child-strip">
          <span class="cs-label">↳</span>
          <span class="cs-items">${expenseItemLabel(it)}</span>
          ${showPerItemCost ? `<span class="cs-total">${fmt$(it.cost)}</span>` : ''}
        </div>
      </td>
    </tr>`).join('');
  return html;
}

function renderSingleExpenseRow(e) {
  const items = expenseItems(e);
  const it = items[0] || { product: e.product || '', cost: e.cost || 0 };
  // Use expenseCost(e) instead of it.cost so total-cost-mode expenses (where
  // each line item's cost is 0 and the real amount lives on e.totalCost)
  // display correctly. Also covers per-item-mode multi-item rows.
  return `<tr>
    <td>${escapeHtml(e.vendor || '')}</td>
    <td>${e.dateOrdered ? fmtDateShort(e.dateOrdered) : '<span class="muted">—</span>'}</td>
    <td>${expenseItemLabel(it)}</td>
    <td class="num">${fmt$(expenseCost(e))}</td>
    <td style="white-space:nowrap;">
      <button class="icon-btn" data-edit-exp="${e.id}" title="Edit">✎</button>
      <button class="icon-btn danger" data-del-exp="${e.id}" title="Delete">🗑</button>
    </td>
  </tr>`;
}

function expModal(existing) {
  const data = existing
    ? JSON.parse(JSON.stringify(existing))
    : { vendor: '', dateOrdered: todayISO(), dateReceived: '', costMode: 'total', totalCost: 0, items: [{ product: '', qty: 1, unit: 'qty', cost: 0 }] };
  if (!Array.isArray(data.items)) data.items = [];
  if (data.items.length === 0) data.items.push({ product: '', qty: 1, unit: 'qty', cost: 0 });
  // Backfill new fields on legacy items so the form renders cleanly.
  data.items = data.items.map(it => ({
    product: it.product || '',
    qty: it.qty != null ? it.qty : 1,
    unit: (it.unit === 'kits' || it.unit === 'qty') ? it.unit : 'qty',
    cost: it.cost != null ? it.cost : 0,
  }));
  if (typeof data.vendor !== 'string') data.vendor = '';
  if (data.costMode !== 'total' && data.costMode !== 'perItem') data.costMode = 'total';
  if (typeof data.totalCost !== 'number') data.totalCost = 0;

  $('#modalTitle').textContent = existing ? 'Edit Expense' : 'New Expense';
  const form = $('#modalForm');

  // Datalist with current inventory so item descriptions can autocomplete.
  const productOptions = state.stock
    .map(s => `<option value="${escapeHtml(s.name)}"></option>`)
    .join('');

  form.innerHTML = `
    <datalist id="expProductList">${productOptions}</datalist>
    <div class="row-2">
      <label><span class="req">Vendor / Site</span><input type="text" name="vendor" required value="${escapeHtml(data.vendor || '')}" placeholder="e.g. Amazon, Lumen Peptides" /></label>
      <label><span>Date Ordered</span><input type="date" name="dateOrdered" value="${data.dateOrdered || ''}" /></label>
    </div>
    <label><span>Date Received</span><input type="date" name="dateReceived" value="${data.dateReceived || ''}" /></label>
    <label class="toggle-row">
      <span class="toggle-row-label">
        Track cost per item
        <span class="toggle-row-hint">On = enter a cost on each line · Off = enter a single total</span>
      </span>
      <span class="switch"><input type="checkbox" id="expCostPerItem" ${data.costMode === 'perItem' ? 'checked' : ''} /><span class="slider"></span></span>
    </label>
    <label id="expTotalCostWrap"><span class="req">Total Cost</span><input type="number" min="0" step="any" name="totalCost" value="${data.totalCost || ''}" placeholder="0.00" /></label>
    <div class="items-section">
      <div class="items-head">
        <span class="label">Products</span>
        <button type="button" class="btn ghost add-item-btn" id="addItemBtn">+ Add Item</button>
      </div>
      <div class="items-col-head exp-col-head" id="expColHead"></div>
      <div id="itemsList"></div>
      <div class="items-summary">
        <span><span class="muted">Items</span> <b id="sumCount">0</b></span>
        <span><span class="muted">Vials</span> <b id="sumVials">0</b></span>
        <span><span class="muted">Total</span> <b id="sumTotal">$0</b></span>
      </div>
    </div>
  `;

  const totalCostInput = form.querySelector('[name="totalCost"]');

  function applyMode() {
    const perItem = data.costMode === 'perItem';
    form.querySelector('#expTotalCostWrap').hidden = perItem;
    totalCostInput.required = !perItem;
    const head = form.querySelector('#expColHead');
    head.innerHTML = perItem
      ? '<span>Description</span><span>Qty</span><span>Unit</span><span>Cost</span><span></span>'
      : '<span>Description</span><span>Qty</span><span>Unit</span><span></span>';
    head.classList.toggle('exp-col-head-no-cost', !perItem);
    renderItems();
  }

  function refreshRemoveButtons() {
    const list = form.querySelector('#itemsList');
    const onlyOne = data.items.length === 1;
    list.querySelectorAll('[data-remove]').forEach(btn => { btn.disabled = onlyOne; });
  }
  // Per-row closures — adding/removing a line stays surgical, the keyboard
  // never closes and the user can keep typing. Full rebuild only when the
  // user toggles per-item ↔ total-cost mode (the row layout actually changes).
  function buildExpenseRow(it) {
    const perItem = data.costMode === 'perItem';
    const row = document.createElement('div');
    row.className = perItem ? 'item-row exp-item-row' : 'item-row exp-item-row no-cost';
    const unit = it.unit === 'kits' ? 'kits' : 'qty';
    const baseFields = `
      <input type="text" list="expProductList" autocomplete="off" data-field="product" value="${escapeHtml(it.product || '')}" placeholder="Search or add product…" />
      <input type="number" inputmode="numeric" min="0" step="1" data-field="qty" value="${it.qty ?? ''}" placeholder="Qty" />
      <select data-field="unit">
        <option value="qty" ${unit === 'qty' ? 'selected' : ''}>Qty</option>
        <option value="kits" ${unit === 'kits' ? 'selected' : ''}>Kits</option>
      </select>
    `;
    row.innerHTML = perItem
      ? baseFields + `
        <input type="number" inputmode="decimal" min="0" step="any" data-field="cost" value="${it.cost ?? ''}" placeholder="0.00" />
        <button type="button" class="icon-btn danger" data-remove title="Remove">×</button>
      `
      : baseFields + `
        <button type="button" class="icon-btn danger" data-remove title="Remove">×</button>
      `;
    row.querySelectorAll('[data-field]').forEach(el => {
      const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(eventName, () => {
        const field = el.dataset.field;
        let val = el.value;
        if (field === 'cost' || field === 'qty') val = val === '' ? null : Number(val);
        it[field] = val;
        updateSummary();
      });
    });
    row.querySelector('[data-remove]').addEventListener('click', () => {
      if (data.items.length === 1) return;
      const idx = data.items.indexOf(it);
      if (idx >= 0) data.items.splice(idx, 1);
      row.remove();
      refreshRemoveButtons();
      updateSummary();
    });
    return row;
  }

  function renderItems() {
    const list = form.querySelector('#itemsList');
    list.innerHTML = '';
    data.items.forEach(it => list.appendChild(buildExpenseRow(it)));
    refreshRemoveButtons();
    updateSummary();
  }

  function updateSummary() {
    form.querySelector('#sumCount').textContent = data.items.length;
    // Vial total — kits multiply ×10, qty stays 1:1. Mirrors the shipments rule.
    const vials = data.items.reduce((s, it) => {
      const q = Number(it.qty) || 0;
      const mult = it.unit === 'kits' ? KIT_TO_VIAL_MULTIPLIER : 1;
      return s + q * mult;
    }, 0);
    form.querySelector('#sumVials').textContent = fmtN(vials);
    const total = data.costMode === 'perItem'
      ? data.items.reduce((s, it) => s + (Number(it.cost) || 0), 0)
      // Read from the in-memory value (kept in sync by the input listener)
      // rather than the DOM, so the summary is correct even if the input
      // element was just (re-)rendered.
      : Number(data.totalCost) || 0;
    form.querySelector('#sumTotal').textContent = fmt$(total);
  }

  form.querySelector('#expCostPerItem').addEventListener('change', (e) => {
    if (e.target.checked) {
      data.costMode = 'perItem';
    } else {
      data.costMode = 'total';
      // Pre-fill the total with the current sum so the user doesn't lose it.
      const sum = data.items.reduce((s, it) => s + (Number(it.cost) || 0), 0);
      if (sum > 0) {
        data.totalCost = sum;
        totalCostInput.value = sum;
      }
    }
    applyMode();
  });
  totalCostInput.addEventListener('input', () => {
    data.totalCost = Number(totalCostInput.value) || 0;
    updateSummary();
  });

  form.querySelector('#addItemBtn').addEventListener('click', () => {
    const it = { product: '', qty: 1, unit: 'qty', cost: 0 };
    data.items.push(it);
    const row = buildExpenseRow(it);
    form.querySelector('#itemsList').appendChild(row);
    refreshRemoveButtons();
    updateSummary();
    focusForKeyboard(row.querySelector('[data-field="product"]'));
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  applyMode();

  modalOnSave = async () => {
    const vendorInput = form.querySelector('[name="vendor"]');
    const dateOrderedInput = form.querySelector('[name="dateOrdered"]');
    const dateReceivedInput = form.querySelector('[name="dateReceived"]');
    if (!vendorInput || !dateOrderedInput) {
      alert('Form fields missing — please close and re-open the modal.');
      return;
    }
    const vendor = vendorInput.value.trim();
    const dateOrdered = dateOrderedInput.value || '';
    const dateReceived = (dateReceivedInput && dateReceivedInput.value) || '';
    const costMode = data.costMode;
    // Read from the in-memory value (kept in sync by the input listener) so we
    // don't depend on a possibly-hidden DOM input being readable. This was the
    // root cause of "$100 entered, total saved as $0" reports.
    const totalCost = costMode === 'total' ? (Number(data.totalCost) || 0) : 0;

    if (!vendor) { alert('Vendor is required.'); return; }
    if (!data.items.length) { alert('Add at least one product.'); return; }
    for (const it of data.items) {
      if (!it.product || !String(it.product).trim()) { alert('Each product needs a description.'); return; }
    }
    if (costMode === 'total' && totalCost <= 0) { alert('Enter a total cost greater than 0.'); return; }

    const items = data.items.map(it => ({
      product: String(it.product || '').trim(),
      qty: Number(it.qty) || 0,
      unit: it.unit === 'kits' ? 'kits' : 'qty',
      cost: costMode === 'perItem' ? (Number(it.cost) || 0) : 0,
    }));
    const payload = { vendor, dateOrdered, dateReceived, costMode, totalCost, items };

    let saved;
    if (existing && existing.id) {
      // Look up by id rather than mutating the captured reference, so we
      // always update the live record even if the array got replaced (e.g.
      // by a cloud sync) between opening the modal and saving.
      const live = state.expenses.find(x => x.id === existing.id);
      if (live) {
        Object.assign(live, payload);
        saved = live;
      } else {
        // Record was removed remotely — re-insert with the same id.
        saved = { id: existing.id, ...payload };
        state.expenses.push(saved);
      }
    } else {
      saved = { id: uid('e'), ...payload };
      state.expenses.push(saved);
    }
    saveState();
    renderExpenses();
    renderDashboard();
    closeModal();

    // Cloud sync: await so failures surface to the user immediately rather
    // than silently leaving local + cloud out of sync.
    if (sb) {
      try {
        const row = Adapters.expenses.toRow(saved);
        const { error } = await sb.from('expenses').upsert(row);
        if (error) {
          console.error('expense upsert failed', { row, error });
          alert(`Saved locally, but cloud sync failed: ${error.message}\n\nReload may revert this edit. Check your Supabase schema (vendor / cost_mode / items columns).`);
          setCloudStatus('offline', 'Sync error');
          return;
        }
        setCloudStatus('online', 'Synced');
        toast(existing ? 'Expense updated.' : 'Expense added.');
      } catch (err) {
        console.error('expense upsert threw', err);
        alert(`Saved locally, but cloud sync failed: ${err.message || err}`);
      }
    } else {
      toast(existing ? 'Expense updated.' : 'Expense added.');
    }
  };

  showModal();
  setTimeout(() => form.querySelector('input[type="text"]')?.focus(), 50);
}

// ---------- INCOME STATEMENT ----------
const isFrom = $('#isFrom');
const isTo = $('#isTo');
[isFrom, isTo].forEach(el => el.addEventListener('change', renderIncome));
$('#isReset').addEventListener('click', () => { isFrom.value = ''; isTo.value = ''; renderIncome(); });

function renderIncome() {
  const from = isFrom.value || '';
  const to = isTo.value || '';
  const inRange = (d) => {
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };
  const orders = state.orders.filter(o => o.date && (!from && !to ? true : inRange(o.date)));
  const expenses = state.expenses.filter(e => {
    const d = e.dateOrdered || e.dateReceived;
    return !from && !to ? true : inRange(d);
  });

  // Cash basis — paid portion of each order (including partials) flows into
  // revenue / gross. The unpaid balance lands in the Pending block. round2()
  // strips floating-point drift that compounds when summing across many orders.
  const rev = round2(orders.reduce((s, o) => s + orderPaidRevenue(o), 0));
  const gross = round2(orders.reduce((s, o) => s + orderPaidProfit(o), 0));
  const cogs = round2(rev - gross);
  const opex = round2(expenses.reduce((s, e) => s + expenseCost(e), 0));
  const net = round2(gross - opex);
  const margin = rev > 0 ? (net / rev * 100) : 0;
  const pendG = round2(orders.reduce((s, o) => s + orderBalance(o), 0));
  const pendN = round2(orders.reduce((s, o) => s + orderUnpaidProfit(o), 0));

  $('#isRev').textContent = fmt$(rev);
  $('#isCogs').textContent = fmt$(cogs);
  $('#isGross').textContent = fmt$(gross);
  $('#isOpex').textContent = fmt$(opex);
  $('#isNet').textContent = fmt$(net);
  $('#isMargin').textContent = margin.toFixed(1) + '%';
  $('#isPendGross').textContent = fmt$(pendG);
  $('#isPendNet').textContent = fmt$(pendN);
}

// ---------- MONTHLY (calendar view) ----------
const monthlySearch = $('#monthlySearch');
persistFilter($('#monthlyFilter'), 'lumen.monthly.filter');
persistFilter(monthlySearch, 'lumen.monthly.search');
wireSearchClear(monthlySearch);
[$('#monthlyFilter'), monthlySearch].forEach(el =>
  el.addEventListener('input', renderMonthly)
);
$('#monthlyReset').addEventListener('click', () => {
  // Reset returns the calendar to the year overview and forgets the saved spot.
  monthlyView = 'year';
  calYear = null;
  calMonth = null;
  try { localStorage.removeItem(CAL_STATE_KEY); } catch {}
  resetFilters([monthlySearch, $('#monthlyFilter')]);
  renderMonthly();
});

// The Monthly tab drills down: year overview → month calendar → day detail.
//   monthlyView: 'year' | 'month'
//   calYear:  number, the year shown in the year overview
//   calMonth: 'YYYY-MM', the month shown in the calendar
let monthlyView = 'year';
let calYear = null;
let calMonth = null;
// Buckets from the most recent renderMonthly run so the drill-down views and
// the day-detail modal can look up totals without recomputing.
let __monthlyDayBuckets = {};
let __monthlyMonthBuckets = {};

// Persist the drill-down state so closing/reopening the app lands you back on
// the exact view you left (e.g. May's calendar), not the year overview. Reset
// clears it.
const CAL_STATE_KEY = 'lumen.monthly.calState';
function saveCalState() {
  try {
    localStorage.setItem(CAL_STATE_KEY, JSON.stringify({ view: monthlyView, year: calYear, month: calMonth }));
  } catch {}
}
(function loadCalState() {
  try {
    const s = JSON.parse(localStorage.getItem(CAL_STATE_KEY) || 'null');
    if (!s) return;
    if (s.view === 'year' || s.view === 'month') monthlyView = s.view;
    if (typeof s.year === 'number') calYear = s.year;
    if (typeof s.month === 'string' && /^\d{4}-\d{2}$/.test(s.month)) calMonth = s.month;
  } catch {}
})();

function addMonthsToKey(mk, delta) {
  const [y, m] = (mk || monthKey(todayISO())).split('-').map(Number);
  const d = new Date(y, (m - 1) + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// One delegated listener for the whole calendar card. Head / summary / content
// are re-rendered on each navigation, so delegating off the stable card avoids
// re-binding buttons every render.
$('#calCard').addEventListener('click', (e) => {
  if (e.target.closest('[data-cal-back]')) {
    calYear = Number((calMonth || '').slice(0, 4)) || calYear;
    monthlyView = 'year';
    renderMonthly();
    return;
  }
  if (e.target.closest('[data-cal-prev]')) {
    if (monthlyView === 'year') calYear -= 1;
    else calMonth = addMonthsToKey(calMonth, -1);
    renderMonthly();
    return;
  }
  if (e.target.closest('[data-cal-next]')) {
    if (monthlyView === 'year') calYear += 1;
    else calMonth = addMonthsToKey(calMonth, 1);
    renderMonthly();
    return;
  }
  const monthCell = e.target.closest('[data-cal-month]');
  if (monthCell) {
    calMonth = monthCell.dataset.calMonth;
    calYear = Number(calMonth.slice(0, 4));
    monthlyView = 'month';
    renderMonthly();
    return;
  }
  const dayCell = e.target.closest('[data-cal-day]');
  if (dayCell) openDayDetail(dayCell.dataset.calDay);
});

// Top Products card has its OWN filters — it shouldn't be tied to the months
// table's filter state. Independent month/day/status/sort/limit + collapse toggle.
const tpMonth = $('#tpMonth');
const tpDay = $('#tpDay');
const TP_MONTH_KEY = 'lumen.topProducts.month';
const TP_DAY_KEY = 'lumen.topProducts.day';
const TP_OPEN_KEY = 'lumen.topProducts.open';
persistFilter($('#tpStatus'), 'lumen.topProducts.status');
persistFilter(tpMonth, TP_MONTH_KEY);
persistFilter(tpDay, TP_DAY_KEY);
persistFilter($('#tpSort'), 'lumen.topProducts.sort');
persistFilter($('#tpLimit'), 'lumen.topProducts.limit');
[$('#tpStatus'), tpMonth, tpDay, $('#tpSort'), $('#tpLimit')].forEach(el =>
  el.addEventListener('input', renderTopProducts)
);
$('#tpReset').addEventListener('click', () => resetFilters(
  [$('#tpStatus'), tpMonth, tpDay, $('#tpSort'), $('#tpLimit')]
));
const tpToggleBtn = $('#topProductsToggle');
const tpBody = $('#topProductsBody');
function setTopProductsOpen(open) {
  tpBody.hidden = !open;
  tpToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  tpToggleBtn.textContent = open ? 'Hide Top Products ▴' : 'View Top Products ▾';
  try { localStorage.setItem(TP_OPEN_KEY, open ? '1' : '0'); } catch {}
}
tpToggleBtn.addEventListener('click', () => {
  setTopProductsOpen(tpBody.hidden);
});
// Restore prior open/closed state — collapsed by default for first-time visits.
try { setTopProductsOpen(localStorage.getItem(TP_OPEN_KEY) === '1'); } catch { setTopProductsOpen(false); }

function refreshTopProductsMonthDropdown() {
  const months = Array.from(new Set(state.orders.map(o => monthKey(o.date)).filter(Boolean)))
    .sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(TP_MONTH_KEY) || ''; } catch { return ''; } })();
  const cur = tpMonth.value || stored;
  tpMonth.innerHTML = `<option value="all">All Months</option>` +
    months.map(m => `<option value="${m}">${monthName(m + '-01')}</option>`).join('');
  if (cur === 'all' || months.includes(cur)) tpMonth.value = cur;
}

function refreshTopProductsDayDropdown() {
  const mo = tpMonth.value;
  const allDates = state.orders.map(o => o.date).filter(Boolean);
  const scoped = mo === 'all' ? allDates : allDates.filter(d => monthKey(d) === mo);
  const days = Array.from(new Set(scoped)).sort((a, b) => b.localeCompare(a));
  const stored = (() => { try { return localStorage.getItem(TP_DAY_KEY) || ''; } catch { return ''; } })();
  const cur = tpDay.value || stored;
  tpDay.innerHTML = `<option value="all">All Days</option>` +
    days.map(d => `<option value="${d}">${fmtDateShort(d)}</option>`).join('');
  if (cur === 'all' || days.includes(cur)) tpDay.value = cur;
  else tpDay.value = 'all';
}

function renderTopProducts() {
  refreshTopProductsMonthDropdown();
  refreshTopProductsDayDropdown();
  const status = $('#tpStatus').value;
  const mo = tpMonth.value;
  const dy = tpDay.value;
  const sort = $('#tpSort').value;
  const limit = $('#tpLimit').value;

  let orders = state.orders;
  if (status === 'paid') orders = orders.filter(o => o.paid);
  if (status === 'unpaid') orders = orders.filter(o => !o.paid);
  if (mo !== 'all') orders = orders.filter(o => monthKey(o.date) === mo);
  if (dy !== 'all') orders = orders.filter(o => o.date === dy);

  // Aggregate gross / net / qty per product across the filtered orders.
  const byProduct = {};
  orders.forEach(o => {
    orderItems(o).forEach(it => {
      const name = it.product;
      if (!name) return;
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      const cogs = Number(it.cogs) || 0;
      if (!byProduct[name]) byProduct[name] = { gross: 0, net: 0, qty: 0 };
      byProduct[name].gross += qty * price;
      byProduct[name].net += qty * (price - cogs);
      byProduct[name].qty += qty;
    });
  });
  let rows = Object.entries(byProduct).map(([name, v]) => ({ name, ...v }));
  rows.sort((a, b) => b[sort] - a[sort]);
  if (limit !== 'all') rows = rows.slice(0, Number(limit) || rows.length);

  const body = $('#monthlyTopProducts');
  body.innerHTML = rows.length
    ? rows.map(r => `<tr>
        <td><b>${escapeHtml(r.name)}</b></td>
        <td class="num">${fmt$(r.gross)}</td>
        <td class="num">${fmt$(r.net)}</td>
        <td class="num">${fmtN(r.qty)}</td>
      </tr>`).join('')
    : `<tr><td colspan="4" class="muted" style="padding:18px;text-align:center;">No data.</td></tr>`;

  // Footer = totals across the rows actually displayed (after the limit slice),
  // so "Top 5" totals match what the user sees.
  const totals = rows.reduce(
    (acc, v) => { acc.gross += v.gross; acc.net += v.net; acc.qty += v.qty; return acc; },
    { gross: 0, net: 0, qty: 0 }
  );
  $('#tpGross').textContent = fmt$(totals.gross);
  $('#tpNet').textContent = fmt$(totals.net);
  $('#tpQty').textContent = fmtN(totals.qty);
}

function renderMonthly() {
  const filter = $('#monthlyFilter').value;
  const q = monthlySearch.value.toLowerCase().trim();
  let orders = state.orders;
  if (filter === 'paid') orders = orders.filter(o => o.paid);
  if (filter === 'unpaid') orders = orders.filter(o => !o.paid);
  if (q) orders = orders.filter(o => {
    if ((o.customer || '').toLowerCase().includes(q)) return true;
    return orderItems(o).some(it => (it.product || '').toLowerCase().includes(q));
  });

  // Per-day (YYYY-MM-DD) and per-month (YYYY-MM) buckets across filtered orders.
  const dayBuckets = {};
  const monthBuckets = {};
  orders.forEach(o => {
    const dk = o.date;
    if (!dk) return;
    const mk = monthKey(dk);
    if (!dayBuckets[dk]) dayBuckets[dk] = { gross: 0, net: 0, qty: 0, orders: [] };
    if (!monthBuckets[mk]) monthBuckets[mk] = { gross: 0, net: 0, qty: 0 };
    const g = orderTotal(o), n = orderProfit(o), qd = orderQty(o);
    dayBuckets[dk].gross += g; dayBuckets[dk].net += n; dayBuckets[dk].qty += qd; dayBuckets[dk].orders.push(o);
    monthBuckets[mk].gross += g; monthBuckets[mk].net += n; monthBuckets[mk].qty += qd;
  });
  __monthlyDayBuckets = dayBuckets;
  __monthlyMonthBuckets = monthBuckets;

  // Defaults: land on the most recent year / month that has data.
  if (calYear == null) {
    const years = Array.from(new Set(orders.map(o => (o.date || '').slice(0, 4)).filter(Boolean))).map(Number).sort((a, b) => a - b);
    calYear = years[years.length - 1] || new Date().getFullYear();
  }
  if (!calMonth) {
    const months = Array.from(new Set(orders.map(o => monthKey(o.date)).filter(Boolean))).sort();
    calMonth = months[months.length - 1] || monthKey(todayISO());
  }

  if (monthlyView === 'month') renderCalendar(calMonth, dayBuckets);
  else renderYearView(calYear, monthBuckets);

  saveCalState();
  renderTopProducts();
}

// Reusable 3-stat summary strip (Total Gross / Net Profit / Total Items).
function calSummaryHtml(gross, net, qty) {
  return `
    <div class="cal-sum-stat cal-sum-gross"><span class="cal-sum-label">Total Gross</span><b>${fmt$(round2(gross))}</b></div>
    <div class="cal-sum-stat cal-sum-net"><span class="cal-sum-label">Net Profit</span><b>${fmt$(round2(net))}</b></div>
    <div class="cal-sum-stat cal-sum-qty"><span class="cal-sum-label">Total Items</span><b>${fmtN(qty)}</b></div>
  `;
}

// Average of the most recent months that actually had sales — used to paint a
// faint "projected" figure on upcoming, still-empty months in the year view.
// Weighted toward the last few months so the estimate tracks recent performance.
function computeMonthlyProjection(monthBuckets) {
  const keys = Object.keys(monthBuckets)
    .filter(mk => { const b = monthBuckets[mk]; return b && (b.gross || b.net || b.qty); })
    .sort();
  if (!keys.length) return null;
  const recent = keys.slice(-3);   // last up-to-3 months with data
  let g = 0, n = 0, q = 0;
  recent.forEach(mk => { g += monthBuckets[mk].gross; n += monthBuckets[mk].net; q += monthBuckets[mk].qty; });
  const c = recent.length;
  return { gross: g / c, net: n / c, qty: q / c, basis: c };
}

// YEAR overview — 12 month tiles, each showing that month's totals. Tapping a
// month drills into its calendar. Prev/next nav moves between years. Upcoming
// months with no orders yet show a faint projection based on recent months.
function renderYearView(year, monthBuckets) {
  const head = $('#calHead'), summary = $('#calSummary'), content = $('#calContent');
  if (!content) return;

  head.innerHTML = `
    <button type="button" class="cal-nav" data-cal-prev aria-label="Previous year">‹</button>
    <div class="cal-title">${year}</div>
    <button type="button" class="cal-nav" data-cal-next aria-label="Next year">›</button>
  `;

  let yg = 0, yn = 0, yq = 0;
  for (const mk of Object.keys(monthBuckets)) {
    if (mk.slice(0, 4) === String(year)) {
      yg += monthBuckets[mk].gross; yn += monthBuckets[mk].net; yq += monthBuckets[mk].qty;
    }
  }
  summary.innerHTML = calSummaryHtml(yg, yn, yq);

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const proj = computeMonthlyProjection(monthBuckets);
  const nextMonthKey = addMonthsToKey(monthKey(todayISO()), 1);
  let cells = '';
  for (let m = 1; m <= 12; m++) {
    const mk = `${year}-${String(m).padStart(2, '0')}`;
    const b = monthBuckets[mk];
    const has = b && (b.gross || b.net || b.qty);
    // Only the single upcoming month gets a faint projection from recent months.
    // The moment a real order lands there, `has` flips true and the actual
    // numbers replace it. Every other empty month reads "No sales".
    const projectable = !has && proj && mk === nextMonthKey;
    const cls = ['cal-month-cell'];
    if (has) cls.push('cal-month-active');
    else if (projectable) cls.push('cal-month-projected');

    let inner;
    if (has) {
      inner = `
        <span class="cal-month-gross">${fmt$(round2(b.gross))}</span>
        <span class="cal-month-net">${fmt$(round2(b.net))}</span>
        <span class="cal-month-qty">${fmtN(b.qty)} item${b.qty === 1 ? '' : 's'}</span>`;
    } else if (projectable) {
      const pq = Math.round(proj.qty);
      inner = `
        <span class="cal-month-proj-tag">Projected</span>
        <span class="cal-month-gross">~${fmt$(Math.round(proj.gross))}</span>
        <span class="cal-month-net">~${fmt$(Math.round(proj.net))}</span>
        <span class="cal-month-qty">~${fmtN(pq)} item${pq === 1 ? '' : 's'}</span>`;
    } else {
      inner = `<span class="cal-month-empty">No sales</span>`;
    }

    cells += `
      <button type="button" class="${cls.join(' ')}" data-cal-month="${mk}">
        <span class="cal-month-name">${MONTHS[m - 1]}</span>
        ${inner}
      </button>`;
  }
  content.innerHTML = `<div class="cal-months-grid">${cells}</div>`;
}

// MONTH calendar — the day grid. A back button returns to the year overview;
// prev/next nav moves between months. Each day with orders is tappable.
function renderCalendar(mk, dayBuckets) {
  const head = $('#calHead'), summary = $('#calSummary'), content = $('#calContent');
  if (!content) return;
  const [yr, mo] = mk.split('-').map(Number);

  head.innerHTML = `
    <button type="button" class="cal-back" data-cal-back>‹ ${yr}</button>
    <div class="cal-nav-group">
      <button type="button" class="cal-nav" data-cal-prev aria-label="Previous month">‹</button>
      <div class="cal-title">${monthName(mk + '-01')}</div>
      <button type="button" class="cal-nav" data-cal-next aria-label="Next month">›</button>
    </div>
  `;

  let mg = 0, mn = 0, mq = 0;
  for (const dk of Object.keys(dayBuckets)) {
    if (monthKey(dk) === mk) { mg += dayBuckets[dk].gross; mn += dayBuckets[dk].net; mq += dayBuckets[dk].qty; }
  }
  summary.innerHTML = calSummaryHtml(mg, mn, mq);

  const firstDow = new Date(yr, mo - 1, 1).getDay();   // 0=Sun … 6=Sat
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const todayKey = todayISO();

  let grid = '';
  for (let i = 0; i < firstDow; i++) grid += `<div class="cal-cell cal-cell-empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dk = `${mk}-${String(d).padStart(2, '0')}`;
    const b = dayBuckets[dk];
    const has = b && b.orders.length;
    const cls = ['cal-cell'];
    if (has) cls.push('cal-cell-active');
    if (dk === todayKey) cls.push('cal-cell-today');
    if (has) {
      grid += `
        <button type="button" class="${cls.join(' ')}" data-cal-day="${dk}">
          <span class="cal-cell-day">${d}</span>
          <span class="cal-cell-gross">${fmt$(round2(b.gross))}</span>
          <span class="cal-cell-net">${fmt$(round2(b.net))}</span>
          <span class="cal-cell-qty">${fmtN(b.qty)} item${b.qty === 1 ? '' : 's'}</span>
        </button>`;
    } else {
      grid += `<div class="${cls.join(' ')}"><span class="cal-cell-day">${d}</span></div>`;
    }
  }
  content.innerHTML = `
    <div class="cal-weekdays" aria-hidden="true">
      <span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span>
    </div>
    <div class="cal-grid">${grid}</div>
  `;
}

// Read-only modal showing every sale on a given day, grouped by customer.
function openDayDetail(dateKey) {
  const b = __monthlyDayBuckets[dateKey];
  if (!b || !b.orders.length) return;

  const byCustomer = new Map();
  for (const o of b.orders) {
    const key = (o.customer || '').toLowerCase().trim();
    if (!byCustomer.has(key)) byCustomer.set(key, { name: o.customer || '', total: 0, profit: 0, items: [] });
    const c = byCustomer.get(key);
    c.total += orderTotal(o);
    c.profit += orderProfit(o);
    c.items.push(...orderItems(o));
  }

  $('#modalTitle').textContent = fmtDateLong(dateKey);
  const form = $('#modalForm');
  form.innerHTML = `
    <div class="day-detail">
      <div class="day-detail-summary">
        <div class="dd-stat dd-stat-gross"><span>Total Gross</span><b>${fmt$(round2(b.gross))}</b></div>
        <div class="dd-stat dd-stat-net"><span>Net Profit</span><b>${fmt$(round2(b.net))}</b></div>
        <div class="dd-stat dd-stat-qty"><span>Total Items</span><b>${fmtN(b.qty)}</b></div>
        <div class="dd-stat"><span>Customers</span><b>${fmtN(byCustomer.size)}</b></div>
      </div>
      <div class="day-detail-list">
        ${[...byCustomer.values()].map(c => `
          <div class="dd-customer">
            <div class="dd-customer-head">
              <b class="dd-customer-name">${escapeHtml(c.name || 'Customer')}</b>
              <span class="dd-customer-totals">${fmt$(round2(c.total))} <span class="muted">· ${fmt$(round2(c.profit))} profit</span></span>
            </div>
            <div class="dd-items">
              ${c.items.map(it => {
                const qty = Number(it.qty) || 0, price = Number(it.price) || 0;
                return `<div class="dd-item">
                  <span class="dd-item-name">${escapeHtml(it.product || '')}</span>
                  <span class="dd-item-qty muted">×${fmtN(qty)}</span>
                  <span class="dd-item-total">${fmt$(round2(qty * price))}</span>
                </div>`;
              }).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  modalOnSave = null;
  modal.classList.add('modal-readonly');
  $('#modalCancel').textContent = 'Close';
  showModal();
}

// ---------- Export & Backup ----------
function downloadBlob(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  } catch (e) {
    console.error('download failed', e);
    toast('Download failed.');
  }
}

// Quote a CSV cell only when it contains a delimiter, quote, or newline.
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Lead with a UTF-8 BOM so Excel reads accented characters correctly.
function toCSV(headers, rows) {
  return '﻿' + [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}
// "Retatrutide x2; BPC-157 x1" — a compact item summary for one spreadsheet cell.
function itemsSummary(items) {
  return (items || []).map(it => {
    const q = Number(it && it.qty) || 0;
    return `${(it && it.product) || ''}${q ? ` x${q}` : ''}`;
  }).filter(s => s.trim()).join('; ');
}

function exportOrdersCSV() {
  const headers = ['Date', 'Customer', 'Items', 'Total Qty', 'Subtotal', 'Discount', 'Shipping', 'Order Total', 'Amount Paid', 'Balance Due', 'Status', 'Delivered', 'Profit'];
  const rows = state.orders.slice()
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .map(o => {
      const status = orderIsFullyPaid(o) ? 'Paid' : (orderPaymentsTotal(o) > 0.005 ? 'Partial' : 'Unpaid');
      return [
        o.date || '', o.customer || '', itemsSummary(orderItems(o)), orderQty(o),
        round2(orderItemsTotal(o)), round2(orderDiscountAmount(o)), round2(orderShipping(o)),
        round2(orderTotal(o)), round2(orderPaidRevenue(o)), round2(orderBalance(o)),
        status, o.delivered ? 'Yes' : 'No', round2(orderProfit(o)),
      ];
    });
  downloadBlob(`lumen-orders-${todayISO()}.csv`, toCSV(headers, rows), 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} order${rows.length === 1 ? '' : 's'}.`);
}

function exportExpensesCSV() {
  const headers = ['Date Ordered', 'Date Received', 'Vendor', 'Description', 'Total Cost'];
  const rows = state.expenses.slice()
    .sort((a, b) => (a.dateOrdered || '').localeCompare(b.dateOrdered || ''))
    .map(e => [
      e.dateOrdered || '', e.dateReceived || '', e.vendor || '',
      itemsSummary(expenseItems(e)) || (e.product || ''), round2(expenseCost(e)),
    ]);
  downloadBlob(`lumen-expenses-${todayISO()}.csv`, toCSV(headers, rows), 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} expense${rows.length === 1 ? '' : 's'}.`);
}

function exportInventoryCSV() {
  const headers = ['Product', 'Cost', 'Price', 'Qty', 'Reorder At', 'Margin', 'Stock Value (Net)', 'Stock Value (Gross)', 'Status'];
  const rows = state.stock.slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(p => {
      const cost = Number(p.cost) || 0, price = Number(p.price) || 0, qty = Number(p.qty) || 0;
      const margin = price - cost;
      return [p.name || '', cost, price, qty, stockReorderLevel(p), margin, round2(margin * qty), round2(price * qty), p.status || 'ACTIVE'];
    });
  downloadBlob(`lumen-inventory-${todayISO()}.csv`, toCSV(headers, rows), 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} product${rows.length === 1 ? '' : 's'}.`);
}

function backupAllJSON() {
  const payload = {
    app: 'lumen-peptides-tracker',
    type: 'backup',
    version: 1,
    build: BUILD_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      stock: state.stock,
      orders: state.orders,
      shipments: state.shipments,
      expenses: state.expenses,
    },
  };
  downloadBlob(`lumen-backup-${todayISO()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  toast('Backup downloaded.');
}

function restoreFromBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(String(reader.result || '')); }
    catch { toast('That file isn’t valid JSON.'); return; }
    const d = (parsed && parsed.data) ? parsed.data : parsed;
    const keys = ['stock', 'orders', 'shipments', 'expenses'];
    if (!d || typeof d !== 'object' || !keys.some(k => Array.isArray(d[k]))) {
      toast('That doesn’t look like a Lumen backup.');
      return;
    }
    const counts = keys.map(k => `${(d[k] || []).length} ${k}`).join(', ');
    if (!confirm(
      `Restore this backup?\n\n${counts}\n\n` +
      `This REPLACES all current data on this device and in the cloud. ` +
      `If you're not sure, download a backup of your current data first.`
    )) return;

    state.stock = Array.isArray(d.stock) ? d.stock : [];
    state.orders = migrateOrders(Array.isArray(d.orders) ? d.orders : []);
    state.shipments = migrateShipments(Array.isArray(d.shipments) ? d.shipments : []);
    state.expenses = migrateExpenses(Array.isArray(d.expenses) ? d.expenses : []);
    saveState();
    setCloudStatus('syncing', 'Syncing…');
    Promise.resolve(cloudPushAll(state))
      .then(() => setCloudStatus('online', 'Synced'))
      .catch(err => { console.error('restore cloud push failed', err); setCloudStatus('offline', 'Sync error'); });
    renderDashboard(); renderOrders(); renderInventory();
    renderShipments(); renderExpenses(); renderIncome(); renderMonthly();
    toast('Backup restored.');
  };
  reader.onerror = () => toast('Could not read that file.');
  reader.readAsText(file);
}

$('#exportOrdersBtn')?.addEventListener('click', exportOrdersCSV);
$('#exportExpensesBtn')?.addEventListener('click', exportExpensesCSV);
$('#exportInventoryBtn')?.addEventListener('click', exportInventoryCSV);
$('#backupBtn')?.addEventListener('click', backupAllJSON);
(function wireRestore() {
  const input = $('#restoreInput');
  $('#restoreBtn')?.addEventListener('click', () => input && input.click());
  input?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) restoreFromBackup(file);
    e.target.value = '';   // let the same file be picked again later
  });
})();

$('#resetBtn').addEventListener('click', resetState);
$('#syncNowBtn').addEventListener('click', manualSync);

// ---------- Mobile drawer ----------
const sidebarEl = $('#sidebar');
const backdropEl = $('#drawerBackdrop');
const menuBtnEl = $('#menuBtn');
function openMenu() {
  sidebarEl.classList.add('open');
  backdropEl.classList.add('show');
  document.body.classList.add('menu-open');
  menuBtnEl?.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  sidebarEl.classList.remove('open');
  backdropEl.classList.remove('show');
  document.body.classList.remove('menu-open');
  menuBtnEl?.setAttribute('aria-expanded', 'false');
}
menuBtnEl?.addEventListener('click', () => {
  sidebarEl.classList.contains('open') ? closeMenu() : openMenu();
});
backdropEl?.addEventListener('click', closeMenu);
$$('.nav-item').forEach(b => b.addEventListener('click', closeMenu));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebarEl.classList.contains('open')) closeMenu();
});

// Touch swipe gestures — right-from-left-edge opens the drawer, left-anywhere closes it.
// Only active on the mobile breakpoint and never while a modal is open.
//
// The touchmove listener (passive: false) is attached PER GESTURE — only when
// a touch starts in a region where a swipe is plausible (the left edge, or
// anywhere while the menu is open) — and removed on touchend. This minimizes
// the time a non-passive touch handler is alive at the document level, which
// is important for iOS standalone PWA mode where always-on document touch
// handlers can interfere with input focus / keyboard activation.
(function setupSwipeGestures() {
  const EDGE_TRIGGER_PX = 48;        // open swipes must start within this many px of the left edge
  const OPEN_THRESHOLD_PX = 30;      // horizontal travel required to open
  const CLOSE_THRESHOLD_PX = 40;     // horizontal travel required to close
  const VERTICAL_TOLERANCE_PX = 60;  // ignore if motion is mostly vertical (treated as scroll)
  const mq = window.matchMedia('(max-width: 900px)');
  let startX = null, startY = null, claimed = null; // claimed: null | 'horizontal' | 'vertical'
  let moveListenerAttached = false;

  // Decide the gesture axis on the FIRST touchmove with any movement. iOS
  // commits to scroll-vs-gesture on that first move: if we preventDefault it,
  // the page won't scroll at all for the rest of the touch (so no up/down jump
  // while opening the menu); if we DON'T, the page scrolls normally. Waiting
  // longer (e.g. until 10px of travel) is what caused the page to nudge before
  // we claimed the swipe. We bias ties toward horizontal so a natural arcing
  // edge-swipe still opens the drawer, but a clearly-vertical drag scrolls.
  function onTouchMove(e) {
    if (startX === null) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const adx = Math.abs(dx), ady = Math.abs(dy);

    if (claimed === null) {
      if (adx === 0 && ady === 0) return; // no direction yet — wait for the next move
      const isOpen = sidebarEl.classList.contains('open');
      const fromEdge = startX <= EDGE_TRIGGER_PX;
      const couldOpen = !isOpen && fromEdge && dx > 0;
      const couldClose = isOpen && dx < 0;
      // Plausible drawer swipe + not vertical-dominant → lock horizontal.
      claimed = ((couldOpen || couldClose) && adx >= ady) ? 'horizontal' : 'vertical';
    }
    if (claimed === 'horizontal' && e.cancelable) {
      e.preventDefault();
    }
  }

  function attachMoveListener() {
    if (moveListenerAttached) return;
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    moveListenerAttached = true;
  }
  function detachMoveListener() {
    if (!moveListenerAttached) return;
    document.removeEventListener('touchmove', onTouchMove, { passive: false });
    moveListenerAttached = false;
  }

  document.addEventListener('touchstart', (e) => {
    claimed = null;
    if (!mq.matches) { startX = null; return; }
    if (document.body.classList.contains('modal-open')) { startX = null; return; }
    if (e.touches.length !== 1) { startX = null; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    // Only listen for touchmove (with preventDefault capability) if this touch
    // could plausibly be a drawer swipe. Tapping inputs / scrolling tables /
    // any other touch leaves the global touch path clean — critical for iOS
    // PWA keyboard activation.
    const fromEdge = startX <= EDGE_TRIGGER_PX;
    const drawerOpen = sidebarEl.classList.contains('open');
    if (fromEdge || drawerOpen) {
      attachMoveListener();
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    detachMoveListener();
    if (startX === null) { claimed = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);
    const x0 = startX;
    const wasHorizontal = claimed === 'horizontal';
    startX = null; claimed = null;
    if (!wasHorizontal && dy > VERTICAL_TOLERANCE_PX) return;
    const isOpen = sidebarEl.classList.contains('open');
    if (!isOpen && x0 <= EDGE_TRIGGER_PX && dx > OPEN_THRESHOLD_PX) {
      openMenu();
    } else if (isOpen && dx < -CLOSE_THRESHOLD_PX) {
      closeMenu();
    }
  }, { passive: true });

  document.addEventListener('touchcancel', () => {
    detachMoveListener();
    startX = null;
    claimed = null;
  }, { passive: true });
})();

// ---------- INIT ----------
function renderAll() {
  renderDashboard();
  renderOrders();
  renderInventory();
  renderShipments();
  renderExpenses();
  renderIncome();
  renderMonthly();
}
saveState(); // persist initial seed if first run
renderAll();
restoreLastView(); // honor the last view the user was on across refreshes

// ---------- AUTH ----------
const loginOverlay = $('#loginOverlay');
const loginForm = $('#loginForm');
const loginBtn = $('#loginBtn');
const loginError = $('#loginError');

function showLogin() {
  loginOverlay.classList.add('show');
  document.body.classList.add('locked');
}
function hideLogin() {
  loginOverlay.classList.remove('show');
  document.body.classList.remove('locked');
  loginError.textContent = '';
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!sb) { loginError.textContent = 'Cloud not configured.'; return; }
  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;
  loginBtn.disabled = true;
  loginError.textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email, password });
  loginBtn.disabled = false;
  if (error) {
    loginError.textContent = error.message || 'Sign-in failed.';
    return;
  }
  loginForm.password.value = '';
  hideLogin();
  initCloud();
});

$('#logoutBtn').addEventListener('click', async () => {
  if (!sb) return;
  if (!confirm('Sign out?')) return;
  await sb.auth.signOut();
  showLogin();
  setCloudStatus('offline', 'Signed out');
});

if (sb) {
  // Body keeps the `app-booting` class (set in HTML) so neither the app
  // nor the login overlay flashes before we know whether a session exists.
  sb.auth.getSession().then(({ data }) => {
    document.body.classList.remove('app-booting');
    if (data && data.session) {
      hideLogin();
      initCloud();
    } else {
      showLogin();
    }
  });
  // Reflect external sign-outs (token expired, signed out from another tab) in the UI.
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') showLogin();
  });
} else {
  document.body.classList.remove('app-booting');
  hideLogin();
  setCloudStatus('offline', 'No cloud configured');
}