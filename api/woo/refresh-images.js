import { authed, json } from '../_lib/http.js';
import { db } from '../_lib/supabase.js';
import { sellablesForProduct } from '../_lib/woo.js';
import { refreshLinkedImages } from '../_lib/product-images.js';

export const POST = authed(async () => {
  const rows = await db.select('stock', 'select=id,woo_id,image_url&woo_id=not.is.null');
  const result = await refreshLinkedImages(rows, sellablesForProduct, (row, patch) =>
    // Compare against the image read above: never overwrite a concurrent upload.
    db.update('stock', `${db.eq('id', row.id)}&${row.image_url == null ? 'image_url=is.null' : db.eq('image_url', row.image_url)}`, patch));
  return json(200, result);
});
