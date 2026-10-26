import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { jsPDF } from 'jspdf';

const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../price-list.js', import.meta.url), 'utf8'), context);
const { rowsFor, createPDF } = context.window.LumenPriceList;

test('customer rows use sale prices and never expose internal stock data', () => {
  const stock = [
    { name: 'Beta', price: 60, originalPrice: 90, qty: 3, cost: 12, category: 'peptides' },
    { name: 'Alpha', price: 40, originalPrice: null, qty: 0, category: 'gear' },
    { name: 'Gamma', price: 30, originalPrice: 20, qty: 2, category: 'gear' },
  ];
  const rows = rowsFor(stock, {});
  assert.deepEqual(Array.from(rows, r => [r.name, r.regular, r.current]), [['Alpha', 40, 40], ['Gamma', 30, 30], ['Beta', 90, 60]]);
  assert.equal(rows.some(r => 'cost' in r || 'qty' in r), false);
  assert.equal(stock[0].name, 'Beta');
  assert.equal(rowsFor(stock, { inStock: true, category: 'peptides' }).length, 1);
  assert.equal(rowsFor(stock, { inStock: true, category: 'missing' }).length, 0);
});

test('PDF keeps a long inventory on one page without dropping products', () => {
  const rows = rowsFor(Array.from({ length: 85 }, (_, i) => ({ name: `Product ${String(i).padStart(3, '0')} with a detailed inventory name and strength 10mg`, price: 50, originalPrice: 70, category: 'Peptides' })), {});
  const pdf = createPDF(jsPDF, rows, { title: 'Customer price list', date: 'October 26, 2026' });
  const raw = pdf.output();
  assert.equal(pdf.getNumberOfPages(), 1);
  assert.ok(raw.startsWith('%PDF-'));
  for (let i = 0; i < 85; i++) assert.ok(raw.includes(`Product ${String(i).padStart(3, '0')}`));
  assert.ok(raw.includes(`Page ${pdf.getNumberOfPages()} of ${pdf.getNumberOfPages()}`));
});

test('very long names wrap without clipping on a single page', () => {
  const name = 'Long inventory description '.repeat(150) + 'END-OF-ITEM';
  const rows = rowsFor([{ name, price: 0, originalPrice: null }], {});
  const pdf = createPDF(jsPDF, rows, { title: 'Custom customer list' });
  const raw = pdf.output();
  assert.equal(pdf.getNumberOfPages(), 1);
  assert.ok(raw.includes('END-OF-ITEM'));
  assert.equal(raw.split('(Custom customer list) Tj').length - 1, pdf.getNumberOfPages());
});

test('includes supplied product thumbnails and survives missing or invalid images', () => {
  const image = 'data:image/png;base64,' + readFileSync(new URL('../public/lr-logo.png', import.meta.url)).toString('base64');
  const rows = rowsFor([{ name: 'With image', imageUrl: 'https://example.com/item.png', price: 40 }, { name: 'Without image', price: 20 }], {});
  assert.equal(rows[0].imageUrl, 'https://example.com/item.png');
  const pdf = createPDF(jsPDF, rows, { images: new Map([[rows[0].imageUrl, { data: image, width: 500, height: 500 }]]) });
  assert.ok(pdf.output().includes('/Subtype /Image'));
  assert.equal(pdf.getNumberOfPages(), 1);
  assert.doesNotThrow(() => createPDF(jsPDF, rows, { images: new Map([[rows[0].imageUrl, { data: 'broken', width: 1, height: 1 }]]) }));
});

test('unavailable PDF library fails clearly and permits retry', async () => {
  let attempts = 0;
  const offline = vm.createContext({ window: {}, setTimeout, clearTimeout,
    document: {
      createElement: () => ({ remove() {} }),
      head: { appendChild(script) { attempts++; queueMicrotask(() => script.onerror()); } },
    },
  });
  vm.runInContext(readFileSync(new URL('../price-list.js', import.meta.url), 'utf8'), offline);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(offline.window.LumenPriceList.download([], {}), /Check your connection/);
  }
  assert.equal(attempts, 2);
});
