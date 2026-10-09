import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RelayError } from './client.ts';
import { classifyConnectionError, serverConnectionPresentation } from './connectionStatus.ts';
import { openTailscale } from '../state/openTailscale.ts';

test('known connection causes take precedence over generic SIN RESPUESTA', () => {
  for (const [code, label, action] of [
    ['device_revoked', 'DISPOSITIVO REVOCADO', 'pair'],
    ['key_unknown', 'LLAVE RECHAZADA', 'pair'],
    ['unauthorized', 'LLAVE RECHAZADA', 'pair'],
    ['pairing_required', 'EMPAREJAMIENTO NECESARIO', 'pair'],
    ['cleartext_blocked', 'HTTP BLOQUEADO POR ANDROID', 'retry'],
    ['rate_limited', 'DEMASIADOS INTENTOS', 'retry'],
    ['tailnet_required', 'TAILNET NECESARIA', 'tailscale'],
    ['bad_request', 'SOLICITUD RECHAZADA', 'retry'],
  ] as const) {
    const result = classifyConnectionError(new RelayError(code, 'untrusted text'));
    assert.equal(result.label, label);
    assert.equal(result.action, action);
    assert.equal(result.kind, 'known');
    assert.equal(result.automaticRetry, false);
    assert.doesNotMatch(result.hint, /untrusted text|HTTPS|API key|RELAY_KEY/);
  }
});

test('server status owns reachable-with-notice presentation and hides compatible servers', () => {
  const base = { reachable: true, down: null, protocolStale: false };
  assert.equal(serverConnectionPresentation({ ...base, protocol: { kind: 'compatible', bridgeVersion: 1 } }), null);
  assert.equal(serverConnectionPresentation({ ...base, reachable: null, protocol: null }), null);
  for (const protocol of [
    { kind: 'update_bridge', bridgeVersion: 0, message: 'Actualiza el Puente' },
    { kind: 'update_app', bridgeVersion: 3, message: 'Actualiza Relay' },
    { kind: 'invalid', message: 'Respuesta de protocolo inválida' },
  ] as const) {
    const presentation = serverConnectionPresentation({ ...base, protocol });
    assert.equal(presentation?.protocol?.message, protocol.message);
    assert.equal(presentation?.diagnosis, null);
  }
  const offline = serverConnectionPresentation({ ...base, reachable: false, protocol: null });
  assert.equal(offline?.diagnosis?.label, 'SIN RESPUESTA');
  const revoked = classifyConnectionError(new RelayError('device_revoked', 'synthetic'));
  const staleNotice = serverConnectionPresentation({ ...base, reachable: false, down: revoked, protocolStale: true,
    protocol: { kind: 'update_bridge', bridgeVersion: 0, message: 'Actualiza el Puente' } });
  assert.equal(staleNotice?.diagnosis?.label, 'DISPOSITIVO REVOCADO');
  assert.equal(staleNotice?.protocol?.message, 'Actualiza el Puente');
  assert.equal(staleNotice?.stale, true);
});

test('Tailscale launch uses its navigation link and falls back on rejection or web', async () => {
  const urls: string[] = [];
  assert.equal(await openTailscale({ platform: 'android', openURL: async (url) => { urls.push(url); } }), true);
  assert.deepEqual(urls, ['tailscale://navigate']);
  assert.equal(await openTailscale({ platform: 'android', openURL: async () => { throw new Error('blocked'); } }), false);
  assert.equal(await openTailscale({ platform: 'web', openURL: async () => { assert.fail('must not launch on web'); } }), false);
});

test('unknown failures and timeouts give both hints without claiming a cause', () => {
  for (const error of [new RelayError('timeout', 'x'), new RelayError('unreachable', 'x'), new TypeError('x')]) {
    const result = classifyConnectionError(error);
    assert.equal(result.label, 'SIN RESPUESTA');
    assert.match(result.hint, /Tailscale esté encendido en este teléfono/);
    assert.match(result.hint, /máquina esté encendida con el Puente corriendo/);
    assert.equal(result.kind, 'unreachable');
  }
});
