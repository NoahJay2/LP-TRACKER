// Connection health for the Integrations page.
import { authed, json } from '../_lib/http.js';
import { getState } from '../_lib/supabase.js';
import { wooFetch } from '../_lib/woo.js';
import { WEBHOOK_TOPICS, webhookUrl } from './setup.js';

const REQUIRED_ENV = [
  'WOO_STORE_URL', 'WOO_CONSUMER_KEY', 'WOO_CONSUMER_SECRET', 'WOO_WEBHOOK_SECRET',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
];

export const GET = authed(async (request) => {
  const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
  const out = {
    store: (process.env.WOO_STORE_URL || '').replace(/\/+$/, ''),
    missingEnv,
    reachable: false,
    webhooks: [],
    state: await getState('woo'),
  };
  if (missingEnv.some(k => k.startsWith('WOO_STORE') || k.startsWith('WOO_CONSUMER'))) return json(200, out);
  try {
    await wooFetch('/products', { query: { per_page: 1 } });
    out.reachable = true;
    const { data } = await wooFetch('/webhooks', { query: { per_page: 100 } });
    const url = webhookUrl(request);
    out.webhookUrl = url;
    out.webhooks = WEBHOOK_TOPICS.map(topic => {
      const hook = (data || []).find(w => w.topic === topic && w.delivery_url === url);
      return { topic, status: hook ? hook.status : 'missing' };
    });
  } catch (err) {
    out.error = err.message;
  }
  return json(200, out);
});
