// The entry: one server, the OpenAI Chat Completions API and the Anthropic Messages API over ten free-tier
// providers, each spoken in its own wire.
//
//   node main.ts --list   print the catalog this entry registers, and exit 0
//   node main.ts          listen on a free port, register with the env, serve its client, exit 0 when done
//
// A trial gives this process a brief ($MAKEFUN_PROMPT_FILE: the providers, the quality table and the
// workload manifest) and an env ($MAKEFUN_ENV_URL) that serves the providers under their base paths. The
// catalog is built once from the providers' own catalog routes and is the document `--list` prints and the
// register body carries, byte for byte.
//
// Everything is a function of the brief and the answers the providers have given so far: no clock, no
// randomness, one client request at a time, so a replay leaves the same state export.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isRecord, readBrief, type Json, type Requires } from './lib/brief.ts';
import { buildCatalog, probeAll, servedModels, type Catalog, type Probe, type ServedModel } from './lib/catalog.ts';
import { Router, type Served } from './lib/router.ts';
import {
  anthropicMessage,
  anthropicModelList,
  anthropicStreamText,
  asksJsonMode,
  errorBody,
  hasImage,
  hasTools,
  openAICompletion,
  openAIModelList,
  openAIStreamText,
  type ClientApi,
} from './lib/wire.ts';

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 50;
/** Polls without a new client request before giving up, as a wall-clock backstop only: 50 ms each, about two minutes. */
const IDLE_TICKS_LIMIT = 2400;
const PROBE_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: Catalog = { providers: [] };
let router: Router = new Router([], []);
let served: ServedModel[] = [];
/** Where the arrival order is in the workload manifest: the client sends its requests one at a time. */
let manifestAt = 0;
/** The poll tick the last client request arrived on, for the idle backstop in poll(). */
let lastRequestTick = 0;
let tick = 0;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** Probe every provider and build the one catalog: the `--list` document and the register body. */
async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = await probeAll(ENV_URL, brief.providers, PROBE_TIMEOUT_MS);
  for (const probe of probes) if (!probe.ok && probe.error !== null) log(probe.error);
  catalog = buildCatalog(probes, brief.ratings);
  router = new Router(probes, brief.ratings);
  served = servedModels(probes, brief.ratings);
}

/** What the request now arriving needs, from the manifest's next row for its wire and from its own body. */
function requirementsFor(api: ClientApi, body: Json): Requires {
  let requires: Requires = {};
  for (let i = manifestAt; i < brief.manifest.length; i++) {
    const row = brief.manifest[i];
    if (row === undefined || row.api !== api) continue;
    manifestAt = i + 1;
    requires = { ...row.requires };
    break;
  }
  if (hasTools(body)) requires.tools = true;
  if (hasImage(body)) requires.vision = true;
  if (asksJsonMode(body)) requires.json = true;
  return requires;
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, api: ClientApi, status: number, type: string, message: string): void {
  sendJson(res, status, errorBody(api, type, message));
}

/** GET /v1/models: the free models this entry serves, in the shape the auth header asks for. */
function models(req: IncomingMessage, res: ServerResponse): void {
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(served));
  else sendJson(res, 200, openAIModelList(served));
}

/** One answered request, written back in the client's wire, in JSON or as server-sent events. */
function sendAnswer(res: ServerResponse, api: ClientApi, stream: boolean, servedAnswer: Served): void {
  const model = servedAnswer.model.id;
  if (stream) {
    const text = api === 'openai' ? openAIStreamText(servedAnswer.answer, model) : anthropicStreamText(servedAnswer.answer, model);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.end(text);
    return;
  }
  sendJson(res, 200, api === 'openai' ? openAICompletion(servedAnswer.answer, model) : anthropicMessage(servedAnswer.answer, model));
}

/** One inference request: pick a free model, call its provider, answer in the client's wire. */
async function inference(req: IncomingMessage, res: ServerResponse, api: ClientApi): Promise<void> {
  lastRequestTick = tick;
  const body = await readJson(req);
  if (body === null) return sendError(res, api, 400, 'invalid_request_error', 'the request body is not one JSON object');
  const stream = body.stream === true;
  const requires = requirementsFor(api, body);
  const result = await router.serve(api, body, requires, ENV_URL);
  if (result.served === null) {
    log(`no answer for the ${api} request: ${result.detail}`);
    return sendError(res, api, 503, 'no_free_model', `no free model could answer this request: ${result.detail}`);
  }
  sendAnswer(res, api, stream, result.served);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await inference(req, res, 'openai');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await inference(req, res, 'anthropic');
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the workload's size. */
async function register(port: number): Promise<void> {
  const body = JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog });
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const reply: unknown = await res.json();
        if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the workload holds ${reply.requests} requests`);
        return;
      }
      last = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`POST ${ENV_URL}/register failed: ${last}`);
}

/**
 * Poll GET /work and exit 0 the moment the env says the client is done.
 *
 * The idle guard is insurance, not routing: if no client request has arrived for two minutes (the trial's
 * wall is three) nothing more is coming, and exiting leaves the requests answered so far scored rather than
 * the whole trial at zero for a process still running when the wall is spent.
 */
function poll(server: Server): void {
  let inFlight = false;
  setInterval(() => {
    tick += 1;
    if (tick - lastRequestTick > IDLE_TICKS_LIMIT) {
      log('no client request for two minutes: exiting');
      server.close();
      process.exit(0);
    }
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not answering yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  await load();
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${catalog.providers.length} providers and ${served.length} free models`);
  await register(port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
