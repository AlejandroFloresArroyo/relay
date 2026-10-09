import { NOTIFICATIONS_HEADER, NOTIFICATION_KINDS, type NotificationPreferences, type NotificationStatus, type NotificationNotice, type NotificationDecisionInput, type NotificationRegistrationInput } from '../../../protocol/notifications.ts';
import { RelayError, type RelayErrorCode } from './client.ts';
import { validateServerAddress } from './pairing.ts';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && keys.length === Object.keys(value).length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown, max = 1000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function validNotificationPreferences(value: unknown): value is NotificationPreferences {
  return exact(value, ['enabled', 'types', 'preview']) && typeof value.enabled === 'boolean' && value.preview === 'generic'
    && exact(value.types, [...NOTIFICATION_KINDS]) && Object.values(value.types).every(item => typeof item === 'boolean');
}
export function validNotificationStatus(value: unknown): value is NotificationStatus {
  return exact(value, ['schema', 'configured', 'transport', 'availableKinds', 'preferences', 'revision', 'registration', 'delivery', 'serverNow'])
    && value.schema === 1 && typeof value.configured === 'boolean' && value.transport === 'ntfy-unifiedpush'
    && Array.isArray(value.availableKinds) && value.availableKinds.every(kind => NOTIFICATION_KINDS.includes(kind))
    && new Set(value.availableKinds).size === value.availableKinds.length && validNotificationPreferences(value.preferences)
    && time(value.revision) && time(value.serverNow) && typeof value.delivery === 'string' && ['disabled', 'unknown', 'accepted', 'failed'].includes(value.delivery)
    && (value.registration === null || (exact(value.registration, ['id', 'expiresAt']) && text(value.registration.id) && time(value.registration.expiresAt)));
}
export function validNotificationNotice(value: unknown, noticeId: string): value is NotificationNotice {
  if (!exact(value, ['schema', 'noticeId', 'registrationId', 'kind', 'target', 'approval', 'expiresAt', 'serverNow', 'state'])
    || value.schema !== 1 || value.noticeId !== noticeId || !text(value.registrationId) || value.kind !== 'approval'
    || !exact(value.target, ['agentId', 'runId', 'approvalId']) || !Object.values(value.target).every(item => text(item))
    || !object(value.approval) || !time(value.serverNow) || !(value.expiresAt === null || time(value.expiresAt))
    || !(typeof value.state === 'string' && ['pending', 'approved', 'rejected', 'expired', 'uncertain', 'unknown'].includes(value.state))) return false;
  const a = value.approval;
  return a.id === value.target.approvalId && a.agentId === value.target.agentId && a.runId === value.target.runId
    && text(a.agentName, 255) && typeof a.command === 'string' && a.command.length <= 64000
    && time(a.createdAt) && a.expiresAt === value.expiresAt && Array.isArray(a.choices)
    && a.choices.every(choice => ['once', 'session', 'deny'].includes(choice))
    && (a.risk === null || (object(a.risk) && typeof a.risk.level === 'number' && a.risk.level >= 1 && a.risk.level <= 5 && text(a.risk.label)));
}
export function noticeCanDecide(notice: NotificationNotice, receivedAt: number, now: number): boolean {
  return notice.state === 'pending' && now >= receivedAt && now - receivedAt < 60000
    && (notice.expiresAt === null || notice.serverNow + now - receivedAt < notice.expiresAt);
}
export function notificationError(error: unknown): string {
  if (error instanceof RelayError) {
    if (['device_revoked', 'key_unknown', 'unauthorized', 'pairing_required'].includes(error.code)) return 'Este teléfono no está autorizado. Empareja de nuevo el Servidor.';
    if (error.code === 'protocol_upgrade_required' || error.status === 404 || error.status === 426) return 'Actualiza el Puente o revisa la bandeja: este aviso ya no está disponible.';
    if (error.code === 'decision_uncertain') return 'DECISIÓN SIN CONFIRMAR. Relay no la enviará otra vez.';
    if (error.status === 409) return 'El aviso cambió o expiró. Consulta de nuevo antes de decidir.';
    if (error.code === 'cleartext_blocked') return 'Android bloquea esta dirección. Usa un nombre Tailnet.';
  }
  return 'La operación quedó sin confirmar. Revisa la conexión y el estado del Servidor.';
}
export interface NotificationClientOptions { baseUrl: string; key: string; deviceId?: string; fetch: typeof fetch; timeoutMs?: number }
export function createNotificationClient(options: NotificationClientOptions) {
  const fetcher = options.fetch;
  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!options.deviceId || !options.key) throw new RelayError('pairing_required', 'Empareja este teléfono.');
    let base: string;
    try { base = validateServerAddress(options.baseUrl); } catch { throw new RelayError('bad_request', 'Usa un nombre Tailnet válido.'); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
    try {
      const response = await fetcher(base + path, { method, redirect: 'error', headers: { Accept: 'application/json', Authorization: `Bearer ${options.key}`,
        'X-Relay-Protocol': '2', [NOTIFICATIONS_HEADER]: '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      const value: unknown = await response.json();
      if (!response.ok) {
        const code = object(value) && object(value.error) ? value.error.code : null;
        const known = ['device_revoked', 'key_unknown', 'unauthorized', 'pairing_required', 'protocol_upgrade_required', 'decision_uncertain', 'unavailable', 'rate_limited'] as const;
        throw new RelayError((known.find(item => item === code) ?? 'http') as RelayErrorCode, 'La solicitud de Avisos no se completó.', response.status);
      }
      return value;
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError(controller.signal.aborted ? 'timeout' : 'unreachable', 'Sin respuesta del Servidor.');
    } finally { clearTimeout(timer); }
  }
  async function statusRequest(method: string, path: string, body?: unknown): Promise<NotificationStatus> {
    const value = await request(method, path, body);
    if (!validNotificationStatus(value)) throw new RelayError('unavailable', 'El contrato de Avisos no es válido.');
    return value;
  }
  return {
    status: () => statusRequest('GET', '/v1/notifications'),
    register: (body: NotificationRegistrationInput) => statusRequest('PUT', '/v1/notifications/registration', body),
    unregister: (revision: number) => statusRequest('DELETE', '/v1/notifications/registration', { schema: 1, revision }),
    async notice(noticeId: string): Promise<NotificationNotice> {
      if (!text(noticeId) || /[\x00-\x1f/\\]/.test(noticeId)) throw new RelayError('bad_request', 'Aviso inválido.');
      const value = await request('GET', `/v1/notifications/notices/${encodeURIComponent(noticeId)}`);
      if (!validNotificationNotice(value, noticeId)) throw new RelayError('unavailable', 'El aviso recibido no es válido.');
      return value;
    },
    async decide(noticeId: string, body: NotificationDecisionInput) {
      if (!text(noticeId) || /[\x00-\x1f/\\]/.test(noticeId) || !exact(body, ['schema','registrationId','target','choice']) || body.schema !== 1 || !text(body.registrationId)
        || !exact(body.target, ['agentId','runId','approvalId']) || !Object.values(body.target).every(item=>text(item)) || (body.choice !== 'once' && body.choice !== 'deny'))
        throw new RelayError('bad_request', 'Decisión inválida.');
      const value = await request('POST', `/v1/notifications/notices/${encodeURIComponent(noticeId)}/decision`, body);
      if (!exact(value, ['ok', 'outcome']) || value.ok !== true || value.outcome !== (body.choice === 'once' ? 'approved' : 'rejected'))
        throw new RelayError('decision_uncertain', 'La Decisión quedó sin confirmar.');
      return value as { ok: true; outcome: 'approved' | 'rejected' };
    },
  };
}

export const notificationAuthorizationFailed = (error: unknown) => error instanceof RelayError && ['device_revoked','key_unknown','unauthorized','pairing_required'].includes(error.code);


export function notificationOpenTarget(value: unknown): {kind:'approval';serverId:string;noticeId:string} | {kind:'generic';serverId:string;pathname:'/board'} | null {
  if (!exact(value,['serverId','noticeId','kind']) || !text(value.serverId,255) || !text(value.noticeId) || !/^[A-Za-z0-9-]+$/.test(value.noticeId)
    || !NOTIFICATION_KINDS.some(kind=>kind===value.kind)) return null;
  return value.kind === 'approval' ? {kind:'approval',serverId:value.serverId,noticeId:value.noticeId}
    : {kind:'generic',serverId:value.serverId,pathname:'/board'};
}
