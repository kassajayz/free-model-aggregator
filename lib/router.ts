// Choosing the model that answers one request, and living with a provider that refuses.
//
// A candidate is a free model that meets the request's requirements. They are ranked by the quality table's
// rating, so the strongest legal model is tried first. A refusal (402, 429 or a 5xx) is not the answer: the
// same provider gets one more try, because a provider's failure schedule often refuses a single call, and
// then it is out for the rest of the trial, which is what a spent free tier looks like. The request then
// moves to the next best model, so a refusal costs a call and never the request.
//
// A provider marked out is only out while another model can answer: when nothing else is left, it gets one
// last chance, because a request that goes unanswered costs far more than a call.

import {
  authHeaders,
  joinBase,
  rowFor,
  type Json,
  type ModelRow,
  type ProviderEntry,
  type Requires,
} from './brief.ts';
import { capabilitiesOf, type Capabilities, type Probe, type ProbedModel } from './catalog.ts';
import { asksJsonMode, readAnswer, upstreamRequest, type ClientApi, type ProviderAnswer } from './wire.ts';

export interface Candidate {
  provider: ProviderEntry;
  model: ProbedModel;
  rating: number;
  caps: Capabilities;
}

export interface Served {
  provider: ProviderEntry;
  model: ProbedModel;
  answer: ProviderAnswer;
}

export interface ServeResult {
  served: Served | null;
  /** Provider calls this request cost, spent ones included. */
  attempts: number;
  detail: string;
}

interface ProviderState {
  /** Calls this provider answered. */
  successes: number;
  /** Refusals in a row: two and the provider is out for the trial. */
  strikes: number;
  dead: boolean;
}

/** Whether a model can serve a request: every capability the request names is one the model has. */
export function meets(requires: Requires, caps: Capabilities): boolean {
  if (requires.tools === true && !caps.tools) return false;
  if (requires.vision === true && !caps.vision) return false;
  if (requires.json === true && !caps.json) return false;
  if (requires.min_context !== undefined && (caps.context_length === null || caps.context_length < requires.min_context)) {
    return false;
  }
  return true;
}

const CALL_TIMEOUT_MS = 15000;

export class Router {
  #probes: readonly Probe[];
  #ratings: readonly ModelRow[];
  #state = new Map<string, ProviderState>();

  constructor(probes: readonly Probe[], ratings: readonly ModelRow[]) {
    this.#probes = probes;
    this.#ratings = ratings;
  }

  #stateOf(id: string): ProviderState {
    let state = this.#state.get(id);
    if (state === undefined) {
      state = { successes: 0, strikes: 0, dead: false };
      this.#state.set(id, state);
    }
    return state;
  }

  /**
   * Every free model that meets `requires`, best first.
   *
   * `needsJsonCarry` drops the providers whose wire cannot carry JSON mode (Anthropic's Messages API has
   * none): such a request would come back with the mode missing, which fails it.
   */
  candidatesFor(requires: Requires, needsJsonCarry: boolean): Candidate[] {
    const out: Candidate[] = [];
    for (const probe of this.#probes) {
      if (!probe.ok) continue;
      if (needsJsonCarry && probe.provider.wire === 'anthropic') continue;
      for (const model of probe.models) {
        const row = rowFor(this.#ratings, probe.provider.id, model.id);
        const caps = capabilitiesOf(model, row);
        const free = row !== null ? row.free : model.free === true;
        if (!free) continue;
        if (!meets(requires, caps)) continue;
        out.push({ provider: probe.provider, model, rating: row?.rating_milli ?? 0, caps });
      }
    }
    out.sort((a, b) => {
      if (a.rating !== b.rating) return b.rating - a.rating;
      if (a.provider.order !== b.provider.order) return a.provider.order - b.provider.order;
      return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
    });
    return out;
  }

  /** One provider call: the whole answer, or why it did not come. */
  async #call(
    candidate: Candidate,
    api: ClientApi,
    body: Json,
    envUrl: string,
  ): Promise<{ ok: true; answer: ProviderAnswer } | { ok: false; status: number; detail: string }> {
    const request = upstreamRequest(candidate.provider.wire, api, body, candidate.model.id);
    const url = `${joinBase(envUrl, candidate.provider.base)}${request.path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...authHeaders(candidate.provider.auth, candidate.provider.key),
    };
    if (candidate.provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, status: 0, detail: `${candidate.provider.id} did not answer: ${(err as Error).message}` };
    }
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, detail: `${candidate.provider.id} answered HTTP ${response.status}: ${text.slice(0, 200)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, status: response.status, detail: `${candidate.provider.id} answered a body that is not JSON` };
    }
    const answer = readAnswer(candidate.provider.wire, parsed);
    if (answer === null) {
      return { ok: false, status: response.status, detail: `${candidate.provider.id} answered no ${candidate.provider.wire} completion` };
    }
    return { ok: true, answer };
  }

  /** Serve one request: the best legal model that answers, or none when nothing does. */
  async serve(api: ClientApi, body: Json, requires: Requires, envUrl: string): Promise<ServeResult> {
    const all = this.candidatesFor(requires, api === 'openai' && asksJsonMode(body));
    let live = all.filter((candidate) => !this.#stateOf(candidate.provider.id).dead);
    let attempts = 0;
    let detail = 'no free model on the directory meets this request';
    let lastResort = false;
    for (;;) {
      if (live.length === 0) {
        if (lastResort || all.length === 0) break;
        // Every model that could serve this request is out: give each one last chance.
        lastResort = true;
        live = [...all];
        continue;
      }
      const candidate = live[0];
      if (candidate === undefined) break;
      attempts += 1;
      const result = await this.#call(candidate, api, body, envUrl);
      const state = this.#stateOf(candidate.provider.id);
      if (result.ok) {
        state.successes += 1;
        state.strikes = 0;
        return { served: { provider: candidate.provider, model: candidate.model, answer: result.answer }, attempts, detail: '' };
      }
      detail = result.detail;
      // A 402, a 429, a 5xx or no answer at all is a refusal: the provider may be out of budget or out.
      const refusal = result.status === 402 || result.status === 429 || result.status >= 500 || result.status === 0;
      if (refusal) {
        state.strikes += 1;
        if (state.strikes >= 2) {
          state.dead = true;
          // Out for the trial: drop every model this provider offers.
          const id = candidate.provider.id;
          for (let i = live.length - 1; i >= 0; i--) {
            if (live[i]?.provider.id === id) live.splice(i, 1);
          }
        }
        continue;
      }
      // Any other 4xx is this entry's own mistake: no strike, but no second try at the same model.
      live.shift();
    }
    return { served: null, attempts, detail };
  }
}
