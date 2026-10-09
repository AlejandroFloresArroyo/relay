const { test } = require('node:test');
const assert = require('node:assert/strict');
const { silenceSpeechLogs } = require('./withDictationPrivacy');
const fixture = `class Speech {
    private fun log(message: String) {
        Log.d("ExpoSpeechService", message)
    }
    fun partial() { log("onPartialResults(), results: $nonEmptyStrings") }
    fun final() { log("onResults(), results: $resultsList") }
    fun segment() { log("onSegmentResults(), transcriptions: $resultsList") }
}`;
test('CNG removes native transcript logging for locked version 57.1.0 and is idempotent', () => {
  const output = silenceSpeechLogs(fixture, '57.1.0');
  assert.ok(!output.includes('Log.d("ExpoSpeechService", message)'));
  assert.equal(silenceSpeechLogs(output, '57.1.0'), output);
});
test('an incompatible native source or dependency version fails closed without echoing source', () => {
  for (const [source, version] of [[fixture, '57.2.0'], ['PRIVATE TRANSCRIPT', '57.1.0'], [fixture.replace('Log.d', 'Log.i'), '57.1.0']]) {
    assert.throws(() => silenceSpeechLogs(source, version), (error) => !error.message.includes('PRIVATE TRANSCRIPT') && error.message.includes('privacy'));
  }
});

test('the installed locked native source is supported without modifying the dependency', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const directory = path.dirname(require.resolve('expo-speech-recognition/package.json'));
  const source = fs.readFileSync(path.join(directory, 'android/src/main/java/expo/modules/speechrecognition/ExpoSpeechService.kt'), 'utf8');
  const { version } = require('expo-speech-recognition/package.json');
  assert.ok(!/\bLog\.[vdiew]\s*\(/.test(silenceSpeechLogs(source, version)));
});
