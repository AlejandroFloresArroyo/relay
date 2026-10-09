// Synthetic TLS material for the lab. Lives in a temporary directory (or the viewer's ignored
// .lab-cert); nothing is added to any trust store. Clients trust it per connection (`ca` in
// Node, SPKI pin flag in a throwaway Chromium profile, network security config of the lab APK).
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type LabCert = { cert: string; key: string; spki: string };

export function certFromPem(cert: string, key: string): LabCert {
  const der = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' });
  return { cert, key, spki: createHash('sha256').update(der).digest('base64') };
}

export function makeCert(names: string[]): LabCert {
  const dir = mkdtempSync(join(tmpdir(), 'relay-lab-cert-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '30',
      '-subj', '/CN=relay-lab', '-addext', `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}`,
    ], { stdio: 'ignore' });
    return certFromPem(readFileSync(join(dir, 'cert.pem'), 'utf8'), readFileSync(join(dir, 'key.pem'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
