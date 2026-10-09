import type { AgentSkills, AgentTools } from '../../../protocol/agentTools.ts';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const stamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum;
export function isAgentTools(value: unknown): value is AgentTools {
  if (!record(value) || value.platform !== 'api_server' || value.appliesTo !== 'next_turn' || !stamp(value.observedAt) || !Array.isArray(value.toolsets) || value.toolsets.length > 512) return false;
  const seen = new Set<string>();
  return value.toolsets.every((tool) => {
    if (!record(tool) || !text(tool.name, 200) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(tool.name) || seen.has(tool.name)
      || !text(tool.label, 200) || !text(tool.description, 4000) || typeof tool.enabled !== 'boolean' || typeof tool.configured !== 'boolean'
      || !Array.isArray(tool.tools) || tool.tools.length > 2048 || !tool.tools.every((name) => text(name, 200))) return false;
    seen.add(tool.name); return true;
  });
}
export function isAgentSkills(value: unknown): value is AgentSkills {
  return record(value) && value.scope === 'profile_installed' && stamp(value.observedAt) && typeof value.limited === 'boolean'
    && Array.isArray(value.skills) && value.skills.length <= 256 && value.skills.every((skill) => record(skill)
      && text(skill.name, 200) && text(skill.description, 1000) && (skill.category === null || text(skill.category, 255))
      && (skill.availability === 'disabled' || skill.availability === 'unknown'));
}
