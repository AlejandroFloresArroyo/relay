const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../assets/board-web/probe.js'), 'utf8');

function browserBoundary(rtcAvailable = true) {
  const messages = [], timers = [], destinations = [];
  let sourceRetired = false;
  const location = {};
  Object.defineProperty(location, 'href', { set() { sourceRetired = true; destinations.push('source'); } });
  const element = tag => {
    const node = { textContent: '0', addEventListener(_event, callback) { this.callback = callback; }, append() {},
      getContext() { return { fillRect() {}, getImageData() { return { data: [0, 0, 0, 255] }; } }; } };
    if (tag === 'iframe') node.contentWindow = { RTCPeerConnection: rtcAvailable ? Peer : undefined };
    if (tag === 'a' || tag === 'form') {
      node.click = node.submit = () => {
        if (!node.target || node.target === '_self') sourceRetired = true;
        destinations.push(node.target || 'source');
      };
    } else node.click = () => { if (node.callback) node.callback(); };
    return node;
  };
  class Peer {
    createDataChannel() {}
    async createOffer() { return { type: 'offer', sdp: 'synthetic' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  }
  class Image {
    set src(_value) { if (this.onload) timers.push({ delay: 0, action: this.onload }); }
  }
  const button = element('button');
  const context = {
    RELAY_PROBE_TARGET: { tcp: 'https://127.0.0.1:12345/', tcpPort: 12345, udp: 12346, file: 'file:///synthetic-fixture' },
    console: { log: text => messages.push(text) }, document: { getElementById: name => name === 'counter' ? button : element('canvas'),
      createElement: element, body: { append() {} }, head: { append() {} }, cookie: '' },
    Image, getComputedStyle: () => ({ color: 'rgb(17, 34, 51)' }),
    setTimeout(action, delay) { timers.push({ action, delay }); }, top: { location }, window: { open() {} },
    fetch: () => Promise.reject(new Error('synthetic')), navigator: {},
    URL: { createObjectURL: () => 'blob:synthetic' }, Blob: class {},
  };
  if (rtcAvailable) context.RTCPeerConnection = Peer;
  vm.runInNewContext(source, context);
  return { messages, destinations, retired: () => sourceRetired, drain() {
    for (const timer of timers.filter(value => value.delay <= 1000).sort((a, b) => a.delay - b.delay)) {
      if (!sourceRetired) timer.action();
    }
  } };
}

test('navigation attacks cannot retire the source before RTC offers and complete matrix submission', async () => {
  const browser = browserBoundary();
  assert.equal(browser.retired(), false, 'early same-document form/download navigation retired the source');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(browser.messages.includes('relay-board-web-probe:rtc-offer:rtc'), 'RTC positive-control scheduling must stay before navigation');
  browser.drain();
  assert.ok(browser.messages.includes('relay-board-web-probe:benign-counter-canvas'));
  assert.ok(browser.messages.includes('relay-board-web-probe:benign-local-image'));
  assert.ok(browser.messages.includes('relay-board-web-probe:matrix-submitted'));
  assert.ok(browser.messages.filter(value => value.startsWith('relay-board-web-probe:attempt:')).length >= 35);
  for (const name of ['download', 'post', 'intent-navigation', 'top-navigation', 'data-navigation', 'blob-navigation']) {
    assert.ok(browser.messages.includes('relay-board-web-probe:attempt:' + name), name + ' must still be exercised');
  }
});

test('missing RTC reports an inconclusive attempt without suppressing the remaining matrix', () => {
  const browser = browserBoundary(false);
  browser.drain();
  assert.ok(browser.messages.includes('relay-board-web-probe:attempt:rtc'));
  assert.ok(browser.messages.includes('relay-board-web-probe:rtc-rejected:rtc'));
  assert.ok(browser.messages.includes('relay-board-web-probe:matrix-submitted'));
  assert.ok(!browser.messages.some(value => value.startsWith('relay-board-web-probe:rtc-offer:')));
});
