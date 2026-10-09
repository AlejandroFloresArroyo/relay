import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeClient } from './bridgeClient.ts';
import { CHAT_PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../../protocol/protocol.ts';
import type { AppUpdateManifest } from '../../../protocol/appUpdate.ts';
const artifact = { applicationId: 'io.fixture.relay', versionCode: 4, versionName: '1.3.0', byteLength: 4, sha256: 'a'.repeat(64), signerSha256: 'b'.repeat(64), builtAtMs: 1700000000000, sourceCommit: 'c'.repeat(40) };
const published = { state: 'published', revision: 'd'.repeat(64), artifact };
test('APK metadata uses the paired protocol transport, requires a strong revision and never turns a manifest into local verification', async () => {
  let headers = new Headers(); let observed = '';
  const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async (url, init) => { observed = String(url); headers = new Headers(init?.headers); return new Response(JSON.stringify(published), { headers: { ETag: '"' + published.revision + '"', 'Cache-Control': 'no-store' } }); }) as typeof fetch });
  const read = (client as unknown as { appUpdate?: () => Promise<AppUpdateManifest> }).appUpdate;
  assert.equal(typeof read, 'function', 'The real client must expose the APK metadata endpoint');
  const result = await read!(); assert.deepEqual(result, published);
  assert.equal(observed, 'http://apk.fixture.ts.net:17651/v1/app-update');
  assert.equal(headers.get(CHAT_PROTOCOL_HEADER), String(PROTOCOL_VERSION)); assert.equal(headers.get('Authorization'), 'Bearer synthetic-key');
  assert.ok(!('verified' in result));
});

test('APK transfer is gesture-driven, pins If-Match, refuses redirects and streams bounded chunks with progress', async () => {
  const chunks: number[][] = []; const progress: number[] = []; let observed = ''; let headers = new Headers(); let redirect: RequestRedirect | undefined;
  const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async (url, init) => { observed = String(url); headers = new Headers(init?.headers); redirect = init?.redirect; return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { ETag: '"' + published.revision + '"', 'Content-Length': '4', 'Content-Type': 'application/vnd.android.package-archive', 'Cache-Control': 'no-store' } }); }) as typeof fetch });
  const download = (client as unknown as { downloadAppUpdate?: (manifest: unknown, options: { signal: AbortSignal; writeChunk: (chunk: Uint8Array) => Promise<void>; onProgress: (bytes: number) => void }) => Promise<void> }).downloadAppUpdate;
  assert.equal(typeof download, 'function', 'The paired client must offer the bounded APK stream'); assert.equal(observed, '');
  await download!(published, { signal: new AbortController().signal, writeChunk: async bytes => { chunks.push([...bytes]); }, onProgress: bytes => progress.push(bytes) });
  assert.equal(observed, 'http://apk.fixture.ts.net:17651/v1/app-update/apk'); assert.equal(headers.get('If-Match'), '"' + published.revision + '"');
  assert.equal(headers.get(CHAT_PROTOCOL_HEADER), String(PROTOCOL_VERSION)); assert.equal(redirect, 'error');
  assert.deepEqual(chunks, [[1, 2, 3, 4]]); assert.deepEqual(progress, [4]);
});

test('cancelling an APK download releases a pending stream read immediately and never writes late bytes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const abort = new AbortController(); let cancelled = 0; let writes = 0; let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => ({ ok: true, status: 200,
    headers: new Headers({ ETag: '"' + published.revision + '"', 'Content-Length': '4', 'Content-Type': 'application/vnd.android.package-archive' }),
    body: { getReader: () => ({ read: () => { entered(); return new Promise(() => {}); }, cancel: async () => { cancelled++; }, releaseLock: () => {} }) },
  })) as unknown as typeof fetch });
  const outcome = client.downloadAppUpdate(published as Extract<AppUpdateManifest, { state: 'published' }>, { signal: abort.signal, writeChunk: async () => { writes++; }, onProgress: () => {} }).then(() => 'success', error => error.code);
  await reading; abort.abort();
  assert.equal(await Promise.race([outcome, new Promise(resolve => setImmediate(() => resolve('still pending')))]), 'cancelled');
  assert.equal(cancelled, 1); assert.equal(writes, 0);
});

test('APK cancellation before headers aborts the authenticated fetch and does not wait for an uncooperative transport', async () => {
  const abort = new AbortController(); let signal: AbortSignal | undefined; let calls = 0;
  const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', fetch: ((_url, init) => { calls++; signal = init?.signal ?? undefined; return new Promise(() => {}); }) as typeof fetch });
  const outcome = client.downloadAppUpdate(published as Extract<AppUpdateManifest, { state: 'published' }>, { signal: abort.signal, writeChunk: async () => {}, onProgress: () => {} }).then(() => 'success', error => error.code);
  abort.abort();
  assert.equal(await Promise.race([outcome, new Promise(resolve => setImmediate(() => resolve('still pending')))]), 'cancelled');
  assert.equal(signal?.aborted, true);
  await assert.rejects(client.downloadAppUpdate(published as Extract<AppUpdateManifest, { state: 'published' }>, { signal: abort.signal, writeChunk: async () => {}, onProgress: () => {} }), { code: 'cancelled' });
  assert.equal(calls, 1);
});

test('APK metadata and transfer preserve only known terminal causes, never response messages', async () => {
  for (const [code, status] of [['device_revoked', 403], ['protocol_upgrade_required', 426]] as const) {
    const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => new Response(JSON.stringify({ error: { code, message: 'private-fixture-diagnostic' } }), { status })) as typeof fetch });
    for (const operation of [() => client.appUpdate(), () => client.downloadAppUpdate(published as Extract<AppUpdateManifest, { state: 'published' }>, { signal: new AbortController().signal, writeChunk: async () => {}, onProgress: () => {} })]) {
      await assert.rejects(operation(), (error: unknown) => { assert.equal((error as { code: string }).code, code); assert.ok(!(error as Error).message.includes('private-fixture-diagnostic')); return true; });
    }
  }
});

test('a response arriving after header cancellation is closed rather than keeping a late APK stream alive', async () => {
  let deliver!: (response: Response) => void; let closed = 0;
  const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', fetch: (() => new Promise<Response>(resolve => { deliver = resolve; })) as typeof fetch });
  const abort = new AbortController();
  const outcome = client.downloadAppUpdate(published as Extract<AppUpdateManifest, { state: 'published' }>, { signal: abort.signal, writeChunk: async () => {}, onProgress: () => {} }).catch(error => error.code);
  abort.abort(); assert.equal(await outcome, 'cancelled');
  deliver(new Response(new ReadableStream({ cancel: () => { closed++; } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 1);
});

test('APK transport rejects an oversized declared artifact before fetch and bounds actual metadata independently of declared length', async () => {
  let calls = 0;
  const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => { calls++; return new Response(' '.repeat(16384) + '{"state":"unpublished"}', { headers: { 'Content-Length': '1' } }); }) as typeof fetch });
  await assert.rejects(client.downloadAppUpdate({ ...published, artifact: { ...artifact, byteLength: 268435457 } } as Extract<AppUpdateManifest, { state: 'published' }>, { signal: new AbortController().signal, writeChunk: async () => {}, onProgress: () => {} }), { code: 'app_update_invalid' });
  assert.equal(calls, 0);
  await assert.rejects(client.appUpdate(), { code: 'app_update_invalid' });
  assert.equal(calls, 1);
});

test('APK stream rejects mismatched MIME/revision/length, truncated or oversized bytes, redirects and partial responses', async () => {
  for (const change of [
    { mime: 'text/plain' }, { etag: 'W/"' + published.revision + '"' }, { etag: '"' + 'e'.repeat(64) + '"' },
    { length: '5' }, { bytes: 3 }, { bytes: 5 }, { redirected: true }, { status: 206 },
  ]) {
    const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => {
      const response = new Response(new Uint8Array(change.bytes ?? 4), { status: change.status ?? 200, headers: { ETag: change.etag ?? '"' + published.revision + '"', 'Content-Type': change.mime ?? 'application/vnd.android.package-archive', 'Content-Length': change.length ?? '4' } });
      if ('redirected' in change) Object.defineProperty(response, 'redirected', { value: true }); return response;
    }) as typeof fetch });
    await assert.rejects(client.downloadAppUpdate(published as Extract<AppUpdateManifest, { state: 'published' }>, { signal: new AbortController().signal, writeChunk: async () => {}, onProgress: () => {} }), { code: 'app_update_invalid' }, JSON.stringify(change));
  }
});

test('APK download splits a large native fetch chunk into at most 64KiB writes without losing bytes or progress', async () => {
  const writes: number[] = []; const progress: number[] = [];
  const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => new Response(new Uint8Array(65537), { headers: { ETag: '"' + published.revision + '"', 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': '65537' } })) as typeof fetch });
  await client.downloadAppUpdate({ ...published, artifact: { ...artifact, byteLength: 65537 } } as Extract<AppUpdateManifest, { state: 'published' }>, { signal: new AbortController().signal, writeChunk: async bytes => { writes.push(bytes.length); }, onProgress: bytes => progress.push(bytes) });
  assert.deepEqual(writes, [65536, 1]); assert.deepEqual(progress, [65536, 65537]);
});

test('APK and metadata body waits expire on their bounded deadlines and cancel the reader', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 });
  for (const kind of ['apk', 'metadata']) {
    let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; }); let cancelled = 0;
    const response = { ok: true, status: 200, headers: new Headers({ ETag: '"' + published.revision + '"', 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': '4' }), body: { getReader: () => ({ read: () => { entered(); return new Promise(() => {}); }, cancel: async () => { cancelled++; }, releaseLock: () => {} }) } } as unknown as Response;
    const client = createBridgeClient({ baseUrl: 'http://apk.fixture.ts.net:17651', key: 'synthetic-key', timeoutMs: 50, fetch: (async () => response) as typeof fetch });
    const outcome = (kind === 'apk' ? client.downloadAppUpdate(published as Extract<AppUpdateManifest, { state: 'published' }>, { signal: new AbortController().signal, writeChunk: async () => {}, onProgress: () => {} }) : client.appUpdate()).catch(error => error.code);
    await reading; t.mock.timers.tick(kind === 'apk' ? 30000 : 50); assert.equal(await outcome, 'timeout'); assert.equal(cancelled, 1);
  }
});
