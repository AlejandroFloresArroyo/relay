// Demo terminals (npm run demo): one per state the Terminal tool shows, behind the same session core.
// A tiny synthetic shell answers instead of a PTY; nothing leaves the app.
import { boardWebBase64 } from './boardWeb.ts';
import { RemoteFailure } from './remoteClient.ts';
import type { TerminalPort } from './terminalSession.ts';
import type { Terminal, TerminalsApi } from './terminals.ts';

const HOME = '/home/user';
const encode = (text: string) => boardWebBase64(new TextEncoder().encode(text));
/** What `npm test` prints in the demo, a line at a time: the program writes for a while and the output sweep runs. */
const TEST_RUN = ['\x1b[32m✓\x1b[0m tests/orders.test.ts (14)', '\x1b[32m✓\x1b[0m tests/auth.test.ts (9)', '\x1b[33m❯\x1b[0m tests/db/client.test.ts',
  '  \x1b[32m✓\x1b[0m conecta con el pool', '  \x1b[32m✓\x1b[0m reintenta al caer', '  · cierra las conexiones…', '\x1b[32m✓\x1b[0m tests/db/client.test.ts (6)', 'Tests  29 passed (29)'];
const TEST_STEP_MS = 700;
const PROMPT = '\x1b[32male@atlas\x1b[0m:\x1b[34m%s\x1b[0m$ ';

/** shell: answers; offline: never connects (reconnecting); replaced: open elsewhere; broken: unexpected answer. */
type Demo = Terminal & { behaviour: 'shell' | 'offline' | 'replaced' | 'broken'; history: string };
const id = (name: string) => `env_demo${name.padEnd(22, '0')}`;

function seed(): Demo[] {
  const base = { ownership: 'own' as const, exitCode: null, terminationError: null, history: '' };
  // The newest live terminal is the one shown first: the healthy shell.
  return [
    { ...base, id: id('web'), state: 'running', shell: '/bin/bash', cwd: `${HOME}/proyectos/web`, createdAt: 1, behaviour: 'offline' },
    { ...base, id: id('tablet'), state: 'running', shell: '/usr/bin/zsh', cwd: `${HOME}/notas`, createdAt: 2, behaviour: 'replaced' },
    { ...base, id: id('odd'), state: 'running', shell: '/bin/bash', cwd: '/tmp', createdAt: 3, behaviour: 'broken' },
    { ...base, id: id('done'), state: 'exited', exitCode: 0, shell: '/usr/bin/zsh', cwd: HOME, createdAt: 4, behaviour: 'shell' },
    { ...base, id: id('lost'), state: 'lost', shell: '/bin/bash', cwd: '/srv', createdAt: 5, behaviour: 'shell' },
    { ...base, id: id('relay'), state: 'running', shell: '/usr/bin/zsh', cwd: `${HOME}/relay`, createdAt: 6, behaviour: 'shell',
      history: 'npm test\r\n\x1b[32m✔\x1b[0m 412 pruebas, 0 fallos\r\n' },
  ];
}

export function createDemoTerminals(): { api: TerminalsApi; port: (id: string) => TerminalPort } {
  const terminals = seed();
  const outputs = new Map<string, (text: string) => void>();
  const find = (environmentId: string) => {
    const found = terminals.find((each) => each.id === environmentId);
    if (!found) throw new RemoteFailure('remote', { code: 'remote_not_found' });
    return found;
  };
  const strip = ({ behaviour: _b, history: _h, ...terminal }: Demo): Terminal => terminal;

  const api: TerminalsApi = {
    list: async () => terminals.map(strip),
    shells: async () => ({ shells: ['/bin/bash', '/usr/bin/zsh'], defaultShell: '/usr/bin/zsh', home: HOME }),
    async create(_requestId, shell, cwd) {
      const created: Demo = { id: id(`new${terminals.length}`), state: 'running', ownership: 'own', shell, cwd, createdAt: terminals.length + 1,
        exitCode: null, terminationError: null, behaviour: 'shell', history: '' };
      terminals.push(created);
      return strip(created);
    },
    async terminate(environmentId) {
      const found = find(environmentId);
      if (found.state === 'running') Object.assign(found, { state: 'exited', exitCode: 0 });
      outputs.get(environmentId)?.('\r\n');
      return strip(found);
    },
    async discard(environmentId) { terminals.splice(terminals.indexOf(find(environmentId)), 1); },
  };

  const port = (environmentId: string): TerminalPort => {
    let seq = 0;
    let line = '';
    let program: ReturnType<typeof setTimeout> | null = null;
    let emit: (event: object) => void = () => {};
    const write = (text: string) => emit({ type: 'output', seq: ++seq, data: encode(text) });
    const prompt = () => PROMPT.replace('%s', find(environmentId).cwd.replace(HOME, '~'));
    return {
      async stream(lastEventId, onData, signal) {
        const terminal = find(environmentId);
        if (terminal.state === 'exited' || terminal.state === 'lost') throw new RemoteFailure('remote', { code: 'remote_ended' });
        if (terminal.behaviour === 'offline') throw new RemoteFailure('no_response');
        if (terminal.behaviour === 'broken') throw new RemoteFailure('unexpected', { status: 200 });
        emit = (event) => onData(JSON.stringify(event));
        emit({ type: 'open', channel: 'demo_channel_000000000', inputSeq: 0 });
        if (lastEventId === 0) write(`${prompt()}${terminal.history}${prompt()}`);
        if (terminal.behaviour === 'replaced') { emit({ type: 'closed', reason: 'replaced' }); return; }
        const { promise, resolve: finish } = Promise.withResolvers<void>();
        outputs.set(environmentId, (text) => {
          write(text);
          emit({ type: 'closed', reason: 'exited' });
          finish();
        });
        signal.addEventListener('abort', () => { if (program) clearTimeout(program); finish(); }, { once: true });
        await promise;
        outputs.delete(environmentId);
      },
      ack: async () => ({ ok: true }),
      async input(inputSeq, data) {
        for (const char of new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))) {
          if (char === '\r') {
            const command = line.trim();
            line = '';
            if (command === 'npm test' && !program) {
              let next = 0;
              const step = () => {
                if (next < TEST_RUN.length) { write(`\r\n${TEST_RUN[next++]}`); program = setTimeout(step, TEST_STEP_MS); }
                else { write(`\r\n${prompt()}`); program = null; }
              };
              program = setTimeout(step, TEST_STEP_MS);
              continue;
            }
            write(`\r\n${command === 'ls' ? 'README.md  mobile  bridge  protocol\r\n' : command ? `${command}: orden de demostración\r\n` : ''}${prompt()}`);
          } else if (char === '\x7f') {
            if (line) { line = line.slice(0, -1); write('\b \b'); }
          } else if (char >= ' ') { line += char; write(char); }
        }
        return { inputSeq };
      },
      resize: async () => ({ ok: true }),
    };
  };
  return { api, port };
}
