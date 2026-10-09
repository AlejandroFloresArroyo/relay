export const AGENT_AVATAR_KEYS = ['hermes', 'caduceus', 'raven', 'torch', 'astrolabe', 'sandal', 'lighthouse', 'owl'] as const;
export type AgentAvatarKey = typeof AGENT_AVATAR_KEYS[number];

// Hermes' own profile wears Hermes; the demo's two Agents get distinct pictures side by side.
const PINNED: Record<string, AgentAvatarKey> = { default: 'hermes', dev: 'caduceus', research: 'owl' };

/** A profile ID selects a bundled image without mutable state or platform APIs. */
export function agentAvatarKey(agentId: string): AgentAvatarKey {
  if (Object.hasOwn(PINNED, agentId)) return PINNED[agentId];
  let hash = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) {
    hash = Math.imul(hash ^ agentId.charCodeAt(i), 0x01000193) >>> 0;
  }
  // The pool's order is fixed so assignments remain stable between app launches.
  return AGENT_AVATAR_KEYS[hash % AGENT_AVATAR_KEYS.length];
}
