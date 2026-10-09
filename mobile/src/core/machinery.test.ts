import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activityGauge, agentActivity, agentLight, gaugeReading, runningStepSeconds, serverLight } from './machinery.ts';

test('a gauge spreads its scale over a 100° arc, clamped at both ends', () => {
  assert.deepEqual(gaugeReading(0, { max: 100, redFrom: 80 }), { angle: -50, red: false });
  assert.deepEqual(gaugeReading(50, { max: 100, redFrom: 80 }), { angle: 0, red: false });
  assert.deepEqual(gaugeReading(100, { max: 100, redFrom: 80 }), { angle: 50, red: true });
  assert.deepEqual(gaugeReading(-5, { max: 100, redFrom: 80 }), { angle: -50, red: false });
  assert.deepEqual(gaugeReading(250, { max: 100, redFrom: 80 }), { angle: 50, red: true });
});

test('the ACTIVIDAD needle reads 0–60 s on a fixed scale and turns red from 45 s', () => {
  assert.deepEqual(activityGauge(0), { angle: -50, red: false });
  const below = activityGauge(44.9);
  assert.ok(Math.abs(below.angle - 24.8333) < 1e-3, `44.9 s at ${below.angle}°`);
  assert.equal(below.red, false);
  assert.deepEqual(activityGauge(45), { angle: 25, red: true });
  assert.deepEqual(activityGauge(60), { angle: 50, red: true });
  assert.deepEqual(activityGauge(600), { angle: 50, red: true });
});

test('with no step in progress the ACTIVIDAD needle rests at 0', () => {
  assert.deepEqual(activityGauge(null), { angle: -50, red: false });
});

test('the step in progress runs from its start in milliseconds to the app clock, in seconds', () => {
  const steps = [{ status: 'done', at: 0 }, { status: 'waiting', at: 1_000_000 }, { status: 'done', at: 1_005_000 }];
  assert.equal(runningStepSeconds(steps, 1_017_000), 17);
  assert.equal(runningStepSeconds([{ status: 'running', at: 1_000_000 }], 999_000), 0, 'a start ahead of the clock reads 0');
  assert.equal(runningStepSeconds([{ status: 'done', at: 0 }, { status: 'error', at: 0 }], 1_000_000), null);
});

test('an Agente lights nothing at rest, orange during a Turno and red while a Decisión waits', () => {
  assert.equal(agentLight({ turnRunning: false, awaitingDecision: false }), 'off');
  assert.equal(agentLight({ turnRunning: true, awaitingDecision: false }), 'orange');
  assert.equal(agentLight({ turnRunning: false, awaitingDecision: true }), 'red');
  assert.equal(agentLight({ turnRunning: true, awaitingDecision: true }), 'red');
});

test('a Servidor lights red if any Agente waits for a Decisión, else orange if any runs a Turno', () => {
  const idle = { turnRunning: false, awaitingDecision: false };
  const running = { turnRunning: true, awaitingDecision: false };
  const waiting = { turnRunning: false, awaitingDecision: true };
  assert.equal(serverLight([]), 'off');
  assert.equal(serverLight([idle, idle]), 'off');
  assert.equal(serverLight([idle, running]), 'orange');
  assert.equal(serverLight([running, waiting, idle]), 'red');
  assert.equal(serverLight([waiting, running]), 'red');
});

test('a polled Agente runs a Turno while busy and waits for a Decisión while it has pending Aprobaciones', () => {
  assert.deepEqual(agentActivity({ status: 'busy', pendingApprovals: 0 }), { turnRunning: true, awaitingDecision: false });
  assert.deepEqual(agentActivity({ status: 'on', pendingApprovals: 2 }), { turnRunning: false, awaitingDecision: true });
  assert.equal(serverLight([{ status: 'on', pendingApprovals: 0 }, { status: 'busy', pendingApprovals: 0 }].map(agentActivity)), 'orange');
});
