// Replays every Woo order placed since the store was connected through the
// same idempotent import the webhook uses — recovers anything a failed or
// disabled webhook missed. Orders from before the connection are never
// imported, so sales already entered by hand aren't counted twice.
import { authed, json } from '../_lib/http.js';
import { getState, patchState } from '../_lib/supabase.js';
import { wooAll } from '../_lib/woo.js';
import { processWooOrder } from '../_lib/orders.js';

export const POST = authed(async () => {
  const state = await getState('woo');
  if (!state.connectedAt) {
    return json(400, { error: 'Not connected yet — register webhooks or link products first.' });
  }
  // connectedAt is UTC; dates_are_gmt makes Woo compare in UTC too instead of
  // the store's timezone.
  const orders = await wooAll('/orders', {
    after: state.connectedAt, dates_are_gmt: true, orderby: 'date', order: 'asc',
  });
  const tally = { created: 0, updated: 0, removed: 0, skipped: 0, duplicates: 0 };
  const errors = [];
  const details = [];
  for (const wo of orders) {
    try {
      const r = await processWooOrder(wo);
      tally[r.action] = (tally[r.action] || 0) + 1;
      if (r.reason === 'duplicate') tally.duplicates++;
      details.push({ number: wo.number || wo.id, status: wo.status, placed: wo.date_created_gmt, action: r.action, reason: r.reason || null });
    } catch (err) {
      errors.push(`#${wo.number || wo.id}: ${err.message}`);
    }
  }
  await patchState('woo', { lastCatchUpAt: new Date().toISOString() });
  return json(200, { ok: true, scanned: orders.length, ...tally, errors, details });
});
