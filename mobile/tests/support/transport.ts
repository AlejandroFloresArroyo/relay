export interface RequestRecord {
  method: string;
  origin: string;
  path: string;
  body: unknown;
  headers: Headers;
  signal?: AbortSignal | null;
}
type Reply = Response | Promise<Response> | ((request: RequestRecord) => Response | Promise<Response>);
const routes = new Map<string, Reply>();
export const requests: RequestRecord[] = [];
export const unexpectedRequests: RequestRecord[] = [];
export function respond(origin: string, path: string, reply: Reply, method = 'GET') {
  routes.set(`${method} ${origin}${path}`, reply);
}
export function json(body: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) }),
    get body() { return { cancel: async () => {}, getReader: () => {
      let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: bytes }), cancel: async () => {}, releaseLock() {} };
    } }; },
  } as unknown as Response;
}
export function networkError(): Promise<Response> { return Promise.reject(new Error('Fixture network unavailable')); }
async function fetchFixture(input: string | URL | Request, options?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const request: RequestRecord = {
    method: options?.method ?? 'GET', origin: url.origin, path: `${url.pathname}${url.search}`,
    headers: new Headers(options?.headers),
    // A transfer chunk travels as raw bytes; everything else as JSON.
    body: options?.body instanceof Uint8Array ? options.body.slice() : options?.body ? JSON.parse(String(options.body)) : undefined, signal: options?.signal,
  };
  requests.push(request);
  const route = routes.get(`${request.method} ${request.origin}${request.path}`);
  if (!route) {
    unexpectedRequests.push(request);
    throw new Error(`Unexpected fixture request: ${request.method} ${request.origin}${request.path}`);
  }
  return typeof route === 'function' ? route(request) : route;
}
export const controlledFetch = jest.fn(fetchFixture);
export function resetTransport() {
  routes.clear(); requests.length = 0; unexpectedRequests.length = 0; controlledFetch.mockReset().mockImplementation(fetchFixture);
  globalThis.fetch = controlledFetch as typeof fetch;
}
export function requestsFor(origin: string, path?: string) {
  return requests.filter((request) => request.origin === origin && (path === undefined || request.path === path));
}

const activeStreams = new Set<() => void>();
export function streamFixture() {
  let deliver: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
  let rejectRead: ((error: Error) => void) | undefined;
  let stopped = false;
  const chunks: Uint8Array[] = [];
  let detach = () => {};
  let failure: Error | undefined;
  const finish = (error?: Error) => {
    stopped = true; failure = error; detach(); activeStreams.delete(stop);
    if (error) rejectRead?.(error);
    else deliver?.({ done: true, value: undefined });
    deliver = undefined; rejectRead = undefined;
  };
  const stop = () => finish(new Error('Fixture stream aborted'));
  const reader = { read: jest.fn(() => {
    if (failure) return Promise.reject(failure);
    const value = chunks.shift();
    if (value) return Promise.resolve({ done: false as const, value });
    if (stopped) return Promise.resolve({ done: true as const, value: undefined });
    return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => { deliver = resolve; rejectRead = reject; });
  }), cancel: async () => {} };
  return {
    reader,
    close: () => finish(),
    fail: (error = new Error('Fixture SSE failure')) => finish(error),
    emit(text: string) {
      if (stopped) throw new Error('Fixture stream is stopped');
      const value = new TextEncoder().encode(text);
      if (deliver) { deliver({ done: false, value }); deliver = undefined; rejectRead = undefined; }
      else chunks.push(value);
    },
    reply(request: RequestRecord): Response {
      activeStreams.add(stop);
      const signal = request.signal;
      signal?.addEventListener('abort', stop, { once: true });
      detach = () => signal?.removeEventListener('abort', stop);
      if (signal?.aborted) stop();
      return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response;
    },
  };
}
export function streamCount() { return activeStreams.size; }
export function cancelStreams() { for (const stop of activeStreams) stop(); }

export function binary(bytes: Uint8Array, mimeType = 'application/octet-stream', status = 200): Response {
  const copy = bytes.slice();
  let sent = false;
  return {
    ok: status >= 200 && status < 300, status,
    headers: new Headers({ 'Content-Type': mimeType, 'Content-Length': String(copy.length) }),
    arrayBuffer: async () => copy.slice().buffer,
    body: { getReader: () => ({ read: async () => {
      if (sent) return { done: true, value: undefined };
      sent = true; return { done: false, value: copy.slice() };
    }, cancel: async () => { sent = true; }, releaseLock: () => {} }) },
  } as unknown as Response;
}
