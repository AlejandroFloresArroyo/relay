import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { demoBoardWebBundle, demoBoardWebPreview } from './demoBoardWeb.ts';
import { canonicalBoardWebManifest } from '../../../protocol/boardWebValidation.ts';
import { boardWebBase64 } from './boardWeb.ts';
test('demo is a complete immutable synthetic bundle whose revision and native input hashes match', () => {
  const bundle = demoBoardWebBundle();
  assert.equal(createHash('sha256').update(canonicalBoardWebManifest(bundle.manifest)).digest('hex'), bundle.revision);
  for (const asset of bundle.assets) {
    const file = bundle.manifest.files.find(file => file.name === asset.name)!;
    assert.equal(createHash('sha256').update(asset.bytes).digest('hex'), file.sha256); assert.equal(asset.bytes.length, file.bytes);
    assert.deepEqual(Buffer.from(boardWebBase64(asset.bytes), 'base64'), Buffer.from(asset.bytes));
  }
  assert.deepEqual(demoBoardWebPreview('web-offline'), { phase: 'offline', message: 'Contenido web no disponible sin conexión. Solo se conserva la información de la Tarjeta.' });
  assert.equal(demoBoardWebPreview('web'), null);
});
