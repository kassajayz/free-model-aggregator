// The brief at $MAKEFUN_PROMPT_FILE carries three JSON documents, each found by its `schema`.
//
//   providers  the ten free-tier providers: id, name, wire, auth scheme, key variable, key, base path
//   ratings    the quality table: each model's rating, what it can do, and whether it is free
//   workload   the manifest: each request's api, stream flag, weight and the requirements a model needs
//
// Nothing here reads the clock or draws at random: the same brief always parses the same way.

import { readFileSync } from 'node:fs';

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

export const PROVIDERS_SCHEMA = 'free-model-aggregator-01/providers/v1';
export const RATINGS_SCHEMA = 'free-model-aggregator-01/ratings/v1';
export const WORKLOAD_SCHEMA = 'free-model-aggregator-01/workload/v1';

export type Wire = 'openai' | 'anthropic' | 'gemini';
export type Auth = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

export interface ProviderEntry {
  id: string;
  name: string;
  wire: Wire;
  auth: Auth;
  /** The provider's own base path (`/p/groq`), or an absolute URL when the directory spells one. */
  base: string;
  key_env: string;
  key: string;
  /** Its position in the brief's directory: the tie-break when two models rate the same. */
  order: number;
}

/** One row of the quality table. */
export interface ModelRow {
  provider: string;
  model: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

export interface Requires {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

export interface ManifestRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requires;
}

export interface Brief {
  providers: ProviderEntry[];
  ratings: ModelRow[];
  manifest: ManifestRow[];
  error: string | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The `}` that closes the object opening at `start`, or -1; string contents are skipped. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every object in the prose that parses on its own and carries a string `schema`, in order. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = objectEnd(text, start);
    if (end === -1) break;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not a document boundary: keep scanning.
    }
  }
  return out;
}

function providerOf(v: unknown, order: number): ProviderEntry | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  const wire = v.wire === 'openai' || v.wire === 'anthropic' || v.wire === 'gemini' ? v.wire : null;
  if (id === '' || wire === null) return null;
  const auth: Auth =
    v.auth === 'x-api-key' || v.auth === 'x-goog-api-key' || v.auth === 'none' || v.auth === 'bearer'
      ? v.auth
      : 'bearer';
  const base =
    str(v.path) || str(v.base_path) || str(v.base_url) || str(v.base) || '';
  return {
    id,
    name: str(v.name) || id,
    wire,
    auth,
    base,
    key_env: str(v.key_env),
    key: str(v.key),
    order,
  };
}

function ratingOf(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const model = str(v.model);
  const provider = str(v.provider);
  if (model === '' || provider === '') return null;
  return {
    provider,
    model,
    rating_milli: numOrNull(v.rating_milli) ?? 0,
    context_length: numOrNull(v.context_length),
    tools: v.tools === true,
    vision: v.vision === true,
    json: v.json === true,
    free: v.free === true,
  };
}

function requiresOf(v: unknown): Requires {
  const r = isRecord(v) ? v : {};
  const out: Requires = {};
  if (r.tools === true) out.tools = true;
  if (r.vision === true) out.vision = true;
  if (r.json === true) out.json = true;
  const ctx = numOrNull(r.min_context);
  if (ctx !== null) out.min_context = ctx;
  return out;
}

function manifestRowOf(v: unknown): ManifestRow | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (id === '') return null;
  return {
    id,
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires: requiresOf(v.requires),
  };
}

/** The brief at `path`. A brief that cannot be read or holds no directory leaves `error` set. */
export function readBrief(path: string): Brief {
  if (path === '') return { providers: [], ratings: [], manifest: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { providers: [], ratings: [], manifest: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const directory = docs.find((d) => d.schema === PROVIDERS_SCHEMA && Array.isArray(d.providers));
  if (directory === undefined) {
    return { providers: [], ratings: [], manifest: [], error: `the brief at ${path} holds no ${PROVIDERS_SCHEMA} document` };
  }
  const providers = (directory.providers as unknown[]).flatMap((v, i) => {
    const p = providerOf(v, i);
    return p === null ? [] : [p];
  });
  const ratingsDoc = docs.find((d) => d.schema === RATINGS_SCHEMA && Array.isArray(d.ratings));
  const ratings = ratingsDoc === undefined ? [] : (ratingsDoc.ratings as unknown[]).flatMap((v) => {
    const r = ratingOf(v);
    return r === null ? [] : [r];
  });
  const workloadDoc = docs.find((d) => d.schema === WORKLOAD_SCHEMA && Array.isArray(d.manifest));
  const manifest = workloadDoc === undefined ? [] : (workloadDoc.manifest as unknown[]).flatMap((v) => {
    const m = manifestRowOf(v);
    return m === null ? [] : [m];
  });
  return { providers, ratings, manifest, error: null };
}

/** The quality table's row for one provider's model, when it has one. */
export function rowFor(ratings: readonly ModelRow[], provider: string, model: string): ModelRow | null {
  return ratings.find((r) => r.provider === provider && r.model === model) ?? null;
}

/** A base path joined to the env's origin; an absolute base is used as it stands. */
export function joinBase(envUrl: string, base: string): string {
  const b = base.trim();
  if (/^https?:\/\//i.test(b)) return b.replace(/\/+$/, '');
  const origin = envUrl.replace(/\/+$/, '');
  if (b === '') return origin;
  return `${origin}${b.startsWith('/') ? '' : '/'}${b.replace(/\/+$/, '')}`;
}

/** The provider's own auth header; a provider with no key takes none. */
export function authHeaders(auth: Auth, key: string): Record<string, string> {
  if (key === '') return {};
  if (auth === 'bearer') return { authorization: `Bearer ${key}` };
  if (auth === 'x-api-key') return { 'x-api-key': key };
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return {};
}
