// Minimal Supabase REST (PostgREST) client for the serverless functions.
// Uses the service-role key, which must only ever live in Vercel environment
// variables — never in config.js or anything the browser loads.

function cfg() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  return { url, key };
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const { url, key } = cfg();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    const err = new Error(`Supabase ${method} ${path.split('?')[0]}: ${msg}`);
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

const enc = encodeURIComponent;

export const db = {
  select: (table, query = 'select=*') => rest(`${table}?${query}`),
  insert: (table, rows, { ignoreDuplicates = false } = {}) => rest(table, {
    method: 'POST',
    body: rows,
    prefer: ignoreDuplicates
      ? 'resolution=ignore-duplicates,return=representation'
      : 'return=representation',
  }),
  upsert: (table, rows) => rest(table, {
    method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=representation',
  }),
  // `filter` is a raw PostgREST filter string, e.g. `id=eq.o-woo-12`. Returns
  // the updated rows, so an empty array means the filter matched nothing —
  // that's what makes the compare-and-set claims in orders.js atomic.
  update: (table, filter, patch) => rest(`${table}?${filter}`, {
    method: 'PATCH', body: patch, prefer: 'return=representation',
  }),
  remove: (table, filter) => rest(`${table}?${filter}`, {
    method: 'DELETE', prefer: 'return=representation',
  }),
  rpc: (fn, args) => rest(`rpc/${fn}`, { method: 'POST', body: args }),
  eq: (col, val) => `${col}=eq.${enc(val)}`,
};

// Verify the caller is a signed-in tracker user. The browser sends its
// Supabase session token; Supabase Auth tells us whether it's valid.
export async function verifyUser(request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { url, key } = cfg();
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// integration_state helpers. Missing table → behave as empty so the rest of
// the integration still works before the SQL has been run.
export async function getState(key) {
  try {
    const rows = await db.select('integration_state', `select=value&${db.eq('key', key)}`);
    return (rows && rows[0] && rows[0].value) || {};
  } catch { return {}; }
}
export async function patchState(key, patch) {
  try {
    const value = { ...(await getState(key)), ...patch };
    await db.upsert('integration_state', [{ key, value, updated_at: new Date().toISOString() }]);
    return value;
  } catch { return null; }
}
