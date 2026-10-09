// Acceptance, scenario 1 of docs/relay-v3.md §7: choose shell and folder, work with tmux or a
// full-screen program, several tabs and the keys of a keyboard; live terminals come back after a
// reconnection and after the Puente restarts. Real supervisor process, systemd scopes, node-pty, bash
// and tmux (support/acceptance_lab.ts). The app's keyboard, tabs and IME are the component suites'.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { acceptanceLab, assertLogsClean, PHONE, SKIP, until, type OutputStream } from '../../support/acceptance_lab.ts';

const text = (stream: OutputStream) => stream.bytes().toString('utf8');
const shows = (stream: OutputStream, marker: string, what: string) => until(() => text(stream).includes(marker), what, 15_000);

test('scenario 1: shell and folder, tmux and full screen, tabs and keys; live terminals survive a reconnection and a Puente restart', { skip: SKIP, timeout: 120_000 }, async (t) => {
  const lab = await acceptanceLab(t);
  const project = path.join(lab.dirs.home, 'proyecto');
  await fs.mkdir(project);
  let puente = await lab.puente();

  // The shells the Server offers and its home: what the app's «Nueva terminal» offers.
  const shells = await puente.call(PHONE, 'GET', '/v1/remote/shells', undefined, 'terminal/1');
  assert.equal(shells.status, 200);
  assert.ok(shells.json.shells.includes('/bin/bash') && shells.json.shells.includes('/bin/sh'));
  assert.equal(shells.json.home, lab.dirs.home);
  // A folder that does not exist opens nothing.
  const missing = await puente.call(PHONE, 'POST', '/v1/remote/environments', { requestId: 'acc-term-missing', kind: 'terminal', shell: '/bin/bash', cwd: path.join(lab.dirs.home, 'no-existe') });
  assert.equal(missing.status, 404, JSON.stringify(missing.json));
  assert.deepEqual(await puente.list(PHONE), []);

  // Two tabs: bash in the project, sh in the home.
  const work = await puente.openTerminal(PHONE, 'acc-term-work', '/bin/bash', project);
  const side = await puente.openTerminal(PHONE, 'acc-term-side', '/bin/sh', lab.dirs.home);
  assert.deepEqual((await puente.list(PHONE)).map((environment) => [environment.id, environment.kind, environment.ownership, environment.state]).sort(),
    [[work, 'terminal', 'own', 'running'], [side, 'terminal', 'own', 'running']].sort());
  const workOut = await puente.output(PHONE, work);
  const sideOut = await puente.output(PHONE, side);
  assert.equal(workOut.status, 200);

  // Each in its own folder and shell; the size follows the view (resize, then stty).
  await puente.type(PHONE, work, 'echo "dir=$(pwd) shell=$0 suma=$((40+2))"\r');
  await shows(workOut, `dir=${project} shell=/bin/bash suma=42`, 'bash in the chosen folder');
  assert.equal((await puente.resize(PHONE, side, 100, 30)).status, 200);
  await puente.type(PHONE, side, 'echo "tam=$(stty size) dir=$(pwd)"\r');
  await shows(sideOut, `tam=30 100 dir=${lab.dirs.home}`, 'sh in the home at the size of the view');

  // Keys of the keyboard bar: Ctrl-C ends the program in front, arrow up recalls history, Tab completes.
  await puente.type(PHONE, work, 'sleep 300; echo "no-interrumpido-$((1+1))"\r');
  await puente.type(PHONE, work, '\x03');
  await puente.type(PHONE, work, 'echo "tras-ctrl-c-$((2+1))"\r');
  await shows(workOut, 'tras-ctrl-c-3', 'Ctrl-C interrupted sleep');
  assert.ok(!text(workOut).includes('no-interrumpido-2'));
  await puente.type(PHONE, work, '\x1b[A\r');
  await until(() => text(workOut).split('tras-ctrl-c-3').length > 2, 'arrow up repeated the last command', 15_000);
  await fs.writeFile(path.join(project, 'archivo-unico.txt'), 'contenido-completado\n');
  await puente.type(PHONE, work, 'cat archivo-un\t\r');
  await shows(workOut, 'contenido-completado', 'Tab completed the file name');
  // A multi-line paste arrives as typed: each line runs, nothing more is sent.
  await puente.type(PHONE, work, 'echo "pega-$((3*1))"\recho "pega-$((2*2))"\r');
  await shows(workOut, 'pega-4', 'both pasted lines ran');

  // tmux inside the terminal, full screen (alternate screen), with a job that keeps writing.
  await puente.type(PHONE, work, 'tmux -L acc -f /dev/null new-session -s trabajo\r');
  await shows(workOut, '\x1b[?1049h', 'tmux took the full screen');
  const heartbeat = path.join(lab.dirs.home, 'latido');
  await puente.type(PHONE, work, `while :; do date +%s%N >> ${heartbeat}; sleep 0.2; done\r`);
  await until(() => fs.stat(heartbeat).then((stat) => stat.size > 0, () => false), 'the job inside tmux writes', 15_000);
  await puente.type(PHONE, side, 'tmux -L acc ls\r');
  await shows(sideOut, 'trabajo: 1 windows', 'the tmux session is listed from the other tab');

  // Reconnection: the app reopens the stream from its last seq; nothing is repeated, nothing missing.
  const seenBefore = workOut.lastSeq();
  workOut.close();
  await workOut.ended;
  const resumed = await puente.output(PHONE, work, String(seenBefore));
  await until(() => resumed.events.some((event) => event.type === 'open'), 'reopened');
  assert.ok(!resumed.events.some((event) => event.type === 'gap'), 'nothing was lost while the ring holds it');
  resumed.close();

  // The Puente restarts (update, crash): its streams and its supervisor channel go, the work stays.
  const lastSeen = sideOut.lastSeq();
  puente.close();
  const sizeAtStop = (await fs.stat(heartbeat)).size;
  await until(async () => (await fs.stat(heartbeat)).size > sizeAtStop, 'the job keeps running with no Puente', 15_000);
  puente = await lab.puente();
  await until(async () => (await puente.call(PHONE, 'GET', '/v1/remote/environments')).status === 200, 'the new Puente reaches the supervisor', 15_000);
  assert.deepEqual((await puente.list(PHONE)).map((environment) => [environment.id, environment.state]).sort(), [[work, 'running'], [side, 'running']].sort());
  const sideAgain = await puente.output(PHONE, side, String(lastSeen));
  await until(() => sideAgain.events.some((event) => event.type === 'open'), 'reopened after the restart');
  const open = sideAgain.events.find((event) => event.type === 'open');
  assert.ok(open?.type === 'open' && 'inputSeq' in open, 'a terminal open event names the applied input seq');
  puente.resumeInput(side, open.inputSeq);
  await puente.type(PHONE, side, 'tmux -L acc ls; echo "tras-reinicio-$((5+5))"\r');
  await shows(sideAgain, 'tras-reinicio-10', 'the same shell answers after the restart');
  assert.ok(text(sideAgain).includes('trabajo: 1 windows'), 'tmux and its job are still there');
  const outputs = sideAgain.events.filter((event) => event.type === 'output');
  assert.equal(outputs[0]?.type === 'output' && outputs[0].seq, lastSeen + 1, 'the output continues from the last seq the app held');
  assert.ok(!sideAgain.events.some((event) => event.type === 'gap'));

  // A program that ends leaves its terminal ended, with its code; nothing replaces it.
  await puente.type(PHONE, side, 'exit 3\r');
  await until(() => sideAgain.events.some((event) => event.type === 'closed'), 'the stream says the program ended', 15_000);
  assert.deepEqual(sideAgain.events.at(-1), { type: 'closed', reason: 'exited' });
  await until(async () => (await puente.list(PHONE)).find((environment) => environment.id === side)?.state === 'exited', 'exited', 15_000);
  assert.equal((await puente.list(PHONE)).find((environment) => environment.id === side)?.exitCode, 3);
  assert.equal((await puente.list(PHONE)).length, 2, 'no substitute terminal');

  // Ending the own terminal (confirmed) takes its tmux server and its job with it: the whole scope.
  const ended = await puente.terminate(PHONE, work);
  assert.equal(ended.status, 200);
  await until(async () => (await lab.scopeProcs(work)).length === 0, 'the scope is empty', 20_000);
  const sizeAtEnd = (await fs.stat(heartbeat)).size;
  // Real time on purpose: the job is a real process writing every 0.2 s; three periods without growth.
  await sleep(600);
  assert.equal((await fs.stat(heartbeat)).size, sizeAtEnd, 'the job inside tmux ended with its terminal');

  // What was typed, shown and where: none of it in the Puente's or the supervisor's lines.
  const secrets = [PHONE.key, 'contenido-completado', 'archivo-un', 'tras-ctrl-c', 'pega-', project, heartbeat, 'trabajo', 'sleep 300', work, side];
  assertLogsClean(lab.logs, secrets);
  assert.ok(lab.logs.some((line) => line.startsWith('POST /v1/remote/terminals/:id/input 200')), lab.logs.join('\n'));
  for (const line of lab.supervisorOutput) for (const secret of secrets) assert.ok(!line.includes(secret), line);
});
