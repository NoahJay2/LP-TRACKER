import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const ctx = vm.createContext({
  orderTotal: o => o.total,
  orderPayments: o => o.payments || [],
  orderPaidProfit: o => o.profit,
  orderQty: o => o.qty,
  orderHasLandedProfit: o => (o.payments || []).reduce((sum,p) => sum+p.amount,0) >= o.total,
});
vm.runInContext(source.slice(source.indexOf('function orderCompletionDate('), source.indexOf('function orderPaidProfit(')), ctx);
vm.runInContext(source.slice(source.indexOf('function monthlyOrderEvents('), source.indexOf('function renderMonthly(')), ctx);
const events = o => JSON.parse(JSON.stringify(ctx.monthlyOrderEvents(o)));

test('payment stays in October when a completed delivery moves to November', () => {
  const order = { date:'2026-11-03', delivered:true, total:100, profit:60, qty:2, payments:[{amount:100,date:'2026-10-30'}] };
  const result = events(order);
  assert.deepEqual(result.filter(e => e.gross).map(e => [e.date,e.gross]), [['2026-10-30',100]]);
  assert.deepEqual(result.filter(e => e.completed), [{date:'2026-11-03',qty:2,completed:true}]);
  assert.deepEqual(result.filter(e => e.net), [{date:'2026-10-30',net:60}]);
  order.date='2026-11-05';
  assert.deepEqual(events(order).filter(e => e.gross),result.filter(e => e.gross));
  order.delivered=false;
  assert.equal(events(order).some(e => e.completed),false);
  assert.deepEqual(events(order).filter(e => e.gross),result.filter(e => e.gross));
});

test('split payments keep their own dates; profit lands when fully paid', () => {
  const result=events({date:'2026-11-03',delivered:true,total:100,profit:60,qty:2,payments:[{date:'2026-11-02',amount:60},{date:'2026-10-30',amount:40}]});
  assert.deepEqual(result.filter(e => e.gross).map(e => [e.date,e.gross]),[['2026-10-30',40],['2026-11-02',60]]);
  assert.deepEqual(result.filter(e => e.net),[{date:'2026-11-02',net:60}]);
});

test('paid unfulfilled orders have cash but no completed items; excess payments are capped', () => {
  const result=events({date:'2026-11-03',delivered:false,total:100,profit:60,qty:2,payments:[{date:'2026-10-30',amount:120}]});
  assert.equal(result.some(e => e.completed),false);
  assert.equal(result.reduce((sum,e) => sum+(e.gross||0),0),100);
  assert.equal(result[0].payment.amount,100);
});
