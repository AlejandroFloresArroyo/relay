import { DEMO_BOARD_WEB_REVISION } from './demoBoardWeb.ts';
import type { BoardCard, BoardPage } from '../../../protocol/board.ts';
export const BOARD_DEMO_SCENARIOS = ['normal', 'states', 'empty', 'loading', 'error', 'offline', 'web', 'web-loading', 'web-error', 'web-offline', 'web-unsupported', 'web-unverified', 'web-retired'] as const;
export type BoardDemoScenario = typeof BOARD_DEMO_SCENARIOS[number];
export function demoBoardPage(now: number, agentId = 'dev', scenario: BoardDemoScenario = 'normal'): BoardPage {
  const base = { agentId, agentName: agentId === 'dev' ? 'dev' : 'Agente A', updatedAt: now - 60000, maxAgeMs: 3600000, state: 'ready' as const, status: 'ready' as const };
  const cards: BoardCard[] = [
    { ...base, id: 'backups', title: 'Estado de los backups', content: { type: 'states', items: [{ label: 'postgres · diario', state: 'ok', detail: 'HOY 03:00' }, { label: 'volúmenes docker', state: 'ok', detail: 'HOY 03:20' }, { label: 'fotos → nas', state: 'error', detail: 'AYER 03:40' }] } },
    { ...base, id: 'disk', title: 'Disco /srv', content: { type: 'number', value: '82', unit: '%', detail: 'USO · ▲\u00a03\u00a0PTS · 7\u00a0D' } },
    { ...base, id: 'clean', title: 'Limpiar caché', content: { type: 'action', label: 'Enviar a dev', message: 'Limpia la caché de build de nodo-app y dime cuánto espacio recuperaste.' } },
    { ...base, id: 'memory', title: 'Memoria', content: { type: 'meter', value: 6.1, max: 16, unit: 'GB' } },
    { ...base, id: 'note', title: 'Nota', content: { type: 'text', text: 'El modelo local va dos veces más lento desde el driver nuevo.' } },
    { ...base, id: 'requests', title: 'Peticiones a la API · 24 h', content: { type: 'series', unit: 'peticiones / min', points: [82, 96, 118, 160, 220, 260, 245, 294, 350, 412, 376, 305, 278, 244, 200, 186].map((value, i) => ({ at: now - (16 - i) * 3600000, value })) } },
    { ...base, id: 'deploy', title: 'Último deploy', content: { type: 'log', lines: ['09:32 build completado', '09:33 pruebas correctas', '09:34 despliegue terminado'] } },
  ];
  if (scenario.startsWith('web')) cards.push({ ...base, id: 'tls-web', title: 'Certificados TLS', content: { type: 'web', bundleRef: 'demo-tls', revision: DEMO_BOARD_WEB_REVISION } });
  if (scenario === 'states') { cards[0].status = 'error'; cards[0].state = 'error'; cards[1].status = 'updating'; cards[1].state = 'updating'; cards[3].status = 'stale'; cards[3].updatedAt = now - 259200000; }
  return { cards: scenario === 'empty' ? [] : cards, observedAt: now, failedAgents: [] };
}
