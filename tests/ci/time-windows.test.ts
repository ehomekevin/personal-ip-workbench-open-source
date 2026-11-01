import test from 'node:test';
import assert from 'node:assert/strict';
import {periodWindows} from '../../apps/web/src/transport/time-windows.ts';

test('复盘周期按当地日历覆盖当前日，夏令时不重叠或漏一天',()=>{
  const spring=periodWindows('2026-03-08','America/Los_Angeles',7),fall=periodWindows('2026-11-01','America/Los_Angeles',7);
  assert.equal(spring.target.start,'2026-03-02T08:00:00.000Z');assert.equal(spring.target.end,'2026-03-09T07:00:00.000Z');
  assert.equal(fall.target.start,'2026-10-26T07:00:00.000Z');assert.equal(fall.target.end,'2026-11-02T08:00:00.000Z');
  assert.equal(spring.baseline.end,spring.target.start);assert.equal(fall.baseline.end,fall.target.start);
  assert.equal((Date.parse(spring.target.end)-Date.parse(spring.target.start))/3600000,167);
  assert.equal((Date.parse(fall.target.end)-Date.parse(fall.target.start))/3600000,169);
  const east=periodWindows('2026-10-10','Asia/Shanghai',14);assert.equal(east.target.start,'2026-09-26T16:00:00.000Z');assert.equal(east.target.end,'2026-10-10T16:00:00.000Z');
});
