// Acceptance, scenario 2 of docs/relay-v3.md §7: locking and disconnecting never send Ctrl-C nor lose
// work; revoking cuts every channel and ends the device's own environments while shared work stays.
// Real supervisor process, systemd scopes, node-pty, bash, tmux, a dedicated browser when the machine
// has one, the files transfer and the web listener (support/acceptance_lab.ts). What the app does on
// lock (closing its accesses with `suspended`) is RemoteAccess.component.test.tsx's; here the Puente
// and the supervisor see exactly that: streams that close. The habitual browser's tabs surviving a
// revocation are scenario 5's (browsers.test.ts). Details: remoteTerminal.test.ts, remoteEnvironments.test.ts,
// remoteFilesHttp.test.ts, remoteWeb.test.ts.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import type { TerminalStreamEvent } from '../../../protocol/remoteTerminal.ts';
import { WEB_ACCESS_CODE_PATTERN, WEB_PENDING_COOKIE, WEB_SESSION_COOKIE } from '../../../protocol/remoteWeb.ts';
import { acceptanceLab, assertLogsClean, labBrowser, PHONE, SKIP, TABLET, until, type OutputStream } from '../../support/acceptance_lab.ts';
import { stream as webStream, web } from '../../support/fake_web.ts';

const run = promisify(execFile);
const text = (stream: OutputStream) => stream.bytes().toString('utf8');
const shows = (stream: OutputStream, marker: string, what: string) => until(() => text(stream).includes(marker), what, 20_000);
const lines = async (file: string) => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
const outputs = (stream: OutputStream) => stream.events.filter((event): event is Extract<TerminalStreamEvent, { type: 'output' }> => event.type === 'output');
const opened = (stream: OutputStream) => until(() => stream.events.some((event) => event.type === 'open'), 'the stream opened', 20_000);

test('scenario 2a: locking and losing the connection send no Ctrl-C and lose nothing; the ring overflowing is a visible gap; a revocation while the Puente is down ends the terminals at its next start', { skip: SKIP, timeout: 180_000 }, async (t) => {
  const lab = await acceptanceLab(t);
  const home = lab.dirs.home;
  const marker = path.join(home, 'senal');
  const heartbeat = path.join(home, 'latido');
  // A program that would notice any signal the lock or the loss of connection sent, and that writes all the time.
  await fs.writeFile(path.join(home, 'guardia.sh'), [
    `trap 'echo INT >> ${marker}' INT`, `trap 'echo HUP >> ${marker}' HUP`, `trap 'echo TERM >> ${marker}' TERM`,
    'i=0', `while :; do i=$((i+1)); echo "pulso-$i"; echo "$i" >> ${heartbeat}; sleep 0.2; done`, '',
  ].join('\n'));
  let puente = await lab.puente();
  const guard = await puente.openTerminal(PHONE, 'acc-lock-guard');
  const first = await puente.output(PHONE, guard);
  await opened(first);
  await puente.type(PHONE, guard, 'bash guardia.sh\r');
  await shows(first, 'pulso-3', 'the program writes');

  // Lock: the app closes its stream, nothing else. The program goes on.
  const seenAtLock = first.lastSeq();
  first.close();
  await first.ended;
  const atLock = await lines(heartbeat);
  await until(async () => await lines(heartbeat) >= atLock + 5, 'the program keeps writing while locked', 20_000);
  const afterLock = await puente.output(PHONE, guard, String(seenAtLock));
  await opened(afterLock);
  const reopened = afterLock.events.find((event) => event.type === 'open');
  assert.ok(reopened?.type === 'open' && 'inputSeq' in reopened);
  assert.equal(reopened.inputSeq, 1, 'nothing was typed for the app: no Ctrl-C');
  await until(() => outputs(afterLock).length > 0, 'output resumes', 20_000);
  assert.equal(outputs(afterLock)[0]!.seq, seenAtLock + 1, 'resumes right after the last seq the app held');

  // Connection lost: the Puente itself goes (its streams and its supervisor channel), then comes back.
  const seenAtLoss = afterLock.lastSeq();
  puente.close();
  const atLoss = await lines(heartbeat);
  await until(async () => await lines(heartbeat) >= atLoss + 5, 'the program keeps writing with no Puente', 20_000);
  puente = await lab.puente();
  await until(async () => (await puente.call(PHONE, 'GET', '/v1/remote/environments')).status === 200, 'the new Puente reaches the supervisor', 20_000);
  const afterLoss = await puente.output(PHONE, guard, String(seenAtLoss));
  await opened(afterLoss);
  const atReopen = await lines(heartbeat);
  await shows(afterLoss, `pulso-${atReopen + 2}\r\n`, 'output catches up past what was written meanwhile');
  const back = afterLoss.events.find((event) => event.type === 'open');
  assert.ok(back?.type === 'open' && 'inputSeq' in back && back.inputSeq === 1, 'still nothing typed');
  for (const stream of [afterLock, afterLoss]) assert.ok(!stream.events.some((event) => event.type === 'gap'), 'the ring held everything: no gap');
  // Every beat, in order, across the three streams: nothing lost, nothing repeated.
  const beats = [...(text(first) + text(afterLock) + text(afterLoss)).matchAll(/pulso-(\d+)\r\n/g)].map((match) => Number(match[1]));
  assert.deepEqual(beats, beats.map((_, index) => beats[0]! + index), 'the beats are contiguous');
  assert.ok(beats[0]! <= 3 && beats.at(-1)! >= atReopen, `from the start to past the reopening: ${beats[0]}..${beats.at(-1)}`);
  assert.equal(await fs.access(marker).then(() => true, () => false), false, 'no INT, HUP nor TERM reached the program');
  assert.equal((await puente.list(PHONE)).find((environment) => environment.id === guard)?.state, 'running');

  // With no channel the ring keeps the newest 2 MiB: what it dropped arrives as a gap, never as continuity.
  const noise = await puente.openTerminal(PHONE, 'acc-lock-noise');
  const go = path.join(home, 'adelante');
  const done = path.join(home, 'hecho');
  const watching = await puente.output(PHONE, noise);
  await opened(watching);
  await puente.type(PHONE, noise, `until [ -e ${go} ]; do sleep 0.1; done; head -c 3000000 /dev/zero | tr '\\0' x; echo; echo "fin-$((6*7))"; touch ${done}\r`);
  await shows(watching, 'until [', 'the command was echoed');
  const seenBeforeFlood = watching.lastSeq();
  watching.close();
  await watching.ended;
  await fs.writeFile(go, '');
  await until(() => fs.access(done).then(() => true, () => false), 'the flood was written with no channel', 30_000);
  const flooded = await puente.output(PHONE, noise, String(seenBeforeFlood));
  let acked = 0;
  await until(async () => {
    // The app acks what it received, so the window lets the ring through.
    if (flooded.lastSeq() > acked && flooded.channel()) { acked = flooded.lastSeq(); await puente.ack(PHONE, noise, flooded.channel(), acked); }
    return Buffer.concat(outputs(flooded).slice(-4).map((event) => Buffer.from(event.data, 'base64'))).toString().includes('fin-42');
  }, 'the ring arrives after the gap', 30_000);
  const gapAt = flooded.events.findIndex((event) => event.type === 'gap');
  const gap = flooded.events[gapAt];
  assert.ok(gap?.type === 'gap', 'the lost range is visible');
  assert.equal(gap.from, seenBeforeFlood + 1, 'the gap starts right after what the app held');
  assert.ok(flooded.events.slice(0, gapAt).every((event) => event.type === 'open'), 'the gap comes before any output');
  const kept = outputs(flooded).reduce((sum, event) => sum + Buffer.from(event.data, 'base64').length, 0);
  assert.ok(kept <= REMOTE_LIMITS.terminalRingBytes + 65_536 * 2 && kept < 3_000_000, `only the ring came back (${kept} bytes)`);
  flooded.close();

  // Revoked while no Puente runs: the next one reconciles and ends the phone's own terminals.
  puente.close();
  await lab.revoke(PHONE);
  puente = await lab.puente();
  for (const id of [guard, noise]) await until(async () => (await lab.scopeProcs(id)).length === 0, 'the reconciliation ended the terminal', 30_000);
  await until(async () => (await puente.client.list()).filter((environment) => [guard, noise].includes(environment.id)).every((environment) => environment.state === 'exited'), 'both exited', 30_000);
  assert.deepEqual((await puente.call(PHONE, 'GET', '/v1/remote/environments')).json.error.code, 'device_revoked');
  await until(async () => (await lab.changes()).filter((change) => change.action === 'remote.environment.terminated' && change.actor.kind === 'server').length === 2, 'terminations recorded', 20_000);
  for (const id of [guard, noise]) {
    assert.ok((await lab.changes()).some((change) => change.action === 'remote.environment.terminate_requested' && change.actor.kind === 'server' && change.target.id === id), `terminate_requested by server for ${id}`);
  }

  const secrets = [PHONE.key, TABLET.key, 'pulso-', 'guardia', marker, heartbeat, go, done, 'fin-', guard, noise];
  assertLogsClean(lab.logs, secrets);
  for (const line of lab.supervisorOutput) for (const secret of secrets) assert.ok(!line.includes(secret), line);
});

test('scenario 2b: revoking cuts every channel at once, ends own environments and keeps shared work; another device is untouched', { skip: SKIP, timeout: 180_000 }, async (t) => {
  const browserProgram = await labBrowser();
  const lab = await acceptanceLab(t, { browser: browserProgram });
  const home = lab.dirs.home;
  const tmuxEnv = { ...process.env, HOME: home, TMUX_TMPDIR: lab.dirs.tmux };
  const tmux = (...args: string[]) => run('tmux', ['-L', 'shared', ...args], { env: tmuxEnv });
  // Work the person started outside Relay: a tmux server with a job.
  const sharedBeat = path.join(home, 'latido-compartido');
  await tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'compartida', `sh -c 'while :; do echo x >> ${sharedBeat}; sleep 0.2; done'`);
  // Before the lab removes its directories, where the tmux socket lives.
  lab.closers.push(() => tmux('kill-server').then(() => {}, () => {}));
  const puente = await lab.puente();

  // The phone: a terminal attached to the shared tmux, a dedicated browser with frames, an upload half
  // sent, a download half read and an external web authorization with an open SSE stream.
  const term = await puente.openTerminal(PHONE, 'acc-revoke-term');
  const termOut = await puente.output(PHONE, term);
  await opened(termOut);
  await puente.type(PHONE, term, 'tmux -L shared attach -t compartida\r');
  await shows(termOut, '\x1b[?1049h', 'attached to the shared tmux');
  await until(async () => (await tmux('list-clients', '-t', 'compartida')).stdout.trim().split('\n').filter(Boolean).length === 1, 'one client attached', 20_000);

  let browserId: string | null = null;
  let frames: OutputStream | null = null;
  if (browserProgram) {
    const created = await puente.call(PHONE, 'POST', '/v1/remote/environments', { requestId: 'acc-revoke-browser', kind: 'browser_dedicated' });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    browserId = created.json.id as string;
    await until(async () => (await puente.browser(PHONE, 'GET', `${browserId}/tabs`)).status === 200, 'the browser answers', 30_000);
    frames = await puente.frames(PHONE, browserId);
    assert.equal(frames.status, 200);
    await opened(frames);
  } else t.diagnostic('no dedicated browser program on this machine: the browser part is skipped');

  const files = puente.headers(PHONE, 'files/1');
  const chunk = REMOTE_LIMITS.transferChunkBytes;
  const json = { ...files, 'Content-Type': 'application/json' };
  const upload = await (await fetch(`${puente.base}/v1/remote/files/uploads`, { method: 'POST', headers: json, body: JSON.stringify({ directory: home, name: 'subida-secreta.bin', size: chunk * 2 }) })).json();
  const firstChunk = await fetch(`${puente.base}/v1/remote/files/uploads/${upload.id}/0`, { method: 'PUT', headers: { ...files, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(Buffer.alloc(chunk, 'a')) });
  assert.equal(firstChunk.status, 200);
  await firstChunk.arrayBuffer();
  assert.equal((await fs.readdir(home)).filter((name) => name.startsWith('.relay-upload-')).length, 1, 'the upload fills its temporary file');
  const source = path.join(home, 'descarga-secreta.bin');
  await fs.writeFile(source, Buffer.alloc(chunk * 2, 'b'));
  const download = await (await fetch(`${puente.base}/v1/remote/files/downloads`, { method: 'POST', headers: json, body: JSON.stringify({ path: source }) })).json();
  const read = await fetch(`${puente.base}/v1/remote/files/downloads/${download.id}/0`, { headers: files });
  assert.equal(read.status, 200);
  const halfRead = Buffer.from(await read.arrayBuffer()).length;

  // A local app of the person: its own process, since discovery never offers the Puente's own sockets.
  const appProcess = spawn(process.execPath, ['-e', `
    const server = require('node:http').createServer((req, res) => {
      if (req.url !== '/sse') return res.end('ok');
      res.writeHead(200, { 'content-type': 'text/event-stream' }).write('data: uno\\n\\n');
      res.on('close', () => console.log('upstream-closed'));
    });
    server.listen(0, '127.0.0.1', () => console.log('port ' + server.address().port));`], { cwd: home, stdio: ['ignore', 'pipe', 'inherit'] });
  lab.closers.push(() => { appProcess.kill(); });
  let appOutput = '';
  appProcess.stdout!.setEncoding('utf8').on('data', (chunk: string) => { appOutput += chunk; });
  await until(() => /port \d+/.test(appOutput), 'the local app listens', 20_000);
  const appPort = Number(/port (\d+)/.exec(appOutput)![1]);
  const registered = await puente.call(PHONE, 'POST', '/v1/remote/web/apps', { requestId: 'acc-revoke-web-0001', name: 'App', address: '127.0.0.1', port: appPort }, 'web/1');
  assert.equal(registered.status, 200, JSON.stringify(registered.json));
  const app: { id: string; origin: string } = registered.json;
  const listener = lab.publisher.services.get(new URL(app.origin).hostname.split('.')[0]!)!;
  const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document', accept: 'text/html' };
  const cookieOf = (response: { headers: { 'set-cookie'?: string[] } }, name: string) => ([] as string[]).concat(response.headers['set-cookie'] ?? []).find((line) => line.startsWith(`${name}=`))?.split(';')[0];
  const page = await web(listener, app.origin, 'GET', '/', nav);
  const code = new RegExp(WEB_ACCESS_CODE_PATTERN.slice(1, -1)).exec(page.text)![0];
  const pending = cookieOf(page, WEB_PENDING_COOKIE)!;
  const requests: { id: string; code: string }[] = (await puente.call(PHONE, 'GET', `/v1/remote/web/apps/${app.id}/authorizations`, undefined, 'web/1')).json.requests;
  const granted = await puente.call(PHONE, 'POST', `/v1/remote/web/apps/${app.id}/authorizations`, { request: requests.find((request) => request.code === code)!.id, code }, 'web/1');
  assert.equal(granted.status, 200, JSON.stringify(granted.json));
  const session = cookieOf(await web(listener, app.origin, 'GET', '/', { ...nav, cookie: pending }), WEB_SESSION_COOKIE)!;
  const own = { origin: app.origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie: session };
  const sse = await webStream(listener, app.origin, '/sse', own);
  assert.equal(sse.status, 200);
  await sse.first;

  // The tablet's own terminal, alongside.
  const tabletTerm = await puente.openTerminal(TABLET, 'acc-revoke-tablet');
  const tabletOut = await puente.output(TABLET, tabletTerm);
  await opened(tabletOut);

  const sharedAtRevoke = await lines(sharedBeat);
  await lab.revoke(PHONE);

  // Every open stream of the phone ends.
  const open = { terminal: termOut, web: sse, ...(frames && { frames }) };
  const ended: string[] = [];
  for (const [name, stream] of Object.entries(open)) void stream.ended.then(() => ended.push(name));
  await until(() => ended.length === Object.keys(open).length, `every stream of the phone ended (ended: ${ended})`, 20_000);
  await until(() => appOutput.includes('upstream-closed'), 'the proxied SSE was cut on the app side too', 20_000);
  // Every new request of the phone: 403 device_revoked, whatever the tool. A refused key is a failed
  // attempt of its IP (ADR 0001), and here both devices share 100.64.0.1: the tablet's successful
  // request every three clears the count, as a phone with its own tailnet address never needs.
  const stream = async (opening: Promise<OutputStream>) => { const answer = await opening; return { status: answer.status, code: answer.json?.error.code }; };
  const raw = async (answering: Promise<Response>) => { const answer = await answering; return { status: answer.status, code: (await answer.json()).error.code }; };
  const control = async (answering: Promise<{ status: number; json: { error?: { code: string } } }>) => { const answer = await answering; return { status: answer.status, code: answer.json?.error?.code }; };
  type Attempt = [string, () => Promise<{ status: number; code: string | undefined }>];
  const browserAttempts: Attempt[] = browserId === null ? [] : [
    ['browser tabs', () => control(puente.browser(PHONE, 'GET', `${browserId}/tabs`))],
    ['browser frames', () => stream(puente.frames(PHONE, browserId!))],
  ];
  const attempts: Attempt[] = [
    ['environments', () => control(puente.call(PHONE, 'GET', '/v1/remote/environments'))],
    ['terminal input', () => control(puente.call(PHONE, 'POST', `/v1/remote/terminals/${term}/input`, { seq: 2, data: Buffer.from('x').toString('base64') }, 'terminal/1'))],
    ['terminal output', () => stream(puente.output(PHONE, term))],
    ['web authorizations', () => control(puente.call(PHONE, 'GET', `/v1/remote/web/apps/${app.id}/authorizations`, undefined, 'web/1'))],
    ['files list', () => control(puente.call(PHONE, 'POST', '/v1/remote/files/list', { path: home }, 'files/1'))],
    ['upload chunk', () => raw(fetch(`${puente.base}/v1/remote/files/uploads/${upload.id}/${chunk}`, { method: 'PUT', headers: { ...files, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(Buffer.alloc(chunk, 'a')) }))],
    ['upload commit', () => raw(fetch(`${puente.base}/v1/remote/files/uploads/${upload.id}/commit`, { method: 'POST', headers: json, body: '{}' }))],
    ['download chunk', () => raw(fetch(`${puente.base}/v1/remote/files/downloads/${download.id}/${halfRead}`, { headers: files }))],
    ...browserAttempts,
  ];
  for (const [index, [what, attempt]] of attempts.entries()) {
    assert.deepEqual(await attempt(), { status: 403, code: 'device_revoked' }, what);
    if (index % 3 === 2) assert.equal((await puente.call(TABLET, 'GET', '/v1/remote/environments')).status, 200);
  }
  assert.equal((await web(listener, app.origin, 'GET', '/', own)).status, 401, 'the external authorization ended');

  // Own environments end: empty scopes, exited, terminated by the server.
  const mine = [term, ...(browserId ? [browserId] : [])];
  for (const id of mine) await until(async () => (await lab.scopeProcs(id)).length === 0, `the scope of ${id} is empty`, 30_000);
  await until(async () => (await puente.client.list()).filter((environment) => mine.includes(environment.id)).every((environment) => environment.state === 'exited'), 'own environments exited', 30_000);
  const byServer = async (action: string, id: string) => (await lab.changes()).some((change) => change.action === `remote.environment.${action}` && change.actor.kind === 'server' && change.target.id === id);
  for (const id of mine) await until(() => byServer('terminated', id), `terminated by the server: ${id}`, 20_000);
  for (const id of mine) assert.ok(await byServer('terminate_requested', id), `terminate_requested by the server: ${id}`);
  // The upload never appears and its temporary file is gone.
  const entries = await fs.readdir(home);
  assert.ok(!entries.includes('subida-secreta.bin'), 'the uncommitted upload was never published');
  assert.deepEqual(entries.filter((name) => name.startsWith('.relay-upload-')), [], 'its temporary file is gone');

  // Shared work stays: the tmux server, its session and its job; only the client inside the terminal died.
  assert.match((await tmux('ls')).stdout, /^compartida: 1 windows/m);
  await until(async () => (await tmux('list-clients', '-t', 'compartida')).stdout.trim() === '', 'the client inside the terminal died', 20_000);
  await until(async () => await lines(sharedBeat) >= sharedAtRevoke + 5, 'the shared job keeps running', 20_000);

  // The tablet is untouched: its terminal and its stream keep working.
  assert.ok(!tabletOut.events.some((event) => event.type === 'closed'));
  await puente.type(TABLET, tabletTerm, 'echo "tableta-$((20+1))"\r');
  await shows(tabletOut, 'tableta-21', 'the tablet terminal answers');
  assert.deepEqual((await puente.list(TABLET)).map((environment) => [environment.id, environment.state]), [[tabletTerm, 'running']]);
  tabletOut.close();

  const secrets = [PHONE.key, TABLET.key, 'compartida', sharedBeat, 'subida-secreta', source, 'descarga-secreta', code, pending.split('=')[1]!, session.split('=')[1]!, app.origin, 'tableta-', term, tabletTerm, ...(browserId ? [browserId] : [])];
  assertLogsClean(lab.logs, secrets);
  for (const line of lab.supervisorOutput) for (const secret of secrets) assert.ok(!line.includes(secret), line);
});
