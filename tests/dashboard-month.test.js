import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const ctx = vm.createContext({
  round2: n => Math.round(n * 100) / 100,
  orderPaidRevenue: o => o.revenue, orderPaidProfit: o => o.profit,
  orderBalance: o => o.balance || 0,
  sumOperating: expenses => expenses.filter(e => !e.excludeFromNet).reduce((s, e) => s + e.amount, 0),
});
vm.runInContext(source.slice(source.indexOf('function dashboardMonthOverview('), source.indexOf('function todayDeliveryGroups(')), ctx);
test('month comparison separates gross and net, excludes future activity from pace', () => {
  const result = ctx.dashboardMonthOverview([
    {date:'2026-10-05', revenue:100, profit:60},
    {date:'2026-10-25', revenue:500, profit:300, balance:40},
    {date:'2026-09-30', revenue:200, profit:110},
  ], [{dateOrdered:'2026-10-01',amount:20}, {dateOrdered:'2026-10-01',amount:900,excludeFromNet:true}], '2026-10-10');
  assert.equal(result.current.gross, 60);
  assert.equal(result.current.net, 40);
  assert.equal(result.previous.revenue, 200);
  assert.equal(result.pace.revenue, 310);
  assert.equal(result.pace.net, 124);
  assert.equal(result.pending, 40);
});
test('empty January and expenses-only months remain finite and handle year boundary', () => {
  const r = ctx.dashboardMonthOverview([{date:'2025-12-31',revenue:50,profit:30}], [{dateReceived:'2026-01-01',amount:10}], '2026-01-01');
  assert.equal(r.previous.gross, 30);
  assert.equal(r.current.net, -10);
  assert.equal(r.pace.net, -310);
  assert.equal(r.pace.revenue, 0);
});
