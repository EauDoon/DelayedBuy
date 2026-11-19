import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {reportResults,reportSummary,reportPage} from '../ui/report.mjs';
const csv = readFileSync(new URL('../economics/sensitivity.csv',import.meta.url),'utf8').trim().split(/\r?\n/);
const [header,...lines]=csv, keys=header.split(',');
const rows=lines.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[keys[i],v])));
test('all 64 report selections reproduce independently parsed CSV values and periods',()=>{
 assert.equal(rows.length,64);
 for(const s of rows) {
   const {row,series,total,negative}=reportSummary(+s.principal,+s.days,100*+s.apr);
   assert.equal(total,64);assert.equal(negative,64);assert.deepEqual(series.map(r=>r[1]),[1,7,14,30]);
   for (const [i,k,places] of [[3,'gross_interest',4],[4,'cancel_shopper',2],[5,'cancel_merchant',2],[6,'incremental_result',4]]) {
     assert.ok(Math.abs(Number(row[i])-Number(s[k]))<=0.500000001*Math.pow(10,-places)); }
   assert.ok(series.every(r=>r[0]===+s.principal && r[2]===+s.apr*100));
 }
});
test('default distinguishes gross, customer, merchant and net',()=>{
 const s=reportResults(100,7,4);for (const t of ['S$0.0767','S$0.06','S$0.01','−S$1.1700','25% cancel','64 of 64'])assert.ok(s.includes(t),t);
 assert.equal((s.match(/r-active/g)||[]).length,1);
});
test('zero interest creates empty bars, not NaN or misleading minimum fill',()=>{
 const s=reportResults(100,7,0);assert.equal((s.match(/width:0\.0000%/g)||[]).length,4); assert.doesNotMatch(s,/NaN|Infinity|undefined/);
});
test('high case stays bounded; invalid selections fail closed',()=>{
 const s=reportResults(1000,30,8);
 const widths=[...s.matchAll(/width:([.\d]+)%/g)].map(m=>Number(m[1]));assert.equal(widths.length,4);assert.equal(Math.max(...widths),100);assert.equal(Math.min(...widths)>=0,true);
 assert.throws(()=>reportSummary(101,7,4),RangeError);
});
test('offline report includes accessible labels, method and return path',()=>{
 const s=reportPage();assert.match(s,/id="r-results" aria-live="polite"/);assert.equal((s.match(/<label>/g)||[]).length,3);assert.match(s,/href="#checkout"/);assert.match(s,/No money is invested/);assert.doesNotMatch(s,/https?:\/\//);
});
