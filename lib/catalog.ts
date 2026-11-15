// Probing the ten providers' catalog routes, in each provider's own wire, and building the one catalog
// document that `--list` prints and the register body carries.
//
// A listing that answers tells us its models, and the simulated (and the real) routes say which are free
// and how much context each one takes. The quality table is the sealed truth where it has a row, so its
// free flag and capability columns win; the listing fills in the rest. A provider whose route refuses is
// left out of the catalog and gets no traffic.

import {
  authHeaders,
  isRecord,
  joinBase,
  rowFor,
  type Json,
  type ModelRow,
  type ProviderEntry,
  type Wire,
} from './brief.ts';

export interface ProbedModel {
  id: string;
  display_name: string;
  free: boolean | null;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

export interface Probe {
  provider: ProviderEntry;
  ok: boolean;
  models: ProbedModel[];
  error: string | null;
}

export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: Wire;
  models: CatalogModel[];
}

/** The document `--list` prints and the register body carries: the same object, byte for byte. */
export interface Catalog {
  providers: CatalogProvider[];
}

/** One model this entry serves, in the shape GET /v1/models uses. */
export interface ServedModel {
  id: string;
  provider: string;
  display_name: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** True when every price a listing spells out is zero: the listing's own way of saying "free". */
function zeroPriced(v: Json): boolean | null {
  const pricing = isRecord(v.pricing) ? v.pricing : null;
  if (pricing === null) return null;
  const values: number[] = [];
  for (const raw of Object.values(pricing)) {
    if (typeof raw === 'number') values.push(raw);
    else if (typeof raw === 'string' && raw.trim() !== '') values.push(Number(raw));
  }
  if (values.length === 0) return null;
  return values.every((n) => Number.isFinite(n) && n === 0);
}

/** One listed model in whichever wire's spelling. */
function modelIn(wire: Wire, v: unknown): ProbedModel | null {
  if (!isRecord(v)) return null;
  const id = wire === 'gemini' ? str(v.name).replace(/^models\//, '') : str(v.id);
  if (id === '') return null;
  return {
    id,
    display_name: str(v.display_name) || str(v.displayName) || id,
    free: boolOrNull(v.free) ?? zeroPriced(v),
    context_length: numOrNull(v.context_length) ?? numOrNull(v.context_window) ?? numOrNull(v.inputTokenLimit),
    tools: boolOrNull(v.tools),
    vision: boolOrNull(v.vision),
    json: boolOrNull(v.json),
  };
}

function modelsIn(wire: Wire, body: unknown): ProbedModel[] {
  if (!isRecord(body)) return [];
  const list = wire === 'gemini' ? body.models : body.data;
  if (!Array.isArray(list)) return [];
  return list.flatMap((v) => {
    const m = modelIn(wire, v);
    return m === null ? [] : [m];
  });
}

/** GET one provider's catalog route, in its own wire. Never throws. */
export async function probeProvider(envUrl: string, provider: ProviderEntry, timeoutMs = 5000): Promise<Probe> {
  const base = joinBase(envUrl, provider.base);
  const url = provider.wire === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { provider, ok: false, models: [], error: `GET ${url} answered HTTP ${res.status}` };
    const body: unknown = await res.json();
    return { provider, ok: true, models: modelsIn(provider.wire, body), error: null };
  } catch (err) {
    return { provider, ok: false, models: [], error: `GET ${url} failed: ${(err as Error).message}` };
  }
}

/** Probe every provider, one after another, in the brief's order (so the catalog never depends on timing). */
export async function probeAll(envUrl: string, providers: readonly ProviderEntry[], timeoutMs = 5000): Promise<Probe[]> {
  const out: Probe[] = [];
  for (const provider of providers) out.push(await probeProvider(envUrl, provider, timeoutMs));
  return out;
}

/** Whether a listed model is free: the quality table's word where it has a row (the sealed truth), else the listing's. */
export function freeFlag(model: ProbedModel, row: ModelRow | null): boolean {
  if (row !== null) return row.free;
  return model.free ?? false;
}

/** What a model can do: the quality table first, the listing second, the universal minimum for context. */
export interface Capabilities {
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
}

export function capabilitiesOf(model: ProbedModel, row: ModelRow | null): Capabilities {
  return {
    context_length: row?.context_length ?? model.context_length,
    tools: row?.tools ?? model.tools ?? false,
    vision: row?.vision ?? model.vision ?? false,
    json: row?.json ?? model.json ?? false,
  };
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The catalog: every provider whose route answered, every model it listed, each with its free flag.
 *
 * `base_url` is the directory's own path, never the path joined to the env's origin: the origin differs
 * between a live pass and its replay, and the catalog is part of the state a replay must reproduce.
 */
export function buildCatalog(probes: readonly Probe[], ratings: readonly ModelRow[]): Catalog {
  const providers: CatalogProvider[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    const ids = new Set<string>();
    const models: CatalogModel[] = [];
    for (const model of [...probe.models].sort(byId)) {
      if (ids.has(model.id)) continue;
      ids.add(model.id);
      const row = rowFor(ratings, probe.provider.id, model.id);
      models.push({
        id: model.id,
        free: freeFlag(model, row),
        context_length: row?.context_length ?? model.context_length,
      });
    }
    providers.push({
      id: probe.provider.id,
      base_url: probe.provider.base,
      key_env: probe.provider.key_env,
      wire: probe.provider.wire,
      models,
    });
  }
  return { providers };
}

/** The free models across the answered providers, in the brief's order: what GET /v1/models lists. */
export function servedModels(probes: readonly Probe[], ratings: readonly ModelRow[]): ServedModel[] {
  const out: ServedModel[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of [...probe.models].sort(byId)) {
      const row = rowFor(ratings, probe.provider.id, model.id);
      if (!freeFlag(model, row)) continue;
      out.push({ id: model.id, provider: probe.provider.id, display_name: model.display_name });
    }
  }
  return out;
}
