// Shared personality contract. Types and side-effect-free constants only.
import type { AgentSoul } from './agentMemory.ts';

export const PERSONALITY_PRESET_MAX_COUNT = 64;
export const PERSONALITY_PRESET_NAME_MAX_CHARACTERS = 100;
export const PERSONALITY_SOUL_MAX_BYTES = 1024 * 1024;
export const PERSONALITY_OVERLAY_MAX_BYTES = 64 * 1024;
export const PERSONALITY_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
export const PERSONALITY_REQUEST_MAX_BYTES = 6 * PERSONALITY_SOUL_MAX_BYTES + 4096;
export const PERSONALITY_RESPONSE_MAX_BYTES = 12 * PERSONALITY_SOUL_MAX_BYTES + 4096;
export const PERSONALITY_CONTEXT_NOTICE = 'Hermes puede aplicar los cambios al reconstruir el contexto, incluso en esta Conversación.';
export const PERSONALITY_NONE_NOTICE = 'Sin capa extra de Relay. Se hereda la configuración del Servidor.';
export type PersonalityPresetKind = 'soul' | 'overlay';
export interface PersonalityPresetRef { id: string; revision: string }
export interface PersonalityPresetSummary extends PersonalityPresetRef {
  name: string; kind: PersonalityPresetKind; bytes: number; createdAt: number; updatedAt: number;
}
export interface PersonalityPresetVersion extends PersonalityPresetSummary { content: string }
// GET /v1/personality-presets. Contents are retrieved separately, never in the list.
export interface PersonalityPresetCatalog {
  revision: string; capturedAt: number; presets: PersonalityPresetSummary[];
}
// POST /v1/personality-presets -> 201 PersonalityPresetVersion.
export interface CreatePersonalityPreset {
  requestId: string; catalogRevision: string; name: string; kind: PersonalityPresetKind; content: string;
}
// GET /v1/personality-presets/:id -> current PersonalityPresetVersion.
// GET /v1/personality-presets/:id/versions/:revision -> immutable PersonalityPresetVersion.
// PATCH /v1/personality-presets/:id -> new immutable PersonalityPresetVersion.
export interface UpdatePersonalityPreset { requestId: string; revision: string; name: string; content: string }
// DELETE /v1/personality-presets/:id, JSON body -> DeletedPersonalityPreset.
export interface DeletePersonalityPreset { requestId: string; revision: string }
export interface DeletedPersonalityPreset extends PersonalityPresetRef { deleted: true }
// GET /v1/agents/:agentId/soul/preset-preview?presetId=UUID&presetRevision=HASH.
// The exact full replacement and existing SOUL are shown before fresh strong Android huella.
export interface SoulPresetPreview {
  agentId: string; preset: PersonalityPresetVersion; soul: AgentSoul;
}
// PUT /v1/agents/:agentId/soul/preset. Same requestId/body replays its durable outcome;
// an uncertain outcome is never automatically retried as another write.
export interface ApplySoulPreset {
  requestId: string; presetId: string; presetRevision: string; soulRevision: string;
}
export interface AppliedSoulPreset {
  requestId: string; presetId: string; presetRevision: string; soul: AgentSoul;
}
// GET/PUT /v1/agents/:agentId/conversations/:conversationId/personality.
// Selection freezes a specific immutable version in the durable Relay conversation receipt.
export interface ConversationPersonality {
  agentId: string; conversationId: string; revision: string;
  preset: PersonalityPresetVersion | null; updatedAt: number | null;
}
export interface SelectConversationPersonality {
  requestId: string; revision: string; preset: PersonalityPresetRef | null;
}
export const PERSONALITY_ERROR_STATUS = {
  personality_invalid: 400,
  personality_not_found: 404,
  personality_conflict: 409,
  personality_limit: 409,
  personality_read_only: 403,
  personality_uncertain: 503,
  personality_unavailable: 503,
} as const;
export type PersonalityErrorCode = keyof typeof PERSONALITY_ERROR_STATUS;
export const PERSONALITY_MESSAGES: Record<PersonalityErrorCode, string> = {
  personality_invalid: 'El preset o la solicitud no es válido.',
  personality_not_found: 'El preset ya no está disponible.',
  personality_conflict: 'El preset o la selección cambió. Recarga antes de confirmar.',
  personality_limit: 'El catálogo o el preset supera su límite. No se borró ninguna versión.',
  personality_read_only: 'Esta Conversación nació fuera de Relay; su personalidad es de solo lectura.',
  personality_uncertain: 'El cambio quedó sin confirmar. Recarga; no se enviará otra vez automáticamente.',
  personality_unavailable: 'Los presets de personalidad no están disponibles en este Servidor.',
};
