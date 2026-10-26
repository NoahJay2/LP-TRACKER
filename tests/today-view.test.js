import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const context = vm.createContext({ orderTotal: o => o.total, orderPaidRevenue: o => o.paidAmount || 0 });
vm.runInContext(source.slice(source.indexOf('function todayDeliveryGroups('), source.indexOf('// ---------- DASHBOARD ----------')), context);
const group = orders => context.todayDeliveryGroups(orders, '2026-10-27');
test('groups by delivery date and customer, keeping partial and fulfilled-unpaid work visible', () => {
  const result = group([
    { customer: 'Alex', date: '2026-10-27', total: 100, paidAmount: 40, paid: false, delivered: true },
    { customer: ' alex ', date: '2026-10-27', total: 20, paidAmount: 20, paid: true, delivered: false },
    { customer: 'Bea', date: '2026-10-27', total: 30, paidAmount: 30, paid: true, delivered: false },
    { customer: 'Done', date: '2026-10-27', total: 10, paidAmount: 10, paid: true, delivered: true },
    { customer: 'Later', date: '2026-10-29', total: 50 },
  ]);
  assert.equal(result.needsPayment.length, 1);
  assert.equal(result.needsPayment[0].balance, 60);
  assert.equal(result.needsPayment[0].orders.length, 2);
  assert.equal(result.ready[0].name, 'Bea');
  assert.equal(result.done.length, 1);
});
test('overdue groups retain completed members for consistent totals and exclude settled dates', () => {
  const result = group([
    { customer: 'Alex', date: '2026-10-23', total: 40, paidAmount: 40, paid: true, delivered: true },
    { customer: 'Alex', date: '2026-10-23', total: 60, paidAmount: 10, paid: false, delivered: false },
    { customer: 'Done', date: '2026-10-22', total: 10, paid: true, delivered: true },
    { customer: 'Undated', total: 30 },
  ]);
  assert.equal(result.overdue.length, 1);
  assert.equal(result.overdue[0].total, 100);
  assert.equal(result.overdue[0].balance, 50);
});

test('rescheduling moves only unfulfilled orders without changing payments or stock', () => {
  const writes = [];
  Object.assign(context, {
    saveState() {}, cloudUpsertMany: (table, rows) => writes.push([table, rows]),
    renderOrders() {}, renderInventory() {}, renderDashboard() {}, renderMonthly() {}, renderCustomers() {}, toast() {},
    reconcileOrderInventory() { throw new Error('Reschedule must not touch inventory'); },
  });
  const payment = { amount: 20, date: '2026-10-20' };
  const pending = { date: '2026-10-27', delivered: false, payments: [payment] };
  const completed = { date: '2026-10-27', delivered: true };
  context.updateTodayDeliveryGroup({ orders: [pending, completed] }, 'reschedule', '2026-10-29');
  assert.equal(pending.date, '2026-10-29');
  assert.equal(completed.date, '2026-10-27');
  assert.equal(pending.payments[0], payment);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].length, 1);
});

test('paid and fulfilled actions toggle on and off, reconciling changed orders', () => {
  let reconciled = 0, payments = 0;
  Object.assign(context, {
    reconcileOrderInventory() { reconciled++; return []; },
    setOrderFullyPaid(o, value) { payments++; o.paid = value; },
  });
  const orders = [{ paid: false, delivered: false }, { paid: true, delivered: true }];
  context.updateTodayDeliveryGroup({ orders }, 'paid');
  context.updateTodayDeliveryGroup({ orders }, 'paid');
  context.updateTodayDeliveryGroup({ orders }, 'fulfilled');
  context.updateTodayDeliveryGroup({ orders }, 'fulfilled');
  assert.equal(payments, 3);
  assert.equal(reconciled, 6);
  assert.ok(orders.every(o => !o.paid && !o.delivered));
});
