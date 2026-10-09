import type { ModelOptions } from '../../../protocol/protocol.ts';
import { RelayError, type RelayClient } from './client.ts';
import { demoConnectionError } from './demoConnection.ts';
import { updateDemoConversationModel } from './demoConversations.ts';

export const DEMO_MODEL_SCENARIOS = [
  { id: 'loaded', name: 'Modelos disponibles' }, { id: 'loading', name: 'Cargando modelos…' },
  { id: 'error', name: 'Error de catálogo' }, { id: 'empty', name: 'Sin modelos disponibles' },
  { id: 'saving', name: 'Cambiando modelo…' }, { id: 'save-error', name: 'Error al cambiar modelo' },
] as const;
export type DemoModelScenario = (typeof DEMO_MODEL_SCENARIOS)[number]['id'];
const scenarios = new Map<string, DemoModelScenario>();
export function demoModelScenario(serverId: string): DemoModelScenario { return scenarios.get(serverId) ?? 'loaded'; }
export function setDemoModelScenario(serverId: string, scenario: DemoModelScenario) { scenarios.set(serverId, scenario); }
export function resetDemoModels() { scenarios.clear(); }

export function demoModelOptions(agentId: string): ModelOptions {
  return {
    defaultModel: agentId === 'research' ? { provider: 'anthropic', model: 'claude-sonnet-4.5' } : { provider: 'openrouter', model: 'qwen3-coder-480b' },
    models: [
      { provider: 'openrouter', model: 'qwen3-coder-480b', label: 'qwen3-coder-480b' },
      { provider: 'openrouter', model: 'claude-sonnet-4.5', label: 'claude-sonnet-4.5' },
      { provider: 'openrouter', model: 'deepseek-v3.1', label: 'deepseek-v3.1' },
      { provider: 'ollama', model: 'llama-3.3-70b', label: 'llama-3.3-70b' },
      ...(agentId === 'research' ? [{ provider: 'anthropic', model: 'claude-sonnet-4.5', label: 'claude-sonnet-4.5' }] : []),
    ],
  };
}

export function createDemoModels(serverId: string, _now: () => number): Pick<RelayClient, 'models' | 'setConversationModel'> {
  const guard = () => {
    const error = demoConnectionError(serverId);
    if (error) throw error;
  };
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 1500));
  return {
    async models(agentId) {
      guard();
      const scenario = demoModelScenario(serverId);
      if (scenario === 'loading') await delay();
      if (scenario === 'error') throw new RelayError('upstream_failure', 'No se pudieron cargar los modelos de demostración. Reintenta.', 502);
      const options = demoModelOptions(agentId);
      return scenario === 'empty' ? { ...options, models: [] } : options;
    },
    async setConversationModel(agentId, conversationId, { model }) {
      guard();
      const scenario = demoModelScenario(serverId);
      if (scenario === 'saving') await delay();
      if (scenario === 'save-error') throw new RelayError('upstream_failure', 'No se pudo cambiar el modelo de demostración. Reintenta.', 502);
      if (model && !demoModelOptions(agentId).models.some((option) => option.provider === model.provider && option.model === model.model)) {
        throw new RelayError('model_not_configured', 'Este modelo no está disponible.', 400);
      }
      return updateDemoConversationModel(serverId, agentId, conversationId, model);
    },
  };
}
