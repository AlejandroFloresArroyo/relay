/** Additive agent tools capability; timestamps are Unix milliseconds. */
export interface AgentToolset {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  tools: string[];
}
export interface AgentTools {
  platform: 'api_server';
  toolsets: AgentToolset[];
  observedAt: number;
  /** Changes can take effect on the next Turn, including an existing Conversation; no live-update guarantee. */
  appliesTo: 'next_turn';
}
export interface AgentSkill {
  name: string;
  description: string;
  category: string | null;
  /** Installed metadata is not proof that runtime requirements are satisfied. */
  availability: 'disabled' | 'unknown';
}
export interface AgentSkills {
  skills: AgentSkill[];
  observedAt: number;
  scope: 'profile_installed';
  limited: boolean;
}

export type AgentToolsErrorCode =
  | 'agent_tools_unavailable'
  | 'tool_not_configured'
  | 'tool_global_restriction'
  | 'tool_configuration_unsupported'
  | 'tool_configuration_changed'
  | 'toolset_not_found';
export const AGENT_TOOLS_ERROR_STATUS: Record<AgentToolsErrorCode, number> = {
  agent_tools_unavailable: 503,
  tool_not_configured: 409,
  tool_global_restriction: 409,
  tool_configuration_unsupported: 409,
  tool_configuration_changed: 409,
  toolset_not_found: 404,
};
export const AGENT_TOOLS_ERROR_MESSAGES: Record<AgentToolsErrorCode, string> = {
  agent_tools_unavailable: 'No se pudieron leer las herramientas o skills del Agente. Reintenta.',
  tool_not_configured: 'Configura esta herramienta en el Servidor antes de encenderla.',
  tool_global_restriction: 'Hay restricciones globales en el Servidor. Revísalas allí antes de encender herramientas desde Relay.',
  tool_configuration_unsupported: 'La lista del canal contiene conjuntos personalizados. Revísala en el Servidor.',
  tool_configuration_changed: 'La configuración cambió. Actualiza antes de repetir el cambio.',
  toolset_not_found: 'La herramienta ya no está disponible.',
};
