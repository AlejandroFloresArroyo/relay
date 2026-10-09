// The Linux discovery adapter against a fixture /proc: the socket table and the account's processes
// are files and links in a temporary folder. No real socket of the machine is read.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createLinuxSockets } from '../src/remote/linuxSockets.ts';

const UID = process.getuid!();
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (local: string, port: number, state: string, uid: number, inode: number) =>
  `   0: ${local}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

async function fixture(t: TestContext) {
  const proc = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-proc-'));
  t.after(async () => { await fs.chmod(path.join(proc, '4444', 'fd'), 0o700).catch(() => {}); await fs.rm(proc, { recursive: true, force: true }); });
  await fs.mkdir(path.join(proc, 'net'));
  await fs.writeFile(path.join(proc, 'net', 'tcp'), [HEADER,
    row('0100007F', 5173, '0A', UID, 111), row('00000000', 3000, '0A', UID, 112), row('05004064', 4001, '0A', UID, 113),
    row('0100007F', 631, '0A', 0, 114), row('0100007F', 40000, '01', UID, 115), ''].join('\n'));
  await fs.writeFile(path.join(proc, 'net', 'tcp6'), [HEADER.replace('local_address', 'local_address                         '),
    row('00000000000000000000000001000000', 5174, '0A', UID, 121), row('00000000000000000000000000000000', 3001, '0A', UID, 122),
    row('0000000000000000FFFF00000100007F', 4003, '0A', UID, 123), ''].join('\n'));
  const processDir = async (pid: string, links: Record<string, string>, extra: Record<string, string> = {}) => {
    await fs.mkdir(path.join(proc, pid, 'fd'), { recursive: true });
    for (const [fd, target] of Object.entries(links)) await fs.symlink(target, path.join(proc, pid, 'fd', fd));
    for (const [name, target] of Object.entries(extra)) {
      if (name === 'comm') await fs.writeFile(path.join(proc, pid, name), target);
      else await fs.symlink(target, path.join(proc, pid, name));
    }
  };
  await processDir('4242', { 0: '/dev/null', 3: 'socket:[111]', 4: 'socket:[121]' }, { exe: '/usr/bin/node', cwd: '/home/user/dev/app-a', comm: 'node\n' });
  await processDir('4343', { 5: 'socket:[112]' }, { comm: 'python3\n' }); // exe and cwd unreadable
  await processDir('4444', { 6: 'socket:[122]' }, { exe: '/usr/bin/ruby', cwd: '/x', comm: 'ruby\n' });
  await fs.chmod(path.join(proc, '4444', 'fd'), 0o000); // another account's process
  await processDir('4545', { 7: 'socket:[123]' }, { exe: '/usr/bin/vite', cwd: '/home/user/dev/app-c', comm: 'vite\n' });
  await fs.mkdir(path.join(proc, 'self'));
  return proc;
}

test('lists the account\'s listening TCP sockets with the program that owns each, from the socket table only', async (t) => {
  const registry = createLinuxSockets({ proc: await fixture(t), uid: UID });
  assert.deepEqual(await registry.availability(), { state: 'available' });
  const node = { name: 'node', exe: '/usr/bin/node', cwd: '/home/user/dev/app-a' };
  assert.deepEqual(await registry.listening(), [
    { address: '127.0.0.1', port: 5173, pid: 4242, process: node },
    { address: '0.0.0.0', port: 3000, pid: 4343, process: null },
    { address: '100.64.0.5', port: 4001, pid: null, process: null },
    { address: '::1', port: 5174, pid: 4242, process: node },
    { address: '::', port: 3001, pid: null, process: null },
    { address: '127.0.0.1', port: 4003, pid: 4545, process: { name: 'vite', exe: '/usr/bin/vite', cwd: '/home/user/dev/app-c' } },
  ]);
});

test('without a socket table the in-Relay web is an unsupported platform', async (t) => {
  const proc = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-proc-'));
  t.after(() => fs.rm(proc, { recursive: true, force: true }));
  const registry = createLinuxSockets({ proc, uid: UID });
  assert.deepEqual(await registry.availability(), { state: 'unavailable', reason: 'unsupported_platform' });
  await assert.rejects(registry.listening());
});
