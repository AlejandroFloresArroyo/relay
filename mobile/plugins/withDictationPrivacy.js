// expo-speech-recognition 57.1.0 logs partial/final transcripts on Android through this
// helper. CNG silences it before compiling the dependency; no generated android file is edited.
const fs = require('node:fs/promises');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');
const ORIGINAL = '    private fun log(message: String) {\n        Log.d("ExpoSpeechService", message)\n    }';
const SILENT = '    private fun log(message: String) {\n        // Relay privacy: never log microphone transcripts.\n    }';
function silenceSpeechLogs(source, version) {
  if (version !== '57.1.0') throw new Error('Relay dictation privacy: review the speech dependency version before building.');
  const original = source.includes(SILENT) ? source.replace(SILENT, ORIGINAL) : source;
  if (original.split(ORIGINAL).length !== 2 || !['onPartialResults(), results:', 'onResults(), results:', 'onSegmentResults(), transcriptions:'].every((marker) => original.includes(marker))) {
    throw new Error('Relay dictation privacy: native logging source changed; review before building.');
  }
  const output = original.replace(ORIGINAL, SILENT).replace('                    Log.d("ExpoSpeechService", "Found service for package $packageName: ${service.serviceInfo.name}")', '                    // Relay privacy: native diagnostic logging is disabled.');
  if (/\bLog\./.test(output)) throw new Error('Relay dictation privacy: an unexpected native log remains; review before building.');
  return output;
}
function withDictationPrivacy(config) {
  return withDangerousMod(config, ['android', async (config) => {
    const packageFile = require.resolve('expo-speech-recognition/package.json', { paths: [config.modRequest.projectRoot] });
    const directory = path.dirname(packageFile);
    const { version } = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    const file = path.join(directory, 'android/src/main/java/expo/modules/speechrecognition/ExpoSpeechService.kt');
    const source = await fs.readFile(file, 'utf8');
    const output = silenceSpeechLogs(source, version);
    if (output !== source) await fs.writeFile(file, output, 'utf8');
    return config;
  }]);
}
module.exports = withDictationPrivacy;
module.exports.silenceSpeechLogs = silenceSpeechLogs;
