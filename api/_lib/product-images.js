// A compressed data image is a deliberate tracker upload; Woo owns URL photos.
export function storeImagePatch(row, product) {
  if (/^data:image\//i.test(row.image_url || '')) return null;
  const image = product.image || null;
  if ((row.image_url || null) === image) return null;
  return { image_url: image };
}

export async function refreshLinkedImages(rows, loadProduct, updateRow) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.woo_id || /^data:image\//i.test(row.image_url || '')) continue;
    const parent = String(row.woo_id).split('/')[0];
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(row);
  }
  const updates = [], errors = [];
  for (const [parent, linked] of groups) {
    try {
      const products = await loadProduct(parent);
      for (const row of linked) {
        const product = products.find(p => String(p.wooId) === String(row.woo_id));
        if (!product) continue;
        const patch = storeImagePatch(row, product);
        if (patch) {
          const saved = await updateRow(row, patch);
          if (saved?.length) updates.push({ id: row.id, imageUrl: patch.image_url || '' });
        } else updates.push({ id: row.id, imageUrl: row.image_url || '' });
      }
    } catch (error) { errors.push({ productId: parent, error: error.message }); }
  }
  return { updates, errors };
}
