// Minimal Supabase REST (PostgREST) client for the serverless functions.
// Uses the service-role key, which must only ever live in Vercel environment
// variables — never in config.js or anything the browser loads.

function cfg() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  return { url, key };
}

// The server needs a key that bypasses row-level security. A public key
// (legacy "anon" JWT or new "sb_publishable_…") still answers every request,
// but RLS hides all rows, so writes silently change nothing. Catch that.
export function serviceKeyProblem() {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) return 'SUPABASE_SERVICE_ROLE_KEY is not set.';
  if (key.startsWith('sb_secret_')) return null;
  if (key.startsWith('sb_publishable_')) {
    return 'SUPABASE_SERVICE_ROLE_KEY is the publishable key. Use the secret key (sb_secret_…) or the legacy service_role key.';
  }
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
    if (payload.role === 'service_role') return null;
    return `SUPABASE_SERVICE_ROLE_KEY is the "${payload.role}" key. Use the service_role key (or the sb_secret_… key).`;
  } catch {
    return 'SUPABASE_SERVICE_ROLE_KEY is not a recognised Supabase key.';
  }
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const { url, key } = cfg();
  const problem = serviceKeyProblem();
  if (problem) throw new Error(problem);
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // New-style keys (sb_…) aren't JWTs; Supabase reads the role from the
  // apikey header alone. Legacy JWT keys also go in Authorization.
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
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

// integration_state helpers. A missing table reads as empty so the status
// page still renders before the SQL has run. A bad service key is raised, and
// writes always raise, so the connection date can't be dropped silently.
export async function getState(key) {
  try {
    const rows = await db.select('integration_state', `select=value&${db.eq('key', key)}`);
    return (rows && rows[0] && rows[0].value) || {};
  } catch (err) {
    if (serviceKeyProblem()) throw err;
    return {};
  }
}
export async function patchState(key, patch) {
  const value = { ...(await getState(key)), ...patch };
  await db.upsert('integration_state', [{ key, value, updated_at: new Date().toISOString() }]);
  return value;
}
