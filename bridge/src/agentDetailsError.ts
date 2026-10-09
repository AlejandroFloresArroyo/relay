import { AGENT_DETAILS_ERROR_STATUS, type AgentDetailsErrorCode } from '../../protocol/agentDetails.ts';
const messages: Record<AgentDetailsErrorCode, string> = {
  agent_details_unavailable: 'No se pudieron leer los datos del Agente. Reintenta.',
  agent_security_read_only: 'La configuración de este Agente está en solo lectura.',
  agent_security_conflict: 'La configuración cambió. Revisa la ficha antes de intentarlo de nuevo.',
  agent_security_invalid: 'El cambio solicitado no es válido.',
  agent_security_uncertain: 'El cambio quedó sin confirmar. Revisa la ficha antes de continuar.',
};
export class AgentDetailsError extends Error {
  readonly code: AgentDetailsErrorCode;
  readonly status: number;
  constructor(code: AgentDetailsErrorCode) { super(messages[code]); this.code = code; this.status = AGENT_DETAILS_ERROR_STATUS[code]; }
}
