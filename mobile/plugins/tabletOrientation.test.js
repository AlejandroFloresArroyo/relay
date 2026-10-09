const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../app.json');

test('the native build allows orientation changes instead of locking tablets to portrait', () => {
  assert.equal(config.expo.orientation, 'default');
});
