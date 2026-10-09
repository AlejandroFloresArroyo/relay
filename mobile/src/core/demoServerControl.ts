import type { ServerControlStatus } from '../../../protocol/serverControl.ts';
import { RelayError, type RelayClient } from './client.ts';
import { demoConnectionError } from './demoConnection.ts';

export const DEMO_SERVER_CONTROL_SCENARIOS = [
  { id: 'ready', name: 'Disponible' }, { id: 'paused', name: 'En pausa' },
  { id: 'pending', name: 'Pendiente' }, { id: 'failed', name: 'Cambio fallido' },
  { id: 'offline', name: 'Sin respuesta' },
] as const;
type Scenario = (typeof DEMO_SERVER_CONTROL_SCENARIOS)[number]['id'];
const scenarios = new Map<string, Scenario>();
const active = new Map<string, Set<string>>();
export const demoServerControlScenario = (serverId: string): Scenario => scenarios.get(serverId) ?? 'ready';
export function setDemoServerControlScenario(serverId: string, scenario: Scenario) { scenarios.set(serverId, scenario); }
export function resetDemoServerControl() { scenarios.clear(); active.clear(); }
type Base = Pick<RelayClient, 'startRun' | 'steerRun' | 'reconnectRun' | 'stopRun' | 'gateway' | 'gatewayAction'>;
export function createDemoServerControl(serverId: string, base: Base): Base & Pick<RelayClient, 'serverControl' | 'pauseServer' | 'resumeServer'> {
  const runs = active.get(serverId) ?? new Set<string>(); active.set(serverId, runs);
  function status(): ServerControlStatus {
    const failure = demoConnectionError(serverId); if (failure) throw failure;
    const scenario = demoServerControlScenario(serverId);
    if (scenario === 'offline') throw new RelayError('unreachable', 'Sin respuesta del Servidor.');
    return { paused: scenario !== 'ready', hermesPaused: scenario === 'paused', phase: scenario === 'pending' ? 'pending' : scenario === 'failed' ? 'failed' : 'ready', action: scenario === 'pending' || scenario === 'failed' ? 'pause' : null };
  }
  const admission = () => { if (status().paused) throw new RelayError('server_paused', 'Pausa general: reanuda el Servidor antes de enviar mensajes.', 409); };
  async function change(paused: boolean) {
    const current = status();
    if (current.phase === 'failed' || current.phase === 'pending') throw new RelayError('http', 'No se confirmó el cambio del Servidor.', 502);
    scenarios.set(serverId, 'pending');
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (paused) await Promise.all([...runs].map((id) => base.stopRun(id)));
    scenarios.set(serverId, paused ? 'paused' : 'ready'); return status();
  }
  return {
    serverControl: async () => status(), pauseServer: () => change(true), resumeServer: () => change(false),
    async startRun(agent, request) { admission(); const run = await base.startRun(agent, request); runs.add(run.runId); if (status().paused) await base.stopRun(run.runId); return run; },
    async steerRun(id, request) { admission(); return base.steerRun(id, request); },
    async reconnectRun(id) { admission(); return base.reconnectRun(id); },
    stopRun: base.stopRun,
    async gateway() { status(); return base.gateway(); },
    async gatewayAction(action) {
      if (status().phase === 'failed') throw new RelayError('http', 'No se confirmó el cambio del gateway.', 502);
      await new Promise((resolve) => setTimeout(resolve, 600)); return base.gatewayAction(action);
    },
  };
}
