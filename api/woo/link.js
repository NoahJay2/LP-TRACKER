// Saves the product links chosen on the Integrations page.
//
// Body: {
//   links:   [{ stockId, wooId }]  link an existing tracker product
//   creates: [wooId]               add a Woo product to the tracker
//   unlinks: [stockId]             stop syncing (tracker product stays)
// }
//
// Linking pushes the tracker's qty to Woo (the tracker owns the count).
// Creating takes Woo's qty as the starting count.
import { authed, json, readJson } from '../_lib/http.js';
import { db, getState, patchState } from '../_lib/supabase.js';
import { listSellables } from '../_lib/woo.js';
import { pushStockToWoo } from '../_lib/orders.js';

const newStockId = () => 's-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

export const POST = authed(async (request) => {
  const body = await readJson(request);
  const links = Array.isArray(body.links) ? body.links : [];
  const creates = Array.isArray(body.creates) ? body.creates : [];
  const unlinks = Array.isArray(body.unlinks) ? body.unlinks : [];

  const catalog = await listSellables();
  const byWooId = new Map(catalog.map(p => [p.wooId, p]));
  const errors = [];

  for (const stockId of unlinks) {
    await db.update('stock', db.eq('id', stockId), { woo_id: null });
  }

  // Release any wooId being re-pointed before claiming it, so the unique
  // index on woo_id doesn't reject the swap.
  for (const { wooId } of links) {
    await db.update('stock', db.eq('woo_id', wooId), { woo_id: null });
  }
  const linked = [];
  for (const { stockId, wooId } of links) {
    const p = byWooId.get(wooId);
    if (!p) { errors.push(`Woo product ${wooId} not found`); continue; }
    const rows = await db.update('stock', db.eq('id', stockId), { woo_id: wooId, image_url: p.image || null, sku: p.sku || null });
    if (!rows || !rows.length) { errors.push(`Tracker product ${stockId} not found`); continue; }
    linked.push(stockId);
  }

  const created = [];
  for (const wooId of creates) {
    const p = byWooId.get(wooId);
    if (!p) { errors.push(`Woo product ${wooId} not found`); continue; }
    const qty = p.stockQty == null ? 0 : p.stockQty;
    const [row] = await db.insert('stock', [{
      id: newStockId(), name: p.name, cost: 0, price: p.price, qty,
      status: qty > 0 ? 'ACTIVE' : 'OUT OF STOCK',
      woo_id: wooId, image_url: p.image || null, sku: p.sku || null,
    }]);
    created.push(row.id);
  }

  const push = await pushStockToWoo([...linked, ...created]);
  const state = await getState('woo');
  if (!state.connectedAt) await patchState('woo', { connectedAt: new Date().toISOString() });

  return json(200, {
    ok: true, linked: linked.length, created: created.length, unlinked: unlinks.length,
    pushed: push.pushed, errors: [...errors, ...push.errors],
  });
});
