import test from 'node:test';
import assert from 'node:assert/strict';
import { storeImagePatch, refreshLinkedImages } from '../api/_lib/product-images.js';

test('store photos refresh missing and changed URLs, while uploads are preserved', () => {
  assert.deepEqual(storeImagePatch({ image_url: null }, { image: 'new.jpg' }), { image_url: 'new.jpg' });
  assert.deepEqual(storeImagePatch({ image_url: 'old.jpg' }, { image: 'new.jpg' }), { image_url: 'new.jpg' });
  assert.equal(storeImagePatch({ image_url: 'data:image/jpeg;base64,custom' }, { image: 'new.jpg' }), null);
  assert.equal(storeImagePatch({ image_url: 'same.jpg' }, { image: 'same.jpg' }), null);
});

test('refresh matches exact variation IDs and fetches each parent once', async () => {
  const calls = [], writes = [];
  const result = await refreshLinkedImages([
    { id: 'a', woo_id: '10/1', image_url: null },
    { id: 'b', woo_id: '10/2', image_url: 'current.jpg' },
    { id: 'c', woo_id: '20', image_url: 'data:image/jpeg;base64,custom' },
    { id: 'd', woo_id: null, image_url: null },
  ], async id => { calls.push(id); return [{ wooId: '10/1', image: 'parent.jpg' }, { wooId: '10/2', image: 'current.jpg' }]; },
  async (row, patch) => { writes.push([row.id, patch.image_url]); return [row]; });
  assert.deepEqual(calls, ['10']);
  assert.deepEqual(writes, [['a', 'parent.jpg']]);
  assert.deepEqual(result.updates, [{ id: 'a', imageUrl: 'parent.jpg' }, { id: 'b', imageUrl: 'current.jpg' }]);
});

test('failed products and concurrent uploads do not overwrite photos or stop other refreshes', async () => {
  const result = await refreshLinkedImages([
    { id: 'a', woo_id: '10', image_url: null }, { id: 'b', woo_id: '20', image_url: null },
  ], async id => { if (id === '10') throw new Error('unavailable'); return [{ wooId: '20', image: 'new.jpg' }]; }, async () => []);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.updates, []);
});
