// Servidor elegido (ADR 0007): what Herram., Tablero, Trabajo and Tareas show.

export const SELECTED_SERVER_KEY = 'relay.selectedServer.v1';

type Paired = readonly { id: string; isDefault: boolean }[];

/** First time → the default; then the remembered one. Reachability is not an input, so one that stops answering stays; a removed one falls back to the default, or none. */
export function selectedServer(servers: Paired, stored: string | null): string | null {
  return servers.find(s => s.id === stored)?.id ?? servers.find(s => s.isDefault)?.id ?? servers[0]?.id ?? null;
}

/** An entry (the selector, an external entry, a destination) chooses a paired Servidor; anything else keeps the current one. */
export function chooseServer(servers: Paired, current: string | null, requested: string): string | null {
  return servers.some(s => s.id === requested) ? requested : current;
}
