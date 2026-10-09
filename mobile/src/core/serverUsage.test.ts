import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimatedCost, parseUsageCache, usageCache, usageDay, usageRange, usageStamp, validServerUsage } from './serverUsage.ts';
import { demoServerUsage, demoUsage, setDemoUsage, resetDemoUsage } from './serverUsageDemo.ts';
test('zero cost is an estimate, unknown is unavailable, and cached reports are bound to origin/device/period', () => {
  assert.equal(estimatedCost(0), '≈ $0.00'); assert.equal(estimatedCost(null), '—');
  const report = demoServerUsage('week'); const text = usageCache('fixture-device',report);
  assert.deepEqual(parseUsageCache(text,'fixture-device','week'),report);
  assert.equal(parseUsageCache(text,'another-device','week'),null);
  assert.equal(parseUsageCache(text,'fixture-device','day'),null);
  assert.equal(parseUsageCache('{','fixture-device','week'),null);
  assert.equal(parseUsageCache(JSON.stringify({source:'fixture-device',report:{...report,capturedAt:'yesterday'}}),'fixture-device','week'),null);
  assert.equal(parseUsageCache(JSON.stringify({source:'fixture-device',report:{...report,total:{...report.total,tokens:-1}}}),'fixture-device','week'),null);
});

test('all demo periods and data states retain the usage contract and balanced known totals', () => {
  for (const period of ['day','week','month'] as const) for (const state of ['ready','unknown','empty','partial'] as const) {
    const report=demoServerUsage(period,state);
    assert.equal(validServerUsage(report,period),true);
    for (const field of ['tokens','inputTokens','outputTokens','conversations'] as const) {
      assert.equal(report.totalsKnown[field],report.agents.filter(a=>a.status==='ok').reduce((sum,a)=>sum+(a.totalsKnown[field]??0),0));
    }
  }
});
test('demo usage scenarios and resetting are isolated to the selected Server', async () => {
  try {
    setDemoUsage('atlas','unknown');
    assert.equal((await demoUsage('atlas','week')).totalsKnown.estimatedCostUsd,null);
    setDemoUsage('atlas','offline');
    await assert.rejects(demoUsage('atlas','day'), {code:'unreachable'});
    resetDemoUsage();
    assert.notEqual((await demoUsage('atlas','week')).totalsKnown.estimatedCostUsd,null);
  } finally { resetDemoUsage(); }
});

test('the usage header dates are 24 h, in the Server timezone, and name the days in Spanish', () => {
  assert.equal(usageStamp(Date.parse('2026-10-14T18:00:00Z'), 'America/Mexico_City'), '14 OCT 12:00');
  assert.equal(usageStamp(Date.parse('2026-10-14T06:05:00Z'), 'America/Mexico_City'), '14 OCT 00:05');
  assert.equal(usageDay('2026-10-12'), '12 OCT');
  assert.equal(usageRange('2026-10-12', '2026-10-14'), '12–14 OCT');
  assert.equal(usageRange('2026-10-30', '2026-11-02'), '30 OCT–2 NOV');
  assert.equal(usageRange('2026-10-14', '2026-10-14'), '14 OCT');
});
