import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobAuthorizationCurrent, jobScheduleLabel } from './scheduledJobs.ts';
test('late job fingerprint cannot survive identity, visibility or expiry changes', () => {
  const initial = { identity: 'A/coding/job/key1', epoch: 1, visible: true, connected: true, now: 1000 };
  assert.equal(jobAuthorizationCurrent(initial, { ...initial, now: 2000 }), true);
  for (const change of [{ identity: 'A/default/job/key1' }, { epoch: 2 }, { visible: false }, { connected: false }, { now: 61000 }, { now: 999 }])
    assert.equal(jobAuthorizationCurrent(initial, { ...initial, ...change }), false);
});
test('job times use explicit Servidor timezone and interval units', () => {
  assert.equal(jobScheduleLabel('every 30m'), 'Cada 30 min');
  assert.equal(jobScheduleLabel('every 2h'), 'Cada 2 h');
  assert.equal(jobScheduleLabel('0 9 * * 1-5'), 'De lunes a viernes a las 9:00');
});
test('failure filter recognizes Hermes error and delivery failure statuses', async () => {
  const { jobHasFailed } = await import('./scheduledJobs.ts');
  assert.equal(jobHasFailed('error'), true);
  assert.equal(jobHasFailed('delivery_failed'), true);
  assert.equal(jobHasFailed('ok'), false);
});

test('job timestamps are formatted in Hermes IANA zone across DST, never in the phone zone', async () => {
  const { jobTime } = await import('./scheduledJobs.ts');
  assert.match(jobTime(1793513100000, 'Asia/Tokyo'), /15:05/);
  assert.match(jobTime(1793513100000, 'America/New_York'), /01:05/);
  assert.equal(jobTime(1793513100000, null), 'Zona horaria de Hermes no disponible');
});
test('disabled terminal tasks are not mislabeled as paused', async () => {
  const { jobIsPaused, jobStateLabel } = await import('./scheduledJobs.ts');
  assert.equal(jobIsPaused({enabled:false,state:'completed'}), false);
  assert.equal(jobStateLabel({enabled:false,state:'completed'}), 'COMPLETADA');
  assert.equal(jobIsPaused({enabled:false,state:'paused'}), true);
});
test('demo mutations keep two Agentes with the same job id separate', async () => {
  const { createDemoClient } = await import('./demo.ts');
  const client = createDemoClient('atlas');
  const coding = await client.scheduledJob('dev', 'abcdef123451');
  const research = await client.scheduledJob('research', 'abcdef123451');
  assert.equal(coding.name, 'Sincronizar métricas');
  assert.equal(research.name, 'Informe mensual de uso');
  await client.deleteJob('dev', 'abcdef123451');
  await assert.rejects(client.scheduledJob('dev', 'abcdef123451'));
  assert.equal((await client.scheduledJob('research', 'abcdef123451')).name, 'Informe mensual de uso');
});
test('the next-run window reads in the Servidor zone: hoy, mañ, a date, or a dash with no next run, and a question mark when the zone is missing', async () => {
  const { jobWindow } = await import('./scheduledJobs.ts');
  const zone = 'America/Mexico_City';
  const now = Date.parse('2026-10-05T07:00:00-06:00');
  const at = (iso: string) => Date.parse(iso);
  assert.equal(jobWindow(at('2026-10-05T10:00:00-06:00'), zone, now), 'hoy 10:00');
  assert.equal(jobWindow(at('2026-10-06T08:00:00-06:00'), zone, now), 'mañ 08:00');
  assert.equal(jobWindow(at('2026-10-12T10:00:00-06:00'), zone, now), '12 oct');
  // 23:30 in Mexico City is already tomorrow in UTC: the day is the Servidor's.
  assert.equal(jobWindow(at('2026-10-05T23:30:00-06:00'), zone, now), 'hoy 23:30');
  assert.equal(jobWindow(null, zone, now), '—');
  assert.equal(jobWindow(at('2026-10-05T10:00:00-06:00'), null, now), '?');
  assert.equal(jobWindow(at('2026-10-05T10:00:00-06:00'), 'No/Such_Zone', now), '?');
  assert.equal(jobWindow(null, null, now), '—');
});
test('only a job whose Hermes state is running counts as running', async () => {
  const { jobIsRunning } = await import('./scheduledJobs.ts');
  assert.equal(jobIsRunning({ enabled: true, state: 'running' }), true);
  assert.equal(jobIsRunning({ enabled: true, state: 'scheduled' }), false);
  assert.equal(jobIsRunning({ enabled: false, state: 'running' }), false);
});
