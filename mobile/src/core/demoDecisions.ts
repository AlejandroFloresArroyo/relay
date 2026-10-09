import { RelayError } from './client.ts';
export const DEMO_DECISION_SCENARIOS = [
  ['mixed','Pendientes + historial'],['empty','Sin pendientes'],['history','Solo historial'],['loading','Cargando'],['error','Error'],['offline','Sin respuesta'],['uncertain','Sin confirmar'],['limited','Historial limitado'],
] as const;
export type DemoDecisionScenario = typeof DEMO_DECISION_SCENARIOS[number][0];
let scenario: DemoDecisionScenario = 'mixed';
export const demoDecisionScenario = () => scenario;
export function setDemoDecisionScenario(next: DemoDecisionScenario) { scenario = next; }
export async function demoDecisionDelay() {
  if (scenario === 'loading') await new Promise<void>(resolve => setTimeout(resolve,60000));
  if (scenario === 'error') throw new RelayError('decision_history_unavailable','No se pudo cargar el historial. Reintenta.');
  if (scenario === 'offline') throw new RelayError('unreachable','Servidor sin respuesta.');
}
