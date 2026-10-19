// Registers this deployment's webhook endpoint with WooCommerce, so nothing
// has to be configured by hand in WordPress. Safe to run repeatedly: existing
// webhooks are re-activated, missing ones created.
import { authed, json } from '../_lib/http.js';
import { patchState, getState } from '../_lib/supabase.js';
import { wooFetch } from '../_lib/woo.js';

export const WEBHOOK_TOPICS = [
  'order.created', 'order.updated', 'order.deleted',
  'product.updated', 'product.deleted',
];

export function webhookUrl(request) {
  const u = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || u.host;
  return `https://${host}/api/woo/webhook`;
}

export const POST = authed(async (request) => {
  const secret = process.env.WOO_WEBHOOK_SECRET;
  if (!secret) return json(400, { error: 'WOO_WEBHOOK_SECRET is not set in Vercel.' });
  const url = webhookUrl(request);
  if (/\/\/(localhost|127\.|0\.0\.0\.0)/.test(url)) {
    return json(400, { error: 'Webhooks need the deployed site — WooCommerce can\'t reach localhost. Run this from your Vercel URL.' });
  }
  const { data: existing } = await wooFetch('/webhooks', { query: { per_page: 100 } });
  const results = [];
  for (const topic of WEBHOOK_TOPICS) {
    const hook = (existing || []).find(w => w.topic === topic && w.delivery_url === url);
    if (hook) {
      // Re-activate (Woo disables a webhook after repeated failures) and make
      // sure it signs with the current secret.
      await wooFetch(`/webhooks/${hook.id}`, { method: 'PUT', body: { status: 'active', secret } });
      results.push({ topic, action: 'reactivated' });
    } else {
      await wooFetch('/webhooks', {
        method: 'POST',
        body: { name: `Lumen Tracker — ${topic}`, topic, delivery_url: url, secret, status: 'active' },
      });
      results.push({ topic, action: 'created' });
    }
  }
  // First connection: orders from here on are imported by the catch-up job.
  const state = await getState('woo');
  if (!state.connectedAt) await patchState('woo', { connectedAt: new Date().toISOString() });
  return json(200, { ok: true, url, results });
});
