// Called by the app after it saves stock changes (manual sale, received
// shipment, edit), so linked Woo products mirror the tracker's count.
import { authed, json, readJson } from '../_lib/http.js';
import { pushStockToWoo } from '../_lib/orders.js';

export const POST = authed(async (request) => {
  const { stockIds } = await readJson(request);
  const result = await pushStockToWoo(Array.isArray(stockIds) ? stockIds : []);
  return json(200, { ok: true, ...result });
});
