// Import one specific WooCommerce order that the connection-date rule would
// otherwise skip (it was placed before the store was connected). The order is
// remembered in integration_state so its later status changes keep syncing.
// The duplicate check still applies, so an order already entered by hand
// isn't added twice.
//
// Body: { number }  — the order number shown in WooCommerce (e.g. 1351).
import { authed, json, readJson } from '../_lib/http.js';
import { getState, patchState } from '../_lib/supabase.js';
import { wooFetch, wooAll } from '../_lib/woo.js';
import { processWooOrder } from '../_lib/orders.js';

async function findOrder(number) {
  // The order number is usually the order id; fall back to a search for
  // stores with custom order numbers.
  try {
    const { data } = await wooFetch(`/orders/${encodeURIComponent(number)}`);
    if (data && String(data.number) === String(number)) return data;
  } catch {}
  const hits = await wooAll('/orders', { search: String(number) });
  return hits.find(o => String(o.number) === String(number)) || null;
}

export const POST = authed(async (request) => {
  const { number } = await readJson(request);
  if (!number) return json(400, { error: 'Order number required.' });
  const wo = await findOrder(number);
  if (!wo) return json(404, { error: `Order #${number} not found in WooCommerce.` });

  const state = await getState('woo');
  const includeOrders = [...new Set([...(state.includeOrders || []).map(String), String(wo.id)])];
  await patchState('woo', { includeOrders });

  const result = await processWooOrder(wo);
  return json(200, { ok: true, number: wo.number, status: wo.status, ...result });
});
