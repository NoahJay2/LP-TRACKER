// WooCommerce REST API (v3) client. Keys come from Vercel environment
// variables and never reach the browser.

function cfg() {
  const store = (process.env.WOO_STORE_URL || '').replace(/\/+$/, '');
  const ck = process.env.WOO_CONSUMER_KEY || '';
  const cs = process.env.WOO_CONSUMER_SECRET || '';
  if (!store || !ck || !cs) throw new Error('WOO_STORE_URL / WOO_CONSUMER_KEY / WOO_CONSUMER_SECRET not set');
  return { store, ck, cs };
}

// Basic auth first; some hosts strip the Authorization header before it
// reaches WordPress, so a 401 retries with the keys as query parameters
// (WooCommerce's documented fallback, fine over HTTPS).
export async function wooFetch(path, { method = 'GET', body, query = {} } = {}) {
  const { store, ck, cs } = cfg();
  const build = (withKeys) => {
    const u = new URL(`${store}/wp-json/wc/v3${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    if (withKeys) { u.searchParams.set('consumer_key', ck); u.searchParams.set('consumer_secret', cs); }
    return u.toString();
  };
  const init = {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  let res = await fetch(build(false), {
    ...init,
    headers: { ...init.headers, Authorization: 'Basic ' + Buffer.from(`${ck}:${cs}`).toString('base64') },
  });
  if (res.status === 401) res = await fetch(build(true), init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = (data && data.message) || `HTTP ${res.status}`;
    const err = new Error(`WooCommerce ${method} ${path}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return { data, headers: res.headers };
}

// Fetch every page of a list endpoint.
export async function wooAll(path, query = {}) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const { data, headers } = await wooFetch(path, { query: { per_page: 100, ...query, page } });
    if (Array.isArray(data)) out.push(...data);
    const totalPages = Number(headers.get('x-wp-totalpages')) || 1;
    if (page >= totalPages || !Array.isArray(data) || data.length === 0) break;
  }
  return out;
}

// woo_id is "123" for a simple product, "123/456" for a variation.
export function wooKey(productId, variationId) {
  return variationId ? `${productId}/${variationId}` : String(productId);
}
export function parseWooKey(key) {
  const [productId, variationId] = String(key || '').split('/');
  return { productId: Number(productId) || 0, variationId: Number(variationId) || 0 };
}

// Some stores return a variation's `name` as just its option ("20mg"), so
// only trust it when it already includes the parent product's name.
function variationName(parent, v) {
  if (v.name && v.name.toLowerCase().includes(String(parent.name || '').toLowerCase())) return v.name;
  const opts = (v.attributes || []).map(a => a.option).filter(Boolean).join(', ') || v.name || '';
  return opts ? `${parent.name} - ${opts}` : parent.name;
}

// Flatten the catalog into sellable units: simple products as-is, variable
// products expanded into one entry per variation (that's where Woo tracks
// stock for them).
export async function listSellables() {
  const products = await wooAll('/products', { status: 'any' });
  const out = [];
  for (const p of products) {
    const parentImage = (p.images && p.images[0] && p.images[0].src) || '';
    if (p.type === 'variable') {
      const vars = await wooAll(`/products/${p.id}/variations`);
      for (const v of vars) {
        out.push({
          wooId: wooKey(p.id, v.id),
          name: variationName(p, v),
          sku: v.sku || '',
          image: (v.image && v.image.src) || parentImage,
          price: Number(v.price) || 0,
          stockQty: v.manage_stock === true ? (Number(v.stock_quantity) || 0) : null,
          status: p.status,
        });
      }
    } else {
      out.push({
        wooId: wooKey(p.id),
        name: p.name,
        sku: p.sku || '',
        image: parentImage,
        price: Number(p.price) || 0,
        stockQty: p.manage_stock ? (Number(p.stock_quantity) || 0) : null,
        status: p.status,
      });
    }
  }
  return out;
}

// Image + SKU for one Woo product id (all its variations included), used when
// a product.updated webhook arrives.
export async function sellablesForProduct(productId) {
  const { data: p } = await wooFetch(`/products/${productId}`);
  const parentImage = (p.images && p.images[0] && p.images[0].src) || '';
  if (p.type !== 'variable') return [{ wooId: wooKey(p.id), sku: p.sku || '', image: parentImage }];
  const vars = await wooAll(`/products/${p.id}/variations`);
  return vars.map(v => ({
    wooId: wooKey(p.id, v.id), sku: v.sku || '', image: (v.image && v.image.src) || parentImage,
  }));
}

// Set Woo's stock count for a linked product. Turns stock management on, so
// Woo shows "out of stock" by itself when the tracker hits zero.
export async function setWooStock(key, qty) {
  const { productId, variationId } = parseWooKey(key);
  if (!productId) return;
  const path = variationId
    ? `/products/${productId}/variations/${variationId}`
    : `/products/${productId}`;
  await wooFetch(path, {
    method: 'PUT',
    body: { manage_stock: true, stock_quantity: Math.max(0, Math.round(Number(qty) || 0)) },
  });
}
