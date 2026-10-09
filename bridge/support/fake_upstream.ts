// Test double for the Hermes API server (gateway/platforms/api_server*.py), speaking the parts
// of its HTTP contract relayd uses: /health, the Runs API and its SSE event stream, with
// multi-profile routing (`/p/<profile>/...`) and one bearer key per profile.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface UpstreamRequest {
  method: string;
  path: string; // without the /p/<profile> prefix
  profile: string;
  authorized: boolean;
  body: any;
  lastEventId: string | null;
  headers: http.IncomingHttpHeaders;
}

interface FakeRun {
  profile: string;
  sessionId: string;
  status: string;
  output: string | null;
  error: string | null;
  backlog: { seq: number; event: Record<string, unknown> }[];
  pendingSteer: string | null;
  subscribers: Set<http.ServerResponse>;
}

export interface FakeSession {
  id: string;
  source: string;
  title: string | null;
}

export class FakeUpstream {
  keys: Record<string, string>;
  requests: UpstreamRequest[] = [];
  runs = new Map<string, FakeRun>();
  sessions: Record<string, Map<string, FakeSession>> = {};
  seedSession(profile: string, session: FakeSession): void {
    (this.sessions[profile] ??= new Map()).set(session.id, { ...session });
  }
  approvalStatus = 200; // what POST .../approval answers
  port = 0;
  // Feature fixtures run after the same profile authentication as the built-in routes.
  private replies = new Map<string, (request: UpstreamRequest, response: http.ServerResponse) => void | Promise<void>>();
  respond(method: string, path: string, reply: (request: UpstreamRequest, response: http.ServerResponse) => void | Promise<void>): void {
    this.replies.set(`${method} ${path}`, reply);
  }
  reset(): void { this.requests.length = 0; this.replies.clear(); this.approvalStatus = 200; }

  private server: http.Server;
  private nextRun = 1;

  constructor(keys: Record<string, string>) {
    this.keys = keys;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        res.writeHead(500).end(String(error));
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  requestsTo(method: string, pathPattern: RegExp): UpstreamRequest[] {
    return this.requests.filter((request) => request.method === method && pathPattern.test(request.path));
  }

  // Emits one event on a run's stream, in Hermes's wire shape.
  emit(runId: string, name: string, fields: Record<string, unknown> = {}): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`fake upstream: unknown run ${runId}`);
    const seq = run.backlog.length;
    const event = { event: name, run_id: runId, timestamp: Date.now() / 1000, ...fields };
    run.backlog.push({ seq, event });
    if (name === 'run.completed') Object.assign(run, { status: 'completed', output: fields.output ?? '' });
    if (name === 'run.interrupted') Object.assign(run, { status: 'interrupted', error: fields.error ?? '' });
    if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(name)) {
      run.pendingSteer = typeof fields.pending_steer === 'string' ? fields.pending_steer : null;
    }
    if (name === 'run.failed') Object.assign(run, { status: 'failed', error: fields.error ?? '' });
    if (name === 'run.cancelled') run.status = 'cancelled';
    for (const res of run.subscribers) res.write(frame(seq, event));
  }

  // Ends every open SSE connection of a run, the way Hermes does once the run is over.
  closeStream(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    for (const res of run.subscribers) res.end(': stream closed\n\n');
    run.subscribers.clear();
  }

  // Drops the connections without a goodbye, like a gateway restart would.
  dropConnections(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    for (const res of run.subscribers) res.destroy();
    run.subscribers.clear();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://upstream');
    let path = url.pathname;
    let profile = 'default';
    const prefixed = /^\/p\/([^/]+)(\/.*)$/.exec(path);
    if (prefixed) {
      profile = prefixed[1];
      path = prefixed[2];
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any = null;
    try {
      body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    } catch {
      body = undefined;
    }

    const key = this.keys[profile];
    const authorized = Boolean(key) && req.headers.authorization === `Bearer ${key}`;
    this.requests.push({
      method: req.method ?? 'GET',
      path,
      profile,
      authorized,
      body,
      headers: { ...req.headers },
      lastEventId: (req.headers['last-event-id'] as string | undefined) ?? null,
    });

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const error = (status: number, message: string, code: string) => send(status, { error: { message, code } });

    if (req.method === 'GET' && path === '/health') return send(200, { status: 'ok' });
    if (!authorized) return error(401, 'Invalid API key', 'invalid_api_key');
    const reply = this.replies.get(`${req.method} ${path}`);
    if (reply) return reply(this.requests[this.requests.length - 1], res);
    if (req.method === 'GET' && path === '/v1/models') return send(200, { object: 'list', data: [{ id: 'hermes-agent', object: 'model' }] });
    if (req.method === 'POST' && path === '/api/sessions') {
      const id = typeof body?.id === 'string' ? body.id.trim() : '';
      if (!id || /[/\\\r\n\0]/.test(id)) return error(400, 'Invalid session ID', 'invalid_session_id');
      const sessions = this.sessions[profile] ??= new Map();
      if (sessions.has(id)) return error(409, 'Session already exists', 'session_exists');
      const session: FakeSession = { id, source: body.source ?? 'api_server', title: null };
      sessions.set(id, session);
      return send(201, { object: 'hermes.session', session });
    }
    const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]);
      const sessions = this.sessions[profile];
      const session = sessions?.get(id);
      if (!session) return error(404, 'Session not found', 'session_not_found');
      if (req.method === 'GET') return send(200, { object: 'hermes.session', session });
      if (req.method === 'PATCH') {
        const title = typeof body?.title === 'string' ? body.title.trim() : '';
        if (!title || [...title].length > 100 || [...sessions!.values()].some((other) => other.id !== id && other.title === title)) {
          return error(400, 'Invalid or duplicate title', 'invalid_title');
        }
        session.title = title;
        return send(200, { object: 'hermes.session', session });
      }
      if (req.method === 'DELETE') {
        sessions!.delete(id);
        return send(200, { object: 'hermes.session.deleted', id, deleted: true });
      }
    }


    if (req.method === 'POST' && path === '/v1/runs') {
      if (!body?.input) return error(400, "Missing 'input' field", 'invalid_request');
      const runId = `run_up${this.nextRun++}`;
      this.runs.set(runId, {
        profile,
        sessionId: body.session_id ?? runId,
        status: 'running',
        output: null,
        error: null,
        backlog: [],
        subscribers: new Set(),
        pendingSteer: null,
      });
      return send(202, { run_id: runId, status: 'started', replayed: false });
    }

    const match = /^\/v1\/runs\/([^/]+)(?:\/(events|approval|steer|stop))?$/.exec(path);
    if (!match) return error(404, 'Not found', 'not_found');
    const [, runId, action] = match;
    const run = this.runs.get(runId);
    // Like Hermes: a run only answers for the profile that created it, 404 otherwise.
    if (!run || run.profile !== profile) return error(404, `Run not found: ${runId}`, 'run_not_found');

    if (req.method === 'GET' && !action) {
      return send(200, {
        object: 'hermes.run',
        run_id: runId,
        status: run.status,
        session_id: run.sessionId,
        output: run.output,
        error: run.error,
        ...(run.pendingSteer && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? { pending_steer: run.pendingSteer } : {}),
      });
    }
    if (req.method === 'GET' && action === 'events') {
      const after = req.headers['last-event-id'] === undefined ? -1 : Number(req.headers['last-event-id']);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(': open\n\n');
      for (const { seq, event } of run.backlog) if (seq > after) res.write(frame(seq, event));
      run.subscribers.add(res);
      req.on('close', () => run.subscribers.delete(res));
      return;
    }
    if (req.method === 'POST' && action === 'approval') {
      if (this.approvalStatus !== 200) {
        return error(this.approvalStatus, `Run has no pending approval: ${runId}`, 'approval_not_pending');
      }
      return send(200, { object: 'hermes.run.approval_response', run_id: runId, choice: body?.choice, resolved: 1 });
    }
    if (req.method === 'POST' && action === 'steer') {
      if (run.status !== 'running') return error(409, 'Run is not currently accepting steer input', 'run_not_accepting_steer');
      if (typeof body?.input !== 'string' || !body.input.trim()) return error(400, 'Missing non-empty steer text', 'invalid_steer_input');
      run.pendingSteer = run.pendingSteer ? `${run.pendingSteer}\n${body.input.trim()}` : body.input.trim();
      this.emit(runId, 'run.steered', { accepted: true });
      return send(200, { object: 'hermes.run.steer', run_id: runId, accepted: true });
    }
    if (req.method === 'POST' && action === 'stop') { run.status = 'stopping'; return send(200, { run_id: runId, status: 'stopping' }); }
    return error(404, 'Not found', 'not_found');
  }
}

function frame(seq: number, event: Record<string, unknown>): string {
  return `id: ${seq}\ndata: ${JSON.stringify({ ...event, seq })}\n\n`;
}
