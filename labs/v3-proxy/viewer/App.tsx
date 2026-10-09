// Lab viewer: opens one authorized web destination in react-native-webview, the way Relay's
// embedded viewer would. Opened with relaylabweb://abrir?url=<https URL>.
// Policy under test: new windows and navigations on the same origin stay in the viewer;
// any other origin goes to the phone's browser. The page gets no native bridge.
import { useEffect, useRef, useState } from 'react';
import { Linking, SafeAreaView, Text } from 'react-native';
import { WebView } from 'react-native-webview';

function target(link: string | null): string | null {
  if (!link) return null;
  const url = new URL(link).searchParams.get('url');
  return url && url.startsWith('https://') ? url : null;
}

export default function App() {
  const [url, setUrl] = useState<string | null>(null);
  const web = useRef<WebView>(null);

  useEffect(() => {
    Linking.getInitialURL().then((link) => setUrl(target(link)));
    const sub = Linking.addEventListener('url', ({ url: link }) => setUrl(target(link)));
    return () => sub.remove();
  }, []);

  if (!url) return <SafeAreaView><Text>Sin destino</Text></SafeAreaView>;
  const origin = new URL(url).origin;
  const external = (next: string) => {
    console.log(`relaylab: externo ${next}`);
    Linking.openURL(next);
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <WebView
        ref={web}
        source={{ uri: url }}
        webviewDebuggingEnabled
        setSupportMultipleWindows
        onOpenWindow={({ nativeEvent }) => {
          const next = nativeEvent.targetUrl;
          if (new URL(next).origin === origin) {
            console.log(`relaylab: ventana en visor ${next}`);
            web.current?.injectJavaScript(`location.href = ${JSON.stringify(next)}; true;`);
          } else {
            external(next);
          }
        }}
        onShouldStartLoadWithRequest={(request) => {
          if (request.url.startsWith('about:') || new URL(request.url).origin === origin) return true;
          external(request.url);
          return false;
        }}
      />
    </SafeAreaView>
  );
}
