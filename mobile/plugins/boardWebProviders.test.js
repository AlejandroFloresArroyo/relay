const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

test('verified board web provider registry stays empty', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/relay-board-web/android/src/main/java/relay/boardweb/VerifiedBoardWebProviders.kt'), 'utf8');
  assert.match(source, /val records: List<Record> = emptyList\(\)/,
    'Only Root may add a board web provider, and only with full zero-egress native matrix evidence.');
});
