import { verifyUser } from './supabase.js';

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Wrap a handler that requires a signed-in tracker user.
export function authed(fn) {
  return async (request) => {
    try {
      const user = await verifyUser(request);
      if (!user) return json(401, { error: 'Not signed in.' });
      return await fn(request, user);
    } catch (err) {
      console.error(err);
      return json(500, { error: err.message || 'Server error' });
    }
  };
}

export async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}
