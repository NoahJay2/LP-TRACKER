// Lists the store's sellable products (variations expanded) for the linking
// screen on the Integrations page.
import { authed, json } from '../_lib/http.js';
import { listSellables } from '../_lib/woo.js';

export const GET = authed(async () => {
  const products = await listSellables();
  return json(200, { products });
});
