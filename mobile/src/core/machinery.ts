// Decisions behind the 3.1 machinery and light (S-15): where a needle points and what lights up.

export interface GaugeReading {
  /** Degrees from the arc's center: -50 at the scale's start, +50 at its end. */
  angle: number;
  /** Inside the red zone. */
  red: boolean;
}

/** Every needle sweeps a 100° arc: `value` from 0 to `max`, clamped, red from `redFrom`. */
export function gaugeReading(value: number, scale: { max: number; redFrom: number }): GaugeReading {
  const fraction = Math.min(Math.max(value / scale.max, 0), 1) || 0;
  return { angle: fraction * 100 - 50, red: value >= scale.redFrom };
}

/** The ACTIVIDAD needle: seconds of the step in progress on a fixed 0–60 s scale; at 0 with no step. */
export function activityGauge(stepSeconds: number | null): GaugeReading {
  return gaugeReading(stepSeconds ?? 0, { max: 60, redFrom: 45 });
}

/**
 * Seconds the step in progress (running, or waiting for a Decisión) has run: from its start, in epoch
 * milliseconds, to the app clock. Null with no step in progress. Feed this to `activityGauge`, never milliseconds.
 */
export function runningStepSeconds(steps: readonly { status: string; at: number }[], now: number): number | null {
  const step = steps.findLast(s => s.status === 'running' || s.status === 'waiting');
  return step ? Math.max(0, (now - step.at) / 1000) : null;
}

export type Light = 'off' | 'orange' | 'red';
export interface AgentActivity { turnRunning: boolean; awaitingDecision: boolean }

/** Lights and sweep of an Agente: red while a Decisión waits (it wins), orange during a Turno. */
export function agentLight({ turnRunning, awaitingDecision }: AgentActivity): Light {
  return awaitingDecision ? 'red' : turnRunning ? 'orange' : 'off';
}

/** A Servidor (rail selector sweep, Servidores list lights) lights as its most urgent Agente. */
export function serverLight(agents: readonly AgentActivity[]): Light {
  const lights = agents.map(agentLight);
  return lights.includes('red') ? 'red' : lights.includes('orange') ? 'orange' : 'off';
}

/** What the lights read from a polled Agente: busy runs a Turno; a pending Aprobación awaits a Decisión. */
export function agentActivity(agent: { status: string; pendingApprovals: number }): AgentActivity {
  return { turnRunning: agent.status === 'busy', awaitingDecision: agent.pendingApprovals > 0 };
}
