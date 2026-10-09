import type { AgentSkills, AgentTools } from '../../protocol/agentTools.ts';
export interface ToolChangeContext {
  backupDirectory: string;
  guard(): void;
  beforeWrite(): Promise<void>;
}
export interface HermesAgentTools {
  tools(profile: string): Promise<AgentTools>;
  setToolset(profile: string, name: string, enabled: boolean, context: ToolChangeContext): Promise<AgentTools>;
  skills(profile: string): Promise<AgentSkills>;
}
