// Turns WooCommerce orders into tracker orders and keeps stock in step.
//
// Ownership: the tracker owns the stock count. A web order deducts once, here,
// and the resulting count is pushed back to the linked Woo product — so Woo
// always mirrors the tracker and nothing is counted twice.
//
// Every step is idempotent: Woo fires order.created and order.updated for the
// same order within milliseconds, retries deliveries, and the catch-up import
// replays orders. The inventory deduction is guarded by a compare-and-set on
// `inventory_applied`, so only one invocation ever applies (or releases) it.

import { db, getState } from './supabase.js';
import { setWooStock, wooKey } from './woo.js';

// The tracker mirrors WooCommerce's status; Woo itself handles payment
// reminders and auto-cancelling unpaid orders.
//
// Shown in the tracker. Pending payment and On-hold appear as unpaid orders.
const SHOWN = new Set(['pending', 'on-hold', 'processing', 'completed']);
// Woo reduces stock for these, so the tracker holds it too. Pending doesn't
// take stock until it's paid (Woo's own rule).
const HELD = new Set(['processing', 'on-hold', 'completed']);
// Money received → Paid.
const PAID = new Set(['processing', 'completed']);
// Shipped / done → Fulfilled in the tracker.
const DONE = new Set(['completed']);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (s) => String(s || '').toLowerCase().trim();

export const trackerOrderId = (wooOrderId) => `o-woo-${wooOrderId}`;

// Same derivation as customerIdFromName() in app.js, so a profile auto-made
// here and one auto-made by the app land on the same row.
function customerIdFromName(name) {
  const slug = norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return 'c-auto-' + (slug || 'customer');
}

function customerName(wo) {
  const b = wo.billing || {};
  const s = wo.shipping || {};
  const name = [b.first_name, b.last_name].filter(Boolean).join(' ').trim()
    || [s.first_name, s.last_name].filter(Boolean).join(' ').trim();
  return name || b.email || 'Web customer';
}

function formatAddress(a) {
  if (!a || !a.address_1) return '';
  const cityLine = [a.city, [a.state, a.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.address_1, a.address_2, cityLine].filter(Boolean).join(', ');
}

function findStockForLine(li, stock) {
  const key = wooKey(li.product_id, li.variation_id);
  return stock.find(s => s.woo_id === key)
    || stock.find(s => norm(s.name) === norm(li.name))
    || null;
}

function buildItems(wo, stock) {
  return (wo.line_items || []).map(li => {
    const qty = Number(li.quantity) || 0;
    const s = findStockForLine(li, stock);
    return {
      // Use the tracker's product name so inventory, reports and the
      // existing name-based stock matching all line up.
      product: s ? s.name : li.name,
      qty,
      // Pre-coupon unit price; the coupon becomes the order-level discount.
      price: qty ? round2(Number(li.subtotal) / qty) : 0,
      cogs: s ? (Number(s.cost) || 0) : 0,
      discount: null,
    };
  }).filter(it => it.qty > 0);
}

function buildNotes(wo) {
  const parts = [`Web order #${wo.number || wo.id}`];
  if (wo.payment_method_title) parts.push(wo.payment_method_title);
  const tax = Number(wo.total_tax) || 0;
  if (tax > 0) parts.push(`tax $${tax.toFixed(2)}`);
  const fees = (wo.fee_lines || []).reduce((s, f) => s + (Number(f.total) || 0), 0);
  if (fees) parts.push(`fees $${fees.toFixed(2)}`);
  let notes = parts.join(' · ');
  if (wo.customer_note) notes += `\nCustomer note: ${wo.customer_note}`;
  return notes;
}

function wooPayment(wo, amount) {
  return {
    id: `p-woo-${wo.id}`,
    amount: round2(amount),
    date: String(wo.date_paid || wo.date_created || '').slice(0, 10),
    method: wo.payment_method_title || 'Website',
    note: `WooCommerce #${wo.number || wo.id}`,
  };
}

async function upsertCustomer(wo, name) {
  try {
    const b = wo.billing || {};
    const phone = b.phone || '';
    const email = b.email || '';
    const address = formatAddress(wo.shipping) || formatAddress(b);
    const all = await db.select('customers', 'select=*');
    const existing = (all || []).find(c => norm(c.name) === norm(name));
    if (existing) {
      // Fill in blanks only — never overwrite details entered by hand.
      const patch = {};
      if (!existing.phone && phone) patch.phone = phone;
      if (!existing.email && email) patch.email = email;
      if (!existing.address && address) patch.address = address;
      if (Object.keys(patch).length) await db.update('customers', db.eq('id', existing.id), patch);
      return;
    }
    await db.insert('customers', [{
      id: customerIdFromName(name), name, phone, email, address, notes: '',
      created_at: String(wo.date_created || '').slice(0, 10) || null,
    }], { ignoreDuplicates: true });
  } catch (err) {
    // The customers table is optional in this app; the order still imports.
    console.warn('customer upsert skipped:', err.message);
  }
}

// Apply (-1) or release (+1) an order's items against stock. Returns the
// stock rows touched.
async function moveStock(items, direction, stock) {
  const touched = [];
  for (const it of items || []) {
    const qty = Number(it.qty) || 0;
    if (qty <= 0) continue;
    const s = stock.find(r => norm(r.name) === norm(it.product));
    if (!s) continue;
    await db.rpc('adjust_stock', { p_id: s.id, p_delta: direction * qty });
    if (!touched.includes(s)) touched.push(s);
  }
  return touched;
}

// Push the tracker's current qty for these stock rows to WooCommerce.
export async function pushStockToWoo(stockIds) {
  const ids = [...new Set(stockIds)].filter(Boolean);
  if (!ids.length) return { pushed: 0, errors: [] };
  const rows = await db.select('stock', `select=id,name,qty,woo_id&id=in.(${ids.map(encodeURIComponent).join(',')})`);
  const errors = [];
  let pushed = 0;
  for (const r of rows || []) {
    if (!r.woo_id) continue;
    try { await setWooStock(r.woo_id, r.qty); pushed++; }
    catch (err) { errors.push(`${r.name}: ${err.message}`); }
  }
  return { pushed, errors };
}

async function claimInventory(id, from, to) {
  const rows = await db.update('orders', `${db.eq('id', id)}&inventory_applied=is.${from}`, { inventory_applied: to });
  return rows && rows[0];
}

// Remove a tracker order that Woo cancelled / failed / refunded / deleted,
// giving its stock back first.
async function removeOrder(id) {
  const [existing] = await db.select('orders', `select=*&${db.eq('id', id)}`);
  if (!existing) return { action: 'skipped' };
  let touched = [];
  const released = await claimInventory(id, true, false);
  if (released) {
    const stock = await db.select('stock', 'select=id,name,qty,woo_id');
    touched = await moveStock(released.items, +1, stock);
  }
  await db.remove('orders', db.eq('id', id));
  const push = await pushStockToWoo(touched.map(s => s.id));
  return { action: 'removed', id, stockReleased: touched.map(s => s.name), push };
}

export async function deleteWooOrder(wooOrderId) {
  return removeOrder(trackerOrderId(wooOrderId));
}

// When the order was placed, as a UTC timestamp.
function placedAt(wo) {
  const gmt = wo.date_created_gmt;
  if (gmt) return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(gmt) ? gmt : gmt + 'Z');
  return Date.parse(wo.date_created || '');
}

const dayMs = 24 * 60 * 60 * 1000;
const itemsKey = (items) => (items || [])
  .map(it => `${norm(it.product)}×${Number(it.qty) || 0}`)
  .sort()
  .join('|');

// A manual tracker order for the same customer, within a day, with the same
// products and quantities — i.e. this web sale was already entered by hand.
async function findManualDuplicate(name, date, items) {
  if (!date) return null;
  const t = Date.parse(date);
  const from = new Date(t - dayMs).toISOString().slice(0, 10);
  const to = new Date(t + dayMs).toISOString().slice(0, 10);
  const rows = await db.select('orders', `select=id,customer,date,items,source&date=gte.${from}&date=lte.${to}`);
  const want = itemsKey(items);
  return (rows || []).find(o =>
    o.source !== 'woo' && norm(o.customer) === norm(name) && itemsKey(o.items) === want
  ) || null;
}

export async function processWooOrder(wo) {
  const id = trackerOrderId(wo.id);
  const status = String(wo.status || '');

  // Orders placed before the store was connected were already tracked by
  // hand. Ignore them completely — even a later status change in Woo (e.g.
  // marking an old order Completed) must not import it a second time.
  const { connectedAt } = await getState('woo');
  if (!connectedAt) return { action: 'skipped', reason: 'not-connected' };
  if (!(placedAt(wo) >= Date.parse(connectedAt))) return { action: 'skipped', reason: 'before-connection' };

  // Cancelled (incl. Woo's auto-cancel of unpaid orders), failed, refunded,
  // trashed: not a sale. Woo gives the stock back, so the tracker does too.
  if (!SHOWN.has(status)) return removeOrder(id);

  const stock = await db.select('stock', 'select=id,name,qty,cost,woo_id');
  const [existing] = await db.select('orders', `select=*&${db.eq('id', id)}`);
  const paid = PAID.has(status);
  let action;

  if (!existing) {
    const name = customerName(wo);
    const date = String(wo.date_created || '').slice(0, 10) || null;
    const items = buildItems(wo, stock);
    const dup = await findManualDuplicate(name, date, items);
    if (dup) return { action: 'skipped', reason: 'duplicate', duplicateOf: dup.id };
  }

  if (!existing) {
    const name = customerName(wo);
    const row = {
      id,
      customer: name,
      date: String(wo.date_created || '').slice(0, 10) || null,
      paid,
      delivered: DONE.has(status),
      items: buildItems(wo, stock),
      payments: paid ? [wooPayment(wo, wo.total)] : [],
      discount: Number(wo.discount_total) > 0 ? { type: 'amount', value: round2(wo.discount_total) } : null,
      notes: buildNotes(wo),
      shipping: round2(wo.shipping_total),
      inventory_applied: false,
      source: 'woo',
      woo_status: status,
    };
    await db.insert('orders', [row], { ignoreDuplicates: true });
    await upsertCustomer(wo, name);
    action = 'created';
  } else {
    // Only ever move flags forward: if it was marked paid or fulfilled by
    // hand in the tracker, a later Woo status doesn't undo that.
    const patch = { woo_status: status };
    if (paid && !existing.paid) {
      const payments = Array.isArray(existing.payments) ? existing.payments : [];
      const have = payments.reduce((s, p) => s + (Number(p && p.amount) || 0), 0);
      const balance = round2((Number(wo.total) || 0) - have);
      patch.payments = balance > 0.005 ? [...payments, wooPayment(wo, balance)] : payments;
      patch.paid = true;
    }
    if (DONE.has(status) && !existing.delivered) patch.delivered = true;
    await db.update('orders', db.eq('id', id), patch);
    action = 'updated';
  }

  // Hold stock exactly once while Woo holds it; give it back if the order
  // drops back to Pending (Woo restores stock then too).
  let touched = [];
  let direction = 0;
  if (HELD.has(status)) {
    const claimed = await claimInventory(id, false, true);
    if (claimed) { touched = await moveStock(claimed.items, -1, stock); direction = -1; }
  } else {
    const released = await claimInventory(id, true, false);
    if (released) { touched = await moveStock(released.items, +1, stock); direction = 1; }
  }
  const push = await pushStockToWoo(touched.map(s => s.id));
  const moved = touched.map(s => s.name);
  return { action, id, stockDeducted: direction < 0 ? moved : [], stockReleased: direction > 0 ? moved : [], push };
}
