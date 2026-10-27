// Receives WooCommerce webhooks (order.created / order.updated / order.deleted,
// product.updated / product.deleted). Registered by /api/woo/setup.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { json } from '../_lib/http.js';
import { db, patchState } from '../_lib/supabase.js';
import { sellablesForProduct } from '../_lib/woo.js';
import { processWooOrder, deleteWooOrder } from '../_lib/orders.js';
import { storeImagePatch } from '../_lib/product-images.js';

function validSignature(raw, header) {
  const secret = process.env.WOO_WEBHOOK_SECRET || '';
  if (!secret || !header) return false;
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest();
  let given;
  try { given = Buffer.from(header, 'base64'); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function refreshProduct(productId) {
  const items = await sellablesForProduct(productId);
  for (const it of items) {
    const rows = await db.select('stock', `select=id,image_url&${db.eq('woo_id', it.wooId)}`);
    for (const row of rows) {
      await db.update('stock', db.eq('id', row.id), { sku: it.sku || null });
      const patch = storeImagePatch(row, it);
      if (patch) await db.update('stock', `${db.eq('id', row.id)}&${row.image_url == null ? 'image_url=is.null' : db.eq('image_url', row.image_url)}`, patch);
    }
  }
  return { action: 'product-refreshed', count: items.length };
}

async function unlinkProduct(productId) {
  // Unlink the product and any of its variations; the tracker rows stay.
  const a = await db.update('stock', db.eq('woo_id', String(productId)), { woo_id: null });
  const b = await db.update('stock', `woo_id=like.${encodeURIComponent(productId + '/*')}`, { woo_id: null });
  return { action: 'product-unlinked', count: (a || []).length + (b || []).length };
}

export async function POST(request) {
  const raw = await request.text();
  const topic = request.headers.get('x-wc-webhook-topic') || '';

  // Woo sends a form-encoded "webhook_id=…" ping right after a webhook is
  // created. Acknowledge it so Woo marks the webhook healthy.
  if (!topic && /^webhook_id=\d+/.test(raw)) return json(200, { ok: true, ping: true });

  if (!validSignature(raw, request.headers.get('x-wc-webhook-signature'))) {
    return json(401, { error: 'Bad signature' });
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return json(400, { error: 'Bad JSON' }); }

  try {
    let result;
    if (topic === 'order.created' || topic === 'order.updated') result = await processWooOrder(payload);
    else if (topic === 'order.deleted') result = await deleteWooOrder(payload.id);
    else if (topic === 'product.updated' || topic === 'product.created') result = await refreshProduct(payload.id);
    else if (topic === 'product.deleted') result = await unlinkProduct(payload.id);
    else result = { action: 'ignored' };
    await patchState('woo', { lastWebhookAt: new Date().toISOString(), lastWebhookTopic: topic, lastError: null });
    return json(200, { ok: true, topic, ...result });
  } catch (err) {
    console.error('webhook failed', topic, err);
    await patchState('woo', { lastError: `${topic}: ${err.message}`, lastErrorAt: new Date().toISOString() }).catch(() => {});
    // 500 makes Woo log the failure (and disable the webhook after repeated
    // failures), which surfaces on the Integrations page instead of hiding it.
    return json(500, { error: err.message });
  }
}
