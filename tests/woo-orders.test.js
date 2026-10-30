import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../api/_lib/supabase.js';
import { processWooOrder, wooAmountDue, buildFinancialItems } from '../api/_lib/orders.js';

test('checkout totals include fractional discounts and exclude only actual shipping', () => {
  for (const [total, shipping, expected] of [['99.37','8','91.37'], ['225.50','0','225.50']]) {
    const wo = { total, shipping_total: shipping, line_items: [{ name:'Test', quantity:3, subtotal:'120', total:'91.37' }] };
    assert.equal(wooAmountDue(wo), Number(expected));
    const items = buildFinancialItems(wo, []);
    assert.equal(Math.round(items.reduce((sum,i)=>sum+i.qty*i.price,0)*100)/100, Number(expected));
  }
});

test('completed sync keeps fulfillment manual, payment exact, stock deducted once; cancellation restores once', async t => {
  const rows = new Map();
  const stock = [{ id:'s1', name:'Test', qty:20, cost:10, woo_id:null }];
  t.mock.method(db, 'select', async (table, query) => {
    if (table === 'integration_state') return [{value:{connectedAt:'2026-01-01'}}];
    if (table === 'stock') return structuredClone(stock);
    if (table === 'customers') return [];
    if (query.includes('id=eq.')) return rows.has('o-woo-1') ? [structuredClone(rows.get('o-woo-1'))] : [];
    return [];
  });
  t.mock.method(db, 'insert', async (table, entries) => { if (table === 'orders') for(const row of entries) if(!rows.has(row.id)) rows.set(row.id,structuredClone(row)); });
  t.mock.method(db, 'update', async (table, filter, patch) => {
    const row = rows.get('o-woo-1');
    if (!row) return [];
    if (filter.includes('inventory_applied=is.') && row.inventory_applied !== filter.endsWith('true')) return [];
    Object.assign(row, structuredClone(patch));
    return [structuredClone(row)];
  });
  t.mock.method(db, 'remove', async () => rows.delete('o-woo-1'));
  t.mock.method(db, 'rpc', async (fn, args) => { stock[0].qty += args.p_delta; });
  const wo = {id:1,status:'completed',date_created:'2026-10-29',total:'99.37',shipping_total:'8',line_items:[{name:'Test',quantity:3,subtotal:'120',total:'91.37'}]};
  await processWooOrder(wo);
  assert.equal(rows.get('o-woo-1').delivered,false);
  assert.equal(rows.get('o-woo-1').paid,true);
  assert.equal(rows.get('o-woo-1').payments[0].amount,91.37);
  assert.equal(stock[0].qty,17);
  await processWooOrder(wo);
  assert.equal(rows.get('o-woo-1').delivered,false);
  assert.equal(rows.get('o-woo-1').payments.length,1);
  assert.equal(stock[0].qty,17);
  rows.get('o-woo-1').delivered=true;
  await processWooOrder(wo);
  assert.equal(rows.get('o-woo-1').delivered,true);
  await processWooOrder({...wo,status:'cancelled'});
  assert.equal(rows.size,0);
  assert.equal(stock[0].qty,20);
  await processWooOrder({...wo,status:'cancelled'});
  assert.equal(stock[0].qty,20);
});
