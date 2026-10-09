// The demo Servidor's files (npm run demo): an in-memory Puente behind the same RemoteClient, so the
// explorer, editor, transfers and search run their real core. One file per state the tool shows.
import { REMOTE_ERROR_STATUS, type RemoteErrorCode } from '../../../protocol/protocol.ts';
import type { RemoteFileEntry, RemoteFileType } from '../../../protocol/remoteFiles.ts';
import { encodeText } from '../../../protocol/textCodec.ts';
import { boardWebBase64 } from './boardWeb.ts';
import { RemoteFailure, type RemoteClient } from './remoteClient.ts';

const HOME = '/home/user';
const CHUNK = 1_048_576;

interface Node { type: RemoteFileType; bytes?: Uint8Array; size?: number; target?: string; mode: number; mtime: number; ino: number }

const utf8 = (text: string) => new TextEncoder().encode(text);
const fail = (code: RemoteErrorCode): never => { throw new RemoteFailure('remote', { code, status: REMOTE_ERROR_STATUS[code] }); };
function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function limitText(): Uint8Array {
  const bytes = new Uint8Array(5 * CHUNK).fill(0x2e);
  const line = utf8('linea de registro con texto de relleno para medir el editor en su limite.\n');
  for (let offset = 0; offset + line.length <= bytes.length; offset += line.length) bytes.set(line, offset);
  bytes[bytes.length - 1] = 0x0a;
  return bytes;
}

function seed(): Map<string, Node> {
  let ino = 100;
  const at = Date.UTC(2026, 9, 5, 9, 41);
  const tree = new Map<string, Node>();
  const add = (path: string, node: Omit<Node, 'ino' | 'mtime' | 'mode'> & { mode?: number }) => {
    tree.set(path, { mode: node.type === 'directory' ? 0o755 : 0o644, mtime: at - (ino % 7) * 86_400_000, ino: ino++, ...node });
  };
  for (const folder of ['', '/proyectos', '/proyectos/relay', '/.hermes', '/.hermes/profiles', '/.hermes/profiles/dev', '/.config', '/.config/relay', '/vacia']) add(`${HOME}${folder}`, { type: 'directory' });
  add(`${HOME}/notas.txt`, { type: 'file', bytes: utf8('Ideas para la semana\n- Revisar el despliegue de atlas\n- Contestar a Marta\n') });
  add(`${HOME}/crlf-windows.txt`, { type: 'file', bytes: utf8('Archivo de Windows\r\nCada línea termina en CRLF\r\nRelay los conserva al guardar\r\n') });
  add(`${HOME}/mixto.log`, { type: 'file', bytes: utf8('inicio\nprogreso 10%\rprogreso 90%\r\nfin\n') });
  // Bytes that read as Windows-1252 and as ISO-8859-1 differently: the format is only a guess.
  add(`${HOME}/informe-1252.txt`, { type: 'file', bytes: encodeText('Informe “trimestral” — año 2026\nCafé, señal y €\n', { encoding: 'windows-1252', bom: false }) as Uint8Array });
  add(`${HOME}/latin1.txt`, { type: 'file', bytes: encodeText('Línea en ISO-8859-1: canción, niño\n', { encoding: 'iso-8859-1', bom: false }) as Uint8Array });
  add(`${HOME}/conflicto.md`, { type: 'file', bytes: utf8('# Plan\nAl guardar, otra persona ya lo cambió en el Servidor.\n') });
  add(`${HOME}/respaldo-2026-10-01.tar.gz`, { type: 'file', size: 24 * CHUNK + 4321 });
  add(`${HOME}/foto.png`, { type: 'file', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]) });
  // The editor's limit, exactly: 5 MiB of ASCII lines, to try how the editor moves at its largest.
  add(`${HOME}/limite-5mib.log`, { type: 'file', bytes: limitText() });
  add(`${HOME}/.bashrc`, { type: 'file', bytes: utf8('export EDITOR=nvim\nalias ll="ls -la"\n') });
  add(`${HOME}/proyectos/relay/README.md`, { type: 'file', bytes: utf8('# Relay\nControl remoto de agentes de Hermes.\n') });
  add(`${HOME}/proyectos/relay/notas-relay.txt`, { type: 'file', bytes: utf8('Pendiente: notas del explorador.\n') });
  add(`${HOME}/enlace-proyectos`, { type: 'symlink', mode: 0o777, target: `${HOME}/proyectos` });
  add(`${HOME}/enlace-roto`, { type: 'symlink', mode: 0o777, target: `${HOME}/borrado.txt` });
  add(`${HOME}/cola-trabajos`, { type: 'fifo', mode: 0o600 });
  add(`${HOME}/script.sh`, { type: 'file', mode: 0o4755, bytes: utf8('#!/bin/sh\necho hola\n') });
  add(`${HOME}/.hermes/SOUL.md`, { type: 'file', bytes: utf8('# Soul\nEres un ingeniero backend senior.\n') });
  add(`${HOME}/.hermes/profiles/dev/SOUL.md`, { type: 'file', bytes: utf8('# Soul\nPerfil de desarrollo.\n') });
  add(`${HOME}/.config/relay/signing.properties`, { type: 'file', bytes: utf8('privado\n') });
  return tree;
}

export function createDemoServerFiles(): () => RemoteClient {
  const tree = seed();
  const operations = new Map<string, { type: 'save' | 'upload' | 'download' | 'search'; bytes: Uint8Array; received: number; path?: string; state: string; frames?: string[] }>();
  let opCount = 0;
  let conflicted = false;
  const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  /** Follows links in every component, as the Puente opens a path. */
  const resolve = (path: string, last = true): string => {
    let real = '';
    const parts = path.split('/').filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      real = `${real}/${parts[index]}`;
      const node = tree.get(real);
      if (node?.type === 'symlink' && (last || index < parts.length - 1)) real = resolve(node.target!);
    }
    return real || '/';
  };
  const zone = (real: string) => real === `${HOME}/.hermes` || real.startsWith(`${HOME}/.hermes/`) ? 'profile' as const
    : real === `${HOME}/.config/relay` || real.startsWith(`${HOME}/.config/relay/`) ? 'bridge' as const : null;
  const size = (node: Node) => node.bytes?.length ?? node.size ?? 0;
  const version = (node: Node) => ({ dev: '64', ino: String(node.ino), mtimeNs: `${node.mtime}000000`, ctimeNs: `${node.mtime}000001` });
  const content = (node: Node) => ({ dev: '64', ino: String(node.ino), size: size(node), mtimeNs: `${node.mtime}000000`, sha256: node.mtime.toString(16).padStart(64, '0') });
  const describe = (path: string, node: Node): RemoteFileEntry => {
    const entry: RemoteFileEntry = { name: base(path), nameUtf8: true, type: node.type, size: size(node), mode: node.mode, uid: 1000, gid: 1000, mtime: node.mtime, version: version(node) };
    if (node.type !== 'symlink') return entry;
    const real = resolve(path);
    const target = tree.get(real);
    return { ...entry, link: { target: node.target!, realPath: target ? real : null, type: target?.type ?? null } };
  };
  const children = (real: string) => [...tree.keys()].filter((path) => path !== real && parent(path) === real).sort();
  const writable = (real: string) => {
    if (zone(real) === 'bridge') fail('remote_bridge_protected');
    if ([`${HOME}/.hermes`, `${HOME}/.hermes/profiles`, HOME, '/home'].includes(real) || real.startsWith(`${HOME}/.hermes/profiles/`) && parent(real) === `${HOME}/.hermes/profiles`) fail('remote_profile_protected');
  };
  const touch = (node: Node) => { node.mtime += 60_000; };
  const operation = (type: 'save' | 'upload' | 'download' | 'search', extra: Partial<{ bytes: Uint8Array; path: string; frames: string[] }> = {}) => {
    const id = `op_demo${String(++opCount).padStart(18, '0')}`;
    operations.set(id, { type, bytes: extra.bytes ?? new Uint8Array(0), received: 0, state: 'running', ...extra });
    return id;
  };
  const own = (id: string) => operations.get(id) ?? fail('remote_not_found');

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    await wait(120);
    const input = (body ?? {}) as Record<string, unknown>;
    const op = /^\/v1\/remote\/(?:files\/(?:saves|uploads)|operations)\/(op_[A-Za-z0-9_-]+)\/(commit|cancel|ack)$/.exec(path);
    if (op) {
      const [, id, action] = op;
      const running = own(id!);
      if (action === 'ack') return { ok: true };
      if (action === 'cancel') { if (running.state === 'running') running.state = 'cancelled'; return { id, state: running.state }; }
      if (running.type === 'save') {
        const target = resolve(input.path as string);
        const node = tree.get(target) ?? fail('remote_not_found');
        if (base(target) === 'conflicto.md' && !conflicted) {
          conflicted = true;
          node.bytes = utf8('# Plan\nOtra persona cambió esta línea desde la computadora.\n');
          touch(node);
        }
        if (JSON.stringify(content(node)) !== JSON.stringify(input.version)) fail('remote_conflict');
        writable(target);
        node.bytes = running.bytes;
        touch(node);
        running.state = 'completed';
        return { path: input.path, realPath: target, version: content(node) };
      }
      const destination = `${resolve(parent(running.path!))}/${base(running.path!)}`;
      const existing = tree.get(destination);
      if (existing && !input.replace) fail('remote_confirmation_required');
      if (existing && JSON.stringify(input.replace) !== JSON.stringify(version(existing))) fail('remote_conflict');
      writable(destination);
      const node: Node = existing ?? { type: 'file', mode: 0o644, mtime: Date.UTC(2026, 9, 5, 10), ino: 900 + opCount };
      node.bytes = running.bytes.slice(0, running.received);
      touch(node);
      tree.set(destination, node);
      running.state = 'completed';
      return describe(destination, node);
    }
    switch (path) {
      case '/v1/remote/files/list': {
        const requested = (input.path as string | undefined) ?? HOME;
        const real = resolve(requested);
        if (tree.get(real)?.type !== 'directory') fail('remote_not_found');
        const entries = children(real).filter((child) => input.hidden === true || !base(child).startsWith('.')).map((child) => describe(child, tree.get(child)!));
        return { path: requested, realPath: real, entries, truncated: false, protection: zone(real) };
      }
      case '/v1/remote/files/create': {
        const directory = resolve(input.directory as string);
        const target = `${directory}/${input.name as string}`;
        if (tree.has(target)) fail('remote_exists');
        writable(target);
        const node: Node = { type: input.type === 'directory' ? 'directory' : 'file', mode: input.type === 'directory' ? 0o755 : 0o644, mtime: Date.UTC(2026, 9, 5, 10), ino: 800 + tree.size, ...(input.type === 'directory' ? {} : { bytes: new Uint8Array(0) }) };
        tree.set(target, node);
        return describe(target, node);
      }
      case '/v1/remote/files/move': {
        const source = `${resolve(parent(input.path as string))}/${base(input.path as string)}`;
        const node = tree.get(source) ?? fail('remote_not_found');
        if (JSON.stringify(version(node)) !== JSON.stringify(input.version)) fail('remote_conflict');
        const target = `${resolve(input.directory as string)}/${input.name as string}`;
        if (tree.has(target)) fail('remote_exists');
        writable(source);
        writable(target);
        for (const [path, each] of [...tree]) {
          if (path === source || path.startsWith(`${source}/`)) { tree.delete(path); tree.set(target + path.slice(source.length), each); }
        }
        return describe(target, node);
      }
      case '/v1/remote/files/delete': {
        const target = `${resolve(parent(input.path as string))}/${base(input.path as string)}`;
        const node = tree.get(target) ?? fail('remote_not_found');
        if (JSON.stringify(version(node)) !== JSON.stringify(input.version)) fail('remote_conflict');
        writable(target);
        if (input.confirm !== true) fail('remote_confirmation_required');
        for (const path of [...tree.keys()]) if (path === target || path.startsWith(`${target}/`)) tree.delete(path);
        return { ok: true };
      }
      case '/v1/remote/files/read': {
        const target = resolve(input.path as string);
        const node = tree.get(target) ?? fail('remote_not_found');
        if (node.type !== 'file') fail('remote_invalid_request');
        if (!node.bytes) fail('remote_too_large');
        return { path: input.path, realPath: target, version: content(node), bytes: boardWebBase64(node.bytes!), protection: zone(target) };
      }
      case '/v1/remote/files/saves': return { id: operation('save', { bytes: new Uint8Array(input.size as number) }), size: input.size, received: 0 };
      case '/v1/remote/files/uploads': {
        writable(resolve(input.directory as string));
        return { id: operation('upload', { bytes: new Uint8Array((input.size as number | undefined) ?? 0), path: `${input.directory as string}/${input.name as string}` }), size: input.size ?? null, received: 0 };
      }
      case '/v1/remote/files/downloads': {
        const target = resolve(input.path as string);
        const node = tree.get(target) ?? fail('remote_not_found');
        if (node.type !== 'file') fail('remote_invalid_request');
        return { id: operation('download', { path: target }), path: input.path, realPath: target, size: size(node), version: version(node) };
      }
      case '/v1/remote/files/search': {
        const root = resolve(input.path as string);
        const query = String(input.query).toLowerCase();
        const matches = [...tree.keys()].filter((each) => each.startsWith(`${root}/`) && (input.hidden === true || !each.slice(root.length).includes('/.')))
          .filter((each) => input.content ? new TextDecoder().decode(tree.get(each)!.bytes ?? new Uint8Array(0)).toLowerCase().includes(query) : base(each).toLowerCase().includes(query))
          .map((each) => ({ path: each, entry: describe(each, tree.get(each)!) }));
        const folders = [...tree.keys()].filter((each) => each.startsWith(`${root}/`) && tree.get(each)!.type === 'directory').length + 1;
        const files = [...tree.keys()].filter((each) => each.startsWith(`${root}/`) && tree.get(each)!.type === 'file').length;
        const frames = [
          JSON.stringify({ type: 'results', seq: 1, matches: matches.slice(0, 2), folders: 1, files: Math.min(files, 3), unreadable: 0 }),
          JSON.stringify({ type: 'results', seq: 2, matches: matches.slice(2), folders, files, unreadable: 1 }),
          JSON.stringify({ type: 'end', seq: 3, state: 'completed', truncated: false, folders, files, unreadable: 1 }),
        ];
        return { id: operation('search', { frames }), state: 'running' };
      }
    }
    return fail('remote_invalid_request');
  };

  const client: RemoteClient = {
    request,
    async chunk(method, path, body, signal) {
      await wait(method === 'GET' ? 260 : 160);
      if (signal.aborted) throw new RemoteFailure('no_response');
      const [, kind, id, offsetText] = /\/(saves|uploads|downloads)\/(op_[A-Za-z0-9_-]+)\/(\d+)$/.exec(path) ?? fail('remote_invalid_request');
      const running = own(id!);
      if (running.state !== 'running') fail('remote_ended');
      const offset = Number(offsetText);
      if (kind === 'downloads') {
        const node = tree.get(running.path!)!;
        const end = Math.min(offset + CHUNK, size(node));
        if (end === size(node)) running.state = 'completed';
        return node.bytes ? node.bytes.slice(offset, end) : new Uint8Array(end - offset);
      }
      const bytes = body!;
      if (offset + bytes.length > running.bytes.length) {
        const grown = new Uint8Array(offset + bytes.length);
        grown.set(running.bytes);
        running.bytes = grown;
      }
      running.bytes.set(bytes, offset);
      running.received = Math.max(running.received, offset + bytes.length);
      return { id, size: running.bytes.length, received: running.received };
    },
    async stream(path, lastEventId, onData, signal) {
      const [, id] = /operations\/(op_[A-Za-z0-9_-]+)\/events$/.exec(path) ?? fail('remote_invalid_request');
      const frames = own(id!).frames ?? [];
      for (const frame of frames.slice(lastEventId)) {
        await wait(400);
        if (signal.aborted) return;
        onData(frame);
      }
    },
  };
  return () => client;
}
