import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDotenv } from '../src/util/dotenv.ts';
import { redact } from '../src/util/redact.ts';
import { yamlGet } from '../src/util/yaml.ts';
import { parseSse } from '../src/sse.ts';

test('parseDotenv reads plain, quoted and exported values and skips comments', () => {
  const env = parseDotenv(
    [
      '# a comment',
      'PLAIN=value',
      'export EXPORTED=yes',
      'DOUBLE="with spaces"',
      "SINGLE='single # not a comment'",
      'TRAILING=abc # comment',
      'EMPTY=',
      '   ',
      '#API_SERVER_KEY=commented-out',
      'WITH_EQUALS=a=b',
    ].join('\n'),
  );
  assert.deepEqual(env, {
    PLAIN: 'value',
    EXPORTED: 'yes',
    DOUBLE: 'with spaces',
    SINGLE: 'single # not a comment',
    TRAILING: 'abc',
    EMPTY: '',
    WITH_EQUALS: 'a=b',
  });
});

const YAML = `
# comment
model:
  default: deepseek-v4.1-flash
  provider: "opencode-go"   # trailing comment
  aliases:
    builder: opencode-go/deepseek-v4.1-flash
gateway:
  multiplex_profiles: true
approvals:
  timeout: 120
platforms:
  api_server:
    extra:
      port: 9000
models:
  default: not-this-one
tts:
  edge:
    voice: 'es-MX-DaliaNeural'
`;

test('yamlGet walks nested mappings', () => {
  assert.equal(yamlGet(YAML, ['model', 'default']), 'deepseek-v4.1-flash');
  assert.equal(yamlGet(YAML, ['model', 'provider']), 'opencode-go');
  assert.equal(yamlGet(YAML, ['model', 'aliases', 'builder']), 'opencode-go/deepseek-v4.1-flash');
  assert.equal(yamlGet(YAML, ['gateway', 'multiplex_profiles']), 'true');
  assert.equal(yamlGet(YAML, ['approvals', 'timeout']), '120');
  assert.equal(yamlGet(YAML, ['platforms', 'api_server', 'extra', 'port']), '9000');
  assert.equal(yamlGet(YAML, ['tts', 'edge', 'voice']), 'es-MX-DaliaNeural');
});

test('yamlGet returns null for a missing key, a mapping, or a key at the wrong depth', () => {
  assert.equal(yamlGet(YAML, ['model', 'missing']), null);
  assert.equal(yamlGet(YAML, ['missing', 'default']), null);
  assert.equal(yamlGet(YAML, ['model']), null); // a mapping has no scalar value
  assert.equal(yamlGet(YAML, ['builder']), null); // only exists nested
  assert.equal(yamlGet(YAML, ['model', 'builder']), null);
});

test('redact masks things that look like credentials', () => {
  const text = [
    'calling with Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    'key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234 loaded',
    'API_SERVER_KEY=supersecretvalue123456',
    'token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"',
    'nothing secret here: PORT=8642',
  ].join('\n');
  const out = redact(text);
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(!out.includes('sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234'));
  assert.ok(!out.includes('supersecretvalue123456'));
  assert.ok(!out.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'));
  assert.ok(out.includes('PORT=8642'));
  assert.ok(out.includes('API_SERVER_KEY='));
});

// #26 enumerated these credential and personal-data classes. Fake values are assembled at runtime so no
// literal in the repo looks like a live credential to a secret scanner.
const fake = (alphabet: string, length: number) => alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJmYWtlLXVzZXIifQ', fake('Zk4kZQ', 43)].join('.');
const discordBot = [`M${fake('TIzNDU2Nzg5', 25)}`, 'GaBcDe', fake('fakeDiscordSig_', 38)].join('.');
const redactionClasses: { name: string; line: string; secrets: string[]; keep?: string }[] = [
  { name: 'Authorization: Basic', line: `Authorization: Basic ${fake('dXNlcjpwYXNz', 24)}`, secrets: [fake('dXNlcjpwYXNz', 24)], keep: 'Authorization:' },
  { name: 'Authorization without scheme', line: 'authorization=fakeschemelessvalue', secrets: ['fakeschemelessvalue'] },
  { name: 'Cookie header', line: 'Cookie: session=fakesessioncookie; theme=dark', secrets: ['fakesessioncookie'] },
  { name: 'short Bearer token', line: 'sent Bearer abc to upstream', secrets: ['abc'], keep: 'to upstream' },
  { name: 'JWT without a key', line: `decoded ${jwt} for request`, secrets: [jwt.split('.')[1], jwt.split('.')[2]], keep: 'for request' },
  { name: 'Discord bot token without a key', line: `login with ${discordBot} ok`, secrets: [discordBot.split('.')[0], discordBot.split('.')[2]], keep: 'ok' },
  { name: 'Telegram bot token', line: `bot ${'1234567'}:${fake('AAfakeTelegram-_', 35)} started`, secrets: [fake('AAfakeTelegram-_', 35)], keep: 'started' },
  { name: 'AWS access key id', line: `using ${'AKIA'}${fake('FAKEKEY0', 16)}`, secrets: [fake('FAKEKEY0', 16)] },
  { name: 'Google API key', line: `maps ${'AIza'}${fake('FakeGoogle_-0', 35)}`, secrets: [fake('FakeGoogle_-0', 35)] },
  { name: 'password inside a URL', line: 'GET https://user:fakeurlpassword@example.invalid/path', secrets: ['fakeurlpassword'], keep: 'example.invalid/path' },
  { name: 'private key body', line: `-----BEGIN PRIVATE KEY-----\n${fake('MIIEfake', 64)}\n-----END PRIVATE KEY-----`, secrets: [fake('MIIEfake', 64)] },
  {
    name: 'lowercase compound keys',
    line: 'access_token=fakeaccess refresh_token=fakerefresh client_secret=fakeclient bot_token=fakebot',
    secrets: ['fakeaccess', 'fakerefresh', 'fakeclient', 'fakebot'],
  },
  { name: 'values shorter than six characters', line: 'password=abc token: xy', secrets: ['abc', 'xy'] },
  { name: 'quoted values with spaces', line: 'password: "fake pass phrase" next', secrets: ['fake pass phrase', 'phrase'], keep: 'next' },
  {
    name: 'Discord channel and user IDs',
    line: "Ignoring message in non-allowed channel: {'123456789012345678'} user=987654321098765432 <@1098765432109876543> guild 12345678901234567",
    secrets: ['123456789012345678', '987654321098765432', '1098765432109876543', '12345678901234567'],
    keep: 'non-allowed channel',
  },
  {
    name: 'Discord webhook URL',
    line: `POST https://discord.com/api/webhooks/1234567890123456789/${fake('fakeWebhookTok_-', 68)} failed`,
    secrets: [fake('fakeWebhookTok_-', 68)],
    keep: 'failed',
  },
  {
    name: 'Slack webhook URL',
    line: `POST https://hooks.slack.com/services/T0FAKE000/B0FAKE000/${fake('fakeSlackSecret0', 24)} failed`,
    secrets: [fake('fakeSlackSecret0', 24)],
    keep: 'failed',
  },
  { name: 'Hugging Face token', line: `hub login ${'hf_'}${fake('fakeHuggingFace0', 34)} ok`, secrets: [fake('fakeHuggingFace0', 34)], keep: 'ok' },
  { name: 'npm token', line: `registry auth ${'npm_'}${fake('fakeNpmToken0123', 36)} ok`, secrets: [fake('fakeNpmToken0123', 36)], keep: 'ok' },
  { name: 'Google OAuth access token', line: `oauth ${'ya29.'}${fake('fakeGoogleOAuth_-', 60)} ok`, secrets: [fake('fakeGoogleOAuth_-', 60)], keep: 'ok' },
];
for (const { name, line, secrets, keep } of redactionClasses) {
  test(`redact masks ${name}`, () => {
    const out = redact(line);
    for (const secret of secrets) assert.ok(!out.includes(secret), `${name} leaked: ${out}`);
    if (keep) assert.ok(out.includes(keep), `${name} lost context: ${out}`);
  });
}

test('redact keeps ordinary numbers, timestamps and short ids readable', () => {
  const line = '2026-10-05 12:00:01,123 INFO run 1759665601123 took 4500ms pid=12345 trace 1234567890123456 session 20261005_120001_abc123';
  assert.equal(redact(line), line);
});

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) yield encoder.encode(part);
}

async function collect(stream: AsyncIterable<Uint8Array>) {
  const out = [];
  for await (const frame of parseSse(stream)) out.push(frame);
  return out;
}

test('parseSse yields one frame per event, ignoring comments and keepalives', async () => {
  const frames = await collect(
    chunks(': open\n\n', 'id: 0\ndata: {"a":1}\n\n', ': keepalive\n\n', 'id: 1\nevent: x\ndata: {"b":2}\n\n'),
  );
  assert.deepEqual(frames, [
    { id: '0', event: null, data: '{"a":1}' },
    { id: '1', event: 'x', data: '{"b":2}' },
  ]);
});

test('parseSse reassembles frames split across chunks, including inside a multibyte character', async () => {
  const bytes = new TextEncoder().encode('id: 7\ndata: {"t":"ñandú"}\n\n');
  const cut = bytes.indexOf(0xc3) + 1; // in the middle of "ñ"
  async function* split(): AsyncGenerator<Uint8Array> {
    yield bytes.slice(0, cut);
    yield bytes.slice(cut);
  }
  assert.deepEqual(await collect(split()), [{ id: '7', event: null, data: '{"t":"ñandú"}' }]);
});

test('parseSse joins multi-line data and accepts CRLF', async () => {
  const frames = await collect(chunks('data: one\r\ndata: two\r\n\r\n'));
  assert.deepEqual(frames, [{ id: null, event: null, data: 'one\ntwo' }]);
});


test('redact consumes recognized quoted values with multiline content and escaped delimiters', () => {
  for (const key of ['client_secret', 'clientSecret', 'SESSIONTOKEN', 'Authorization', 'Cookie', 'X-API-Key']) {
    for (const value of [String.raw`"first\\piece\"quoted
last"`, String.raw`'first\'quoted
last'`, '"unfinished\nlast']) {
      const out = redact(`${key}=${value}`);
      assert.equal(out, `${key}=***`);
    }
  }
  assert.equal(redact('{"clientSecret":"first\nlast", "model":"synthetic"}'), '{"clientSecret":***, "model":"synthetic"}');
  assert.equal(redact('monkey="first\nlast"'), 'monkey="first\nlast"');
});


test('redact keeps escape boundaries intact when credentials contain query parameters or a truncated escape', () => {
  assert.equal(redact(String.raw`clientSecret="https://example.invalid/?token=first\"quoted
last" safe=yes`), 'clientSecret=*** safe=yes');
  assert.equal(redact('client_secret="first\nlast' + String.fromCharCode(92)), 'client_secret=***');
});
