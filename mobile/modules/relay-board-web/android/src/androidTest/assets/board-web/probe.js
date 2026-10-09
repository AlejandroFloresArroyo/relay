'use strict';
const report = name => console.log('relay-board-web-probe:' + name);
const attempt = (name, action) => {
  try { const result = action(); if (result && result.catch) result.catch(() => {}); report('attempt:' + name); }
  catch (_) { report('attempt:' + name); }
};
const button = document.getElementById('counter');
button.addEventListener('click', () => { button.textContent = String(Number(button.textContent) + 1); });
button.click();
const drawing = document.getElementById('plot').getContext('2d'); drawing.fillRect(0, 0, 20, 20);
if (button.textContent === '1' && getComputedStyle(button).color === 'rgb(17, 34, 51)' && drawing.getImageData(1, 1, 1, 1).data[3] === 255) report('benign-counter-canvas');
const localImage = new Image(); localImage.onload = () => report('benign-local-image'); localImage.onerror = () => report('benign-local-image-error'); localImage.src = 'local.png'; document.body.append(localImage);
const target = RELAY_PROBE_TARGET;
const uri = target.tcp;
attempt('fetch', () => fetch(uri + 'fetch'));
attempt('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', uri + 'xhr'); x.send(); });
attempt('websocket', () => new WebSocket(uri.replace('https:', 'wss:') + 'ws'));
attempt('beacon', () => navigator.sendBeacon(uri + 'beacon', 'synthetic'));
attempt('eventsource', () => new EventSource(uri + 'events'));
attempt('webtransport', () => new WebTransport(uri + 'transport'));
attempt('image', () => { const image = new Image(); image.src = uri + 'image.png'; document.body.append(image); });
attempt('css', () => { const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = uri + 'style.css'; document.head.append(css); });
attempt('preconnect', () => { const link = document.createElement('link'); link.rel = 'preconnect'; link.href = uri; document.head.append(link); });
attempt('dns-prefetch', () => { const link = document.createElement('link'); link.rel = 'dns-prefetch'; link.href = uri; document.head.append(link); });
attempt('worker', () => new Worker(uri + 'worker.js'));
attempt('blob-worker', () => new Worker(URL.createObjectURL(new Blob(['fetch(' + JSON.stringify(uri) + ')']))));
attempt('service-worker', () => navigator.serviceWorker.register(uri + 'sw.js'));
attempt('audio-worklet', () => new AudioContext().audioWorklet.addModule(uri + 'audio.js'));
attempt('paint-worklet', () => CSS.paintWorklet.addModule(uri + 'paint.js'));
attempt('file', () => fetch(target.file).then(r => r.text()).then(text => { if (text.includes('relay-file-canary')) report('file-leak'); }));
attempt('content', () => fetch('content://relay.synthetic.invalid/canary'));
attempt('android-asset', () => { const frame = document.createElement('iframe'); frame.src = 'file:///android_asset/index.html'; document.body.append(frame); });
attempt('file-frame', () => { const frame = document.createElement('iframe'); frame.src = target.file; document.body.append(frame); });
attempt('cookie', () => { document.cookie = 'relaySynthetic=1'; if (document.cookie.includes('relaySynthetic')) report('cookie-leak'); });
attempt('storage', () => { localStorage.setItem('relaySynthetic', '1'); report('storage-leak'); });
attempt('indexeddb', () => { const result = indexedDB.open('relaySynthetic'); result.onsuccess = () => report('database-leak'); });
attempt('cache', () => caches.open('relaySynthetic').then(() => report('cache-leak')));
attempt('popup', () => window.open(uri + 'popup'));
attempt('dialog', () => { alert('synthetic'); confirm('synthetic'); prompt('synthetic'); });
attempt('chooser', () => { const input = document.createElement('input'); input.type = 'file'; document.body.append(input); input.click(); });
attempt('geolocation', () => navigator.geolocation.getCurrentPosition(() => report('geolocation-leak')));
attempt('media', () => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => report('media-leak')));
async function rtc(label, Factory) {
  report('attempt:' + label);
  try {
    const peer = new Factory({ iceServers: [
      { urls: 'stun:127.0.0.1:' + target.udp },
      { urls: 'turn:127.0.0.1:' + target.udp + '?transport=udp', username: 'synthetic', credential: 'synthetic' },
      { urls: 'turn:127.0.0.1:' + target.tcpPort + '?transport=tcp', username: 'synthetic', credential: 'synthetic' }
    ] });
    peer.createDataChannel('synthetic');
    const offer = await peer.createOffer(); await peer.setLocalDescription(offer); report('rtc-offer:' + label);
    const fingerprint = Array(32).fill('AA').join(':');
    const sdp = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=ice-lite',
      'm=application ' + target.udp + ' UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 127.0.0.1', 'a=mid:0',
      'a=ice-ufrag:synthetic', 'a=ice-pwd:relaySyntheticPassword000', 'a=fingerprint:sha-256 ' + fingerprint,
      'a=setup:active', 'a=sctp-port:5000', 'a=candidate:1 1 udp 2130706431 127.0.0.1 ' + target.udp + ' typ host',
      'a=end-of-candidates', ''].join('\r\n');
    await peer.setRemoteDescription({ type: 'answer', sdp }); report('rtc-remote-sdp:' + label);
    setTimeout(() => peer.close(), 12000);
  } catch (_) { report('rtc-rejected:' + label); }
}
rtc('rtc', globalThis.RTCPeerConnection);
attempt('srcdoc-realm', () => { const frame = document.createElement('iframe'); frame.srcdoc = '<p>synthetic</p>'; document.body.append(frame); rtc('rtc-srcdoc', frame.contentWindow.RTCPeerConnection); });
attempt('blank-realm', () => { const frame = document.createElement('iframe'); document.body.append(frame); rtc('rtc-blank', frame.contentWindow.RTCPeerConnection); });
// Defer every navigation attack until RTC offers can complete in the source realm.
setTimeout(() => {
  attempt('download', () => { const a = document.createElement('a'); a.href = uri + 'download'; a.download = 'synthetic'; a.click(); });
  attempt('post', () => { const form = document.createElement('form'); form.action = uri + 'post'; form.method = 'POST'; document.body.append(form); form.submit(); });
  attempt('intent-navigation', () => { const a = document.createElement('a'); a.href = 'intent://relay.synthetic/#Intent;scheme=synthetic;end'; a.click(); });
  attempt('top-navigation', () => { top.location.href = uri + 'top'; });
  attempt('data-navigation', () => { const frame = document.createElement('iframe'); frame.src = 'data:text/html,synthetic'; document.body.append(frame); });
  attempt('blob-navigation', () => { const frame = document.createElement('iframe'); frame.src = URL.createObjectURL(new Blob(['synthetic'], { type: 'text/html' })); document.body.append(frame); });
  report('matrix-submitted');
}, 1000);
