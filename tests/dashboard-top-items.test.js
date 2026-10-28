import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const ctx=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function orderItems('),source.indexOf('function syncOrderPaidFlag('))+source.slice(source.indexOf('function dashboardTopItems('),source.indexOf('function dashboardMonthOverview(')),ctx);
const item=(product,qty,price,cogs=10,extra={})=>({product,qty,price,cogs,...extra});
test('top items use paid current-month orders, limit to five and rank by discounted product sales',()=>{
 const orders=[{date:'2026-10-01',paid:true,shipping:100,discount:{type:'amount',value:20},items:[item('A',2,50),item('B',1,50,10,{excludeDiscount:true})]},
 {date:'2026-10-02',paid:true,items:[item('A',1,50,10,{discount:10})]},
 {date:'2026-10-05',paid:false,payments:[{amount:5}],items:[item('Unpaid',1,999)]},
 {date:'2026-10-31',paid:true,items:[item('Future',1,999)]},
 {date:'2026-09-01',paid:true,items:[item('Old',1,999)]},
 ...['C','D','E','F'].map(product=>({date:'2026-10-01',paid:true,items:[item(product,1,20)]}))];
 const rows=ctx.dashboardTopItems(orders,'2026-10-28');
 assert.equal(rows.length,5); assert.equal(rows[0].name,'A'); assert.equal(rows[0].qty,3); assert.equal(rows[0].sales,120); assert.equal(rows[0].profit,90); assert.equal(rows[1].sales,50);
 assert.deepEqual(Array.from(rows,r=>r.name),['A','B','C','D','E']);
});
test('top items handle empty data and fully discounted items without invalid values',()=>{
 assert.equal(ctx.dashboardTopItems([],'2026-10-28').length,0);
 const rows=ctx.dashboardTopItems([{date:'2026-10-01',paid:true,items:[item('Gift',1,10,5,{discount:10})],discount:{type:'percent',value:100}}],'2026-10-28');
 assert.equal(rows[0].sales,0); assert.equal(rows[0].profit,-5);
});
