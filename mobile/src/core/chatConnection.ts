import { classifyConnectionError } from './connectionStatus.ts';

export interface ChatTranscriptContext {
  client: object;
  agentId: string;
  pendingCount: number;
  retry: number;
  reachable: boolean | null;
}

export interface ChatConnectionState {
  previous: ChatTranscriptContext | null;
  error: unknown;
}

/** Known failures resume only after an explicit retry or a replacement connection. */
export function planChatTranscript(state: ChatConnectionState, context: ChatTranscriptContext, running: boolean): {
  state: ChatConnectionState;
  load: boolean;
} {
  const old = state.previous;
  const changedConnection = !old || old.client !== context.client;
  const explicitRetry = old !== null && old.retry !== context.retry;
  const suspended = state.error != null && !classifyConnectionError(state.error).automaticRetry;
  const ordinaryChange = old !== null && (old.agentId !== context.agentId || old.pendingCount !== context.pendingCount);
  const recovered = old !== null && old.reachable !== true && context.reachable === true && state.error != null;
  const load = !running && (changedConnection || explicitRetry || (!suspended && (ordinaryChange || recovered)));
  return { state: { ...state, previous: context }, load };
}

export function recordChatTransportError(state: ChatConnectionState, error: unknown): ChatConnectionState {
  return { ...state, error };
}

export function clearChatTransportError(state: ChatConnectionState): ChatConnectionState {
  return { ...state, error: null };
}
