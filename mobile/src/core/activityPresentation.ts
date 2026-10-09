import type { ActivityAction, ActivityItem, ActivityResult } from '../../../protocol/activity.ts';
export const activityActionLabel: Record<ActivityAction, string> = {
  'device.pair': 'Emparejamiento de dispositivo', 'device.revoke': 'Revocación de dispositivo', 'auth.rate_limit': 'Límite de intentos',
  'agent.mode.queue': 'Solicitud de modo de aprobación', 'agent.mode.cancel': 'Cancelación de modo solicitado', 'agent.mode.apply': 'Cambio de modo de aprobación',
  'agent.rule.add': 'Alta de regla de bloqueo', 'agent.rule.remove': 'Retiro de regla de bloqueo', 'agent.tools.enable': 'Encendido de herramientas', 'agent.tools.disable': 'Apagado de herramientas',
  'agent.memory.edit': 'Edición de memoria', 'agent.memory.delete': 'Eliminación de memoria', 'agent.soul.edit': 'Edición de personalidad',
  'personality.preset.create': 'Creación de preset de personalidad', 'personality.preset.update': 'Edición de preset de personalidad', 'personality.preset.delete': 'Eliminación de preset de personalidad',
  'personality.soul.apply': 'Aplicación de personalidad a SOUL.md', 'notification.registration': 'Inscripción de Avisos',
  'conversation.personality.change': 'Elección de personalidad de Conversación', 'conversation.create': 'Creación de Conversación', 'conversation.rename': 'Cambio de título de Conversación', 'conversation.delete': 'Eliminación de Conversación', 'conversation.model.change': 'Elección de modelo',
  'run.steer': 'Instrucción al Turno', 'run.stop': 'Detención de Turno',
  'kanban.create': 'Creación de trabajo', 'kanban.update': 'Cambio de trabajo', 'kanban.comment': 'Comentario en trabajo', 'kanban.notify': 'Aviso al Agente',
  'job.create': 'Creación de tarea', 'job.edit': 'Edición de tarea', 'job.delete': 'Eliminación de tarea', 'job.pause': 'Pausa de tarea', 'job.resume': 'Reanudación de tarea', 'job.run': 'Ejecución de tarea',
  'server.pause': 'Pausa general', 'server.resume': 'Reanudación del Servidor', 'gateway.start': 'Inicio del gateway', 'gateway.stop': 'Detención del gateway', 'gateway.restart': 'Reinicio del gateway',
};
export const activityResultLabel: Record<ActivityResult, string> = { requested: 'SOLICITADO', succeeded: 'CONFIRMADO', failed: 'NO CONFIRMADO', uncertain: 'INCIERTO', accepted: 'ACEPTADO', rejected: 'RECHAZADO', recorded: 'REGISTRADO' };
export function activityTone(result: ActivityResult): 'green' | 'red' | 'orange' | 'off' {
  return result === 'succeeded' ? 'green' : result === 'failed' || result === 'rejected' ? 'red' : result === 'requested' || result === 'uncertain' || result === 'accepted' ? 'orange' : 'off';
}
export function activityActorLabel(item: ActivityItem, deviceId?: string): string {
  return item.actor.kind === 'server' ? 'Puente' : deviceId && item.actor.id === deviceId ? 'Este dispositivo' : 'Otro dispositivo';
}
export const activityDate = (at: number): string => new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
export const activityDay = (at: number): string => new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(at).toUpperCase();
export const activityTime = (at: number): string => new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);

/** A gap in the loaded subset is not proof that the complete journal has no events. */
export function activityGapLabel(previous: number, next: number): string | null {
  const gap = Math.floor(previous / 86400000) - Math.floor(next / 86400000) - 1;
  return gap > 0 ? gap + (gap === 1 ? ' DÍA SIN REGISTROS VISIBLES' : ' DÍAS SIN REGISTROS VISIBLES') : null;
}
