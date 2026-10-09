import { checkBoardWebSignal } from './boardWebClient.ts';
import type { DownloadedBoardWeb, BoardWebClient } from './boardWebClient.ts';
import { demoBoardPage } from './demoBoard.ts';
const manifest = {"schemaVersion":1,"entry":"index.html","files":[{"name":"counter.js","mime":"application/javascript","bytes":302,"sha256":"e2342b67bc4c06d6e90aa478b39eb8ee1d21f744518d1dda5dff1cdf0269f8ef"},{"name":"index.html","mime":"text/html","bytes":599,"sha256":"dc0da945b82c5424e07c82bdf287d5b39af35bcb8bcf9358d01de3dac815394d"}]} as const;
export const DEMO_BOARD_WEB_REVISION = '353d3fa85c963cdb2a82f1344408967d7a8cd93a314d63a3ce3d59d82a2f9215';
const resources = [{"name":"counter.js","text":"document.getElementById('filter').addEventListener('click',function(){document.querySelectorAll('tr:not(#staging)').forEach(function(row){row.hidden=!row.hidden;});const count=document.getElementById('count');count.textContent=String(Number(count.textContent.split(' ')[0])+1)+' revisiones locales';});"},{"name":"index.html","text":"<!doctype html><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>body{margin:12px;font:14px Georgia;color:#222}h1{font-size:18px;color:#1c4f8c}table{width:100%}td:last-child{text-align:right}button{margin-top:12px;padding:8px}#staging{color:#b3261e}</style><h1>Certificados TLS</h1><table><tr><td>api.nodo.mx</td><td>21 días</td></tr><tr><td>panel.nodo.mx</td><td>58 días</td></tr><tr id=\"staging\"><td>staging.nodo.mx</td><td>4 días</td></tr></table><button id=\"filter\">Mostrar solo urgentes</button><p id=\"count\">0 revisiones locales</p><script src=\"counter.js\"></script>"}];
export function demoBoardWebBundle(): DownloadedBoardWeb {
  return { revision: DEMO_BOARD_WEB_REVISION, manifest: { ...manifest, files: manifest.files.map(file => ({ ...file })) }, assets: resources.map(asset => ({ name: asset.name, bytes: new TextEncoder().encode(asset.text) })) };
}
export function createDemoBoardWeb(): BoardWebClient {
  return { async page(signal) { checkBoardWebSignal(signal); return { page: demoBoardPage(Date.now(), 'dev', 'web'), supported: true }; }, async bundle(_agent, _content, signal) { checkBoardWebSignal(signal); return demoBoardWebBundle(); } };
}
export type BoardWebDemoPhase = 'loading' | 'error' | 'offline' | 'unsupported' | 'unverified' | 'retired';
export function demoBoardWebPreview(scenario: string): { phase: BoardWebDemoPhase; message?: string } | null {
  const values: Record<string, { phase: BoardWebDemoPhase; message?: string }> = {
    'web-loading': { phase: 'loading' },
    'web-error': { phase: 'error', message: 'No se pudo verificar o copiar el contenido web. Reintenta.' },
    'web-offline': { phase: 'offline', message: 'Contenido web no disponible sin conexión. Solo se conserva la información de la Tarjeta.' },
    'web-unsupported': { phase: 'unsupported', message: 'Esta versión de Relay no incluye contenido web aislado para Android.' },
    'web-unverified': { phase: 'unverified', message: 'Este proveedor WebView todavía no tiene aislamiento verificado.' },
    'web-retired': { phase: 'retired', message: 'Contenido web retirado mientras Relay no está visible.' },
  };
  return values[scenario] ?? null;
}
