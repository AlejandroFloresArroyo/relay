import assert from 'node:assert/strict';
import test from 'node:test';
import { tailnetName } from './tailnet.ts';

test('the tailnet is named after the first Servidor host under ts.net', () => {
  assert.equal(tailnetName(['http://atlas.tailnet-7f2c.ts.net:8650', 'http://nas.other.ts.net']), 'TAILNET-7F2C');
  assert.equal(tailnetName(['http://100.64.0.1:8650', 'https://b.fixture.ts.net:17651']), 'FIXTURE');
  assert.equal(tailnetName(['http://100.64.0.1:8650', 'not a url']), null);
  assert.equal(tailnetName([]), null);
});
