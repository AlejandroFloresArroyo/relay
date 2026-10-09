import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSkill, AgentTools, AgentToolset } from '../../protocol/agentTools.ts';
import type { HermesAgentTools, ToolChangeContext } from './agentToolsPort.ts';
import type { Exec } from './exec.ts';
import { HermesError } from './hermes.ts';
import { openPrivateFile, syncStateDirectory } from './changeLog.ts';

const unavailable = () => new HermesError('agent_tools_unavailable', 'No se pudieron leer las herramientas o skills del Agente. Reintenta.');
const conflict = () => new HermesError('tool_configuration_changed', 'La configuración cambió. Actualiza antes de repetir el cambio.');
const MAX_CONFIG = 1_048_576;
const helper = fileURLToPath(new URL('./agent_tools_metadata.py', import.meta.url));
const validName = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(name);

// Pin each ancestor with O_NOFOLLOW. No path from installed metadata is opened directly.
async function directory(candidate: string): Promise<FileHandle> {
  if (!path.isAbsolute(candidate) || candidate.split('/').includes('..')) throw unavailable();
  let handle = await fs.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of candidate.split('/').filter(Boolean)) {
      const next = await fs.open(`/proc/self/fd/${handle.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close(); handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function readAt(parent: FileHandle, name: string, maximum: number): Promise<Buffer> {
  const file = await fs.open(`/proc/self/fd/${parent.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw unavailable();
    const buffer = Buffer.alloc(maximum + 1); let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maximum) throw unavailable();
    return buffer.subarray(0, total);
  } finally { await file.close(); }
}
function text(bytes: Buffer) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }

export function createHermesAgentTools(options: {
  profileHome(profile: string): string;
  toolsets(profile: string): Promise<unknown>;
  exec: Exec;
  python: string;
  now?: () => number;
}): HermesAgentTools {
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<unknown>>();
  async function metadata(input: unknown): Promise<Record<string, unknown>> {
    try {
      const result = await options.exec(options.python, ['-I', '-B', helper], { input: JSON.stringify(input), timeoutMs: 5000 });
      if (result.code !== 0) throw unavailable();
      const value = JSON.parse(result.stdout);
      if (value?.error === 'global_restriction') throw new HermesError('tool_global_restriction', 'Hay restricciones globales en el Servidor. Revísalas allí antes de encender herramientas desde Relay.');
      if (value?.error === 'custom_toolsets') throw new HermesError('tool_configuration_unsupported', 'La lista del canal contiene conjuntos personalizados. Revísala en el Servidor.');
      if (!value || typeof value !== 'object' || value.error) throw unavailable();
      return value;
    } catch (error) { if (error instanceof HermesError) throw error; throw unavailable(); }
  }
  async function tools(profile: string): Promise<AgentTools> {
    try {
      const payload = await options.toolsets(profile) as { platform?: unknown; data?: unknown };
      if (payload?.platform !== 'api_server' || !Array.isArray(payload.data) || payload.data.length > 512) throw unavailable();
      const names = new Set<string>();
      const toolsets: AgentToolset[] = payload.data.map((entry) => {
        if (!entry || typeof entry.name !== 'string' || !validName(entry.name) || names.has(entry.name)
          || typeof entry.label !== 'string' || entry.label.length > 200 || typeof entry.description !== 'string' || entry.description.length > 4000
          || typeof entry.enabled !== 'boolean' || typeof entry.configured !== 'boolean' || !Array.isArray(entry.tools) || entry.tools.length > 2048
          || !entry.tools.every((tool: unknown) => typeof tool === 'string' && tool.length <= 200)) throw unavailable();
        names.add(entry.name);
        return { name: entry.name, label: entry.label, description: entry.description, enabled: entry.enabled, configured: entry.configured, tools: entry.tools };
      });
      return { platform: 'api_server', toolsets, observedAt: now(), appliesTo: 'next_turn' };
    } catch { throw unavailable(); }
  }
  async function change(profile: string, name: string, enabled: boolean, context: ToolChangeContext): Promise<AgentTools> {
    if (!validName(profile) || !validName(name) || typeof enabled !== 'boolean') throw new HermesError('bad_request', 'La herramienta no es válida.');
    context.guard();
    let parent: FileHandle | undefined; let temporary: string | undefined;
    try {
      parent = await directory(options.profileHome(profile));
      const raw = await readAt(parent, 'config.yaml', MAX_CONFIG);
      const catalog = await tools(profile); context.guard();
      const tool = catalog.toolsets.find((entry) => entry.name === name);
      if (!tool) throw new HermesError('toolset_not_found', 'La herramienta ya no está disponible.');
      if (enabled && !tool.configured) throw new HermesError('tool_not_configured', 'Configura esta herramienta en el Servidor antes de encenderla.');
      if (tool.enabled === enabled) return catalog;
      const edited = await metadata({ operation: 'edit', raw: text(raw), catalog: catalog.toolsets, name, enabled });
      if (typeof edited.raw !== 'string' || Buffer.byteLength(edited.raw) > MAX_CONFIG) throw unavailable();
      context.guard();
      if (!(await readAt(parent, 'config.yaml', MAX_CONFIG)).equals(raw)) throw conflict();
      const backup = await openPrivateFile(path.join(context.backupDirectory, `agent-tools-${randomUUID()}.previous`), constants.O_WRONLY | constants.O_EXCL, true);
      try { await backup.handle.writeFile(raw); await backup.handle.sync(); } finally { await backup.handle.close(); }
      await syncStateDirectory(context.backupDirectory);
      await context.beforeWrite(); context.guard();
      if (!(await readAt(parent, 'config.yaml', MAX_CONFIG)).equals(raw)) throw conflict();
      temporary = `/proc/self/fd/${parent.fd}/.relay-tools-${randomUUID()}.tmp`;
      const file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(edited.raw); await file.sync(); } finally { await file.close(); }
      context.guard();
      if (!(await readAt(parent, 'config.yaml', MAX_CONFIG)).equals(raw)) throw conflict();
      context.guard();
      await fs.rename(temporary, `/proc/self/fd/${parent.fd}/config.yaml`); temporary = undefined;
      await parent.sync();
      // Return the saved api_server selection; Hermes can read it on the next Turn, including existing Conversations.
      return { ...catalog, observedAt: now(), toolsets: catalog.toolsets.map((entry) => entry.name === name ? { ...entry, enabled } : entry) };
    } catch (error) { if (error instanceof HermesError || (error instanceof Error && error.name === 'AuthorizationError')) throw error; throw unavailable(); }
    finally { if (temporary) await fs.unlink(temporary).catch(() => {}); await parent?.close(); }
  }
  return {
    tools,
    setToolset(profile, name, enabled, context) {
      const previous = queues.get(profile) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(() => change(profile, name, enabled, context));
      queues.set(profile, pending);
      void pending.finally(() => { if (queues.get(profile) === pending) queues.delete(profile); }).catch(() => {});
      return pending;
    },
    async skills(profile) {
      let root: FileHandle | undefined;
      try {
        if (!validName(profile)) throw unavailable();
        root = await directory(options.profileHome(profile));
        const raw = text(await readAt(root, 'config.yaml', MAX_CONFIG));
        const files: { text: string; name: string; category: string | null }[] = [];
        let limited = false, visited = 0, bytes = 0;
        const excluded = new Set(['.git', '.hub', '.cache', '.quarantine', 'node_modules', 'venv', 'site-packages', '__pycache__', '_org', 'references', 'scripts', 'assets', 'templates']);
        async function scan(parent: FileHandle, depth: number, category: string | null, fallback: string): Promise<void> {
          if (depth > 8 || ++visited > 2048 || files.length >= 256) { limited = true; return; }
          // opendir streams entries; never allocate an unbounded readdir list.
          const entries = await fs.opendir(`/proc/self/fd/${parent.fd}`);
          for await (const entry of entries) {
            if (++visited > 2048 || files.length >= 256) { limited = true; break; }
            if (entry.name === '_org') { limited = true; continue; }
            if (entry.name.startsWith('.') || excluded.has(entry.name)) continue;
            if (entry.isSymbolicLink()) { limited = true; continue; }
            if (entry.name === 'SKILL.md' && entry.isFile()) {
              try {
                const content = await readAt(parent, entry.name, 64 * 1024); bytes += content.length;
                if (bytes > 2_000_000) { limited = true; break; }
                files.push({ text: text(content), name: fallback, category });
              } catch { limited = true; }
            } else if (entry.isDirectory()) {
              let child: FileHandle | undefined;
              try {
                child = await fs.open(`/proc/self/fd/${parent.fd}/${entry.name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                await scan(child, depth + 1, depth === 0 ? null : depth === 1 ? fallback : category, entry.name);
              } catch { limited = true; } finally { await child?.close(); }
            }
          }
        }
        let installed: FileHandle | undefined;
        try {
          installed = await fs.open(`/proc/self/fd/${root.fd}/skills`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          await scan(installed, 0, null, 'skills');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        finally { await installed?.close(); }
        const result = await metadata({ operation: 'skills', raw, files });
        if (!Array.isArray(result.skills)) throw unavailable();
        const skills = (result.skills as AgentSkill[]).sort((a, b) => a.name.localeCompare(b.name));
        return { skills, observedAt: now(), scope: 'profile_installed', limited: limited || result.limited === true };
      } catch { throw unavailable(); } finally { await root?.close(); }
    },
  };
}
