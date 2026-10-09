import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Linking, StatusBar as RNStatusBar, View } from 'react-native';

import { LAB_DEVICE_KEY, LAB_FILE_CANARY, LAB_FILE_CANARY_NAME } from './src/fixture';
import { FakeShell, OutputQueue } from './src/shell';
import Terminal from './src/Terminal';

// Native side of the boundary. It holds the device key and talks to the "Puente" (a fake shell
// here); the DOM terminal only ever receives terminal bytes and sizes.
// The Ctrl-C test bounds this backlog in time: with 256 KiB + one 32 KiB chunk the echo of a
// Ctrl-C typed under an endless flood is on screen in about 0.3 s on the emulator.
const CHUNK = 32 * 1024;
const queue = new OutputQueue(256 * 1024);
const shell = new FakeShell(queue, { cols: 80, rows: 24 });
const headers = { authorization: `Bearer ${LAB_DEVICE_KEY}` };
let wake: (() => void) | null = null;
let reported = 0;

shell.onLine = (line) => console.log('LAB line ' + JSON.stringify(line));

// files/ is the app's private storage. Expo's DOM WebView serves its bundle from file:// with
// file access on, so the suite checks whether the page can read this file.
const canary = new File(Paths.document, LAB_FILE_CANARY_NAME);
canary.create({ overwrite: true });
canary.write(LAB_FILE_CANARY);

// Stand-in for an authenticated request to the Puente: the key is used here and only here.
function toPuente(request: { authorization: string }, apply: () => void) {
  if (request.authorization !== `Bearer ${LAB_DEVICE_KEY}`) throw new Error('unauthorized');
  apply();
  wake?.();
  wake = null;
}

async function sendInput(data: string) {
  console.log('LAB in ' + JSON.stringify(data));
  toPuente(headers, () => shell.input(data));
}

async function resize(cols: number, rows: number) {
  console.log(`LAB size cols=${cols} rows=${rows}`);
  toPuente(headers, () => shell.resize({ cols, rows }));
}

// The terminal pulls the next chunk only after xterm has parsed the previous one, so output
// waits here, in a bounded queue that pauses the producer, never in the WebView.
async function pullOutput(): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    shell.pump();
    const out = queue.take(CHUNK);
    if (out) {
      if (queue.size === 0 && reported !== queue.total) {
        reported = queue.total;
        console.log(`LAB queue total=${queue.total} hash=${queue.hash.toString(16)} max=${queue.max}`);
      }
      return out;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    wake = resolve;
    setTimeout(resolve, 1000);
    await promise;
  }
  return '';
}

async function copy(text: string) {
  await Clipboard.setStringAsync(text);
  console.log(`LAB copied ${text.length}`);
}

async function paste() {
  return Clipboard.getStringAsync();
}

const CONFIGS = ['baseline', 'relay'] as const;
type Config = (typeof CONFIGS)[number];

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    void Linking.getInitialURL().then((url) => {
      const asked = url?.match(/config=([a-z-]+)/)?.[1];
      setConfig(CONFIGS.find((name) => name === asked) ?? 'relay');
    });
  }, []);

  if (!config) return <View style={{ flex: 1, backgroundColor: '#000' }} />;
  const terminal = (
    <Terminal
      config={config}
      dom={{ style: { flex: 1 }, webviewDebuggingEnabled: true }}
      sendInput={sendInput}
      resize={resize}
      pullOutput={pullOutput}
      copy={copy}
      paste={paste}
    />
  );
  return (
    <View style={{ flex: 1, backgroundColor: '#000', paddingTop: RNStatusBar.currentHeight }}>
      <StatusBar style="light" />
      {config !== 'baseline' ? (
        // Android 16 draws edge to edge: the window no longer shrinks for the keyboard.
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          {terminal}
        </KeyboardAvoidingView>
      ) : (
        terminal
      )}
    </View>
  );
}
