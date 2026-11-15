// The two client wires and the three provider wires, and the translation between them.
//
// A client request arrives as an OpenAI Chat Completions body or an Anthropic Messages body. A provider
// speaks openai, anthropic or gemini. Whatever the pair, the provider must see the same request the client
// sent: the same system prompt, the last user text, the tool names in the same order, the same max_tokens,
// the same stop sequences, the same image bytes and, where the provider can carry it, JSON mode. The
// provider echoes what it parsed, so a field dropped or rewritten here costs the request.
//
// The answer comes back whole (never streamed upstream), and this entry writes the client's answer itself:
// the JSON object or the SSE event sequence its wire expects, with the provider's usage and stop reason.

import { isRecord, type Json, type Wire } from './brief.ts';

/** A fixed epoch second, so a listed model's `created` never moves between two runs. */
export const FIXED_CREATED = 1767225600;

export type ClientApi = 'openai' | 'anthropic';

export interface UpstreamRequest {
  path: string;
  body: Json;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A stop field as the list of strings every wire's parser reads back: a bare string is one stop. */
export function stringList(v: unknown): string[] {
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** The text of a string or of an array of text blocks, joined the way the wires join them. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  return parts.join('\n');
}

/** The system prompt of an OpenAI body: every system message's text, in order. */
export function openAISystemText(body: Json): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts: string[] = [];
  for (const m of messages) {
    if (isRecord(m) && m.role === 'system') {
      const text = textOf(m.content);
      if (text !== '') parts.push(text);
    }
  }
  return parts.join('\n');
}

/** A data URL split into its media type and its base64 payload, or null. */
export function splitDataUrl(url: unknown): { mediaType: string; data: string } | null {
  if (typeof url !== 'string') return null;
  const m = /^data:([^;,]*);base64,(.*)$/s.exec(url);
  if (m === null) return null;
  return { mediaType: m[1] === '' ? 'image/png' : m[1], data: m[2] };
}

/** Whether the client's body asks for JSON mode (OpenAI's response_format). */
export function asksJsonMode(body: Json): boolean {
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return format === 'json_object' || format === 'json_schema';
}

/** Whether any message in the body carries an image. */
export function hasImage(body: Json): boolean {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    if (!isRecord(m) || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'image' || block.type === 'image_url') return true;
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content) if (isRecord(inner) && inner.type === 'image') return true;
      }
    }
  }
  return false;
}

/** Whether the body declares any tools. */
export function hasTools(body: Json): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

// ---------------------------------------------------------------------------------------------
// The request, translated into the provider's wire
// ---------------------------------------------------------------------------------------------

/** One Anthropic content block array as OpenAI content parts. */
function openAIPartsFromAnthropic(content: unknown): Json[] {
  if (!Array.isArray(content)) return [{ type: 'text', text: typeof content === 'string' ? content : '' }];
  const parts: Json[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
    else if (block.type === 'image' && isRecord(block.source)) {
      const source = block.source;
      if (source.type === 'base64' && typeof source.data === 'string') {
        const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
        parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } });
      } else if (source.type === 'url' && typeof source.url === 'string') {
        parts.push({ type: 'image_url', image_url: { url: source.url } });
      }
    }
  }
  return parts.length === 0 ? [{ type: 'text', text: '' }] : parts;
}

/** One OpenAI content array as Anthropic content blocks. */
function anthropicBlocksFromOpenAI(content: unknown): Json[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }];
  const blocks: Json[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const image = isRecord(part.image_url) ? part.image_url : null;
      const url = image === null ? '' : image.url;
      const split = splitDataUrl(url);
      if (split !== null) blocks.push({ type: 'image', source: { type: 'base64', media_type: split.mediaType, data: split.data } });
      else if (typeof url === 'string' && url !== '') blocks.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks;
}

/** A tool result's content as the plain text every wire can carry. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOf(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** The argument object of a tool call: the wire's JSON string, or {} when it is not one. */
function argumentsOf(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: an empty input.
    }
  }
  return {};
}

/** An OpenAI tool list as Anthropic tool definitions. */
function anthropicTools(tools: unknown): Json[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((raw) => {
    if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return [];
    return [
      {
        name: raw.function.name,
        description: typeof raw.function.description === 'string' ? raw.function.description : '',
        input_schema: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} },
      },
    ];
  });
}

/** An Anthropic tool list as OpenAI function tools. */
function openAITools(tools: unknown): Json[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.name !== 'string') return [];
    return [
      {
        type: 'function',
        function: {
          name: raw.name,
          description: typeof raw.description === 'string' ? raw.description : '',
          parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
        },
      },
    ];
  });
}

/** Gemini function declarations from either client wire's tool list: the names, in the order they came. */
function geminiTools(api: ClientApi, tools: unknown): Json[] {
  if (!Array.isArray(tools)) return [];
  const declarations: Json[] = [];
  for (const raw of tools) {
    if (!isRecord(raw)) continue;
    const fn = api === 'openai' ? (isRecord(raw.function) ? raw.function : null) : raw;
    if (fn === null || typeof fn.name !== 'string') continue;
    const parameters = api === 'openai' ? fn.parameters : fn.input_schema;
    declarations.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: isRecord(parameters) ? parameters : { type: 'object', properties: {} },
    });
  }
  return declarations.length === 0 ? [] : [{ functionDeclarations: declarations }];
}

/** A tool_choice in Gemini's shape. */
function geminiToolChoice(api: ClientApi, choice: unknown): Json | null {
  if (api === 'openai') {
    if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
    if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === 'string') {
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] } };
    }
    return { functionCallingConfig: { mode: 'AUTO' } };
  }
  if (isRecord(choice)) {
    if (choice.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
    if (choice.type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    if (choice.type === 'tool' && typeof choice.name === 'string') {
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
    }
  }
  return { functionCallingConfig: { mode: 'AUTO' } };
}

/** An OpenAI chat body as an Anthropic Messages body. */
function openAIToAnthropic(body: Json, model: string): Json {
  const messages: Json[] = [];
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') continue; // the system prompt travels in `system`
    if (raw.role === 'tool' || raw.role === 'function') {
      messages.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: str(raw.tool_call_id), content: toolResultText(raw.content) },
        ],
      });
      continue;
    }
    if (raw.role === 'assistant') {
      const blocks: Json[] = [];
      const text = typeof raw.content === 'string' ? raw.content : textOf(raw.content);
      if (text !== '') blocks.push({ type: 'text', text });
      for (const call of Array.isArray(raw.tool_calls) ? raw.tool_calls : []) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        blocks.push({
          type: 'tool_use',
          id: str(call.id) || 'toolu_call',
          name: str(call.function.name),
          input: argumentsOf(call.function.arguments),
        });
      }
      messages.push({ role: 'assistant', content: blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks });
      continue;
    }
    messages.push({ role: 'user', content: anthropicBlocksFromOpenAI(raw.content) });
  }
  const out: Json = { model, messages };
  const system = openAISystemText(body);
  if (system !== '') out.system = system;
  const maxTokens = num(body.max_tokens) ?? num(body.max_completion_tokens);
  if (maxTokens !== null) out.max_tokens = maxTokens;
  if (num(body.temperature) !== null) out.temperature = body.temperature;
  if (num(body.top_p) !== null) out.top_p = body.top_p;
  const stops = stringList(body.stop);
  if (stops.length > 0) out.stop_sequences = stops;
  const tools = anthropicTools(body.tools);
  if (tools.length > 0) out.tools = tools;
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (choice === 'auto') out.tool_choice = { type: 'auto' };
    else if (choice === 'required') out.tool_choice = { type: 'any' };
    else if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === 'string') {
      out.tool_choice = { type: 'tool', name: choice.function.name };
    }
  }
  return out;
}

/** An Anthropic Messages body as an OpenAI chat body. */
function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOf(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    if (typeof raw.content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content: raw.content });
      continue;
    }
    if (!Array.isArray(raw.content)) continue;
    if (assistant) {
      const calls: Json[] = [];
      for (const block of raw.content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        calls.push({
          id: str(block.id) || 'toolu_call',
          type: 'function',
          function: { name: str(block.name), arguments: JSON.stringify(isRecord(block.input) ? block.input : {}) },
        });
      }
      const text = textOf(raw.content);
      messages.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const parts: Json[] = [];
    for (const block of raw.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: str(block.tool_use_id),
          content: toolResultText(block.content),
        });
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
      else if (block.type === 'image' && isRecord(block.source)) {
        const source = block.source;
        if (source.type === 'base64' && typeof source.data === 'string') {
          const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
          parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } });
        } else if (source.type === 'url' && typeof source.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: source.url } });
        }
      }
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const out: Json = { model, messages };
  const maxTokens = num(body.max_tokens);
  if (maxTokens !== null) out.max_tokens = maxTokens;
  if (num(body.temperature) !== null) out.temperature = body.temperature;
  if (num(body.top_p) !== null) out.top_p = body.top_p;
  const stops = stringList(body.stop_sequences);
  if (stops.length > 0) out.stop = stops;
  const tools = openAITools(body.tools);
  if (tools.length > 0) out.tools = tools;
  if (isRecord(body.tool_choice)) {
    if (body.tool_choice.type === 'auto') out.tool_choice = 'auto';
    else if (body.tool_choice.type === 'any') out.tool_choice = 'required';
    else if (body.tool_choice.type === 'none') out.tool_choice = 'none';
    else if (body.tool_choice.type === 'tool' && typeof body.tool_choice.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    }
  }
  return out;
}

/** Either client body as a Gemini generateContent body. */
function toGemini(api: ClientApi, body: Json): Json {
  const contents: Json[] = [];
  const system = api === 'openai' ? openAISystemText(body) : textOf(body.system);

  if (api === 'openai') {
    for (const raw of Array.isArray(body.messages) ? body.messages : []) {
      if (!isRecord(raw) || raw.role === 'system') continue;
      if (raw.role === 'tool' || raw.role === 'function') {
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: str(raw.name) || 'tool', response: { result: toolResultText(raw.content) } } }],
        });
        continue;
      }
      const parts: Json[] = [];
      if (typeof raw.content === 'string') parts.push({ text: raw.content });
      else if (Array.isArray(raw.content)) {
        for (const part of raw.content) {
          if (!isRecord(part)) continue;
          if (part.type === 'text' && typeof part.text === 'string') parts.push({ text: part.text });
          else if (part.type === 'image_url') {
            const image = isRecord(part.image_url) ? part.image_url : null;
            const split = image === null ? null : splitDataUrl(image.url);
            if (split !== null) parts.push({ inlineData: { mimeType: split.mediaType, data: split.data } });
            else if (image !== null && typeof image.url === 'string') parts.push({ fileData: { fileUri: image.url } });
          }
        }
      }
      for (const call of raw.role === 'assistant' && Array.isArray(raw.tool_calls) ? raw.tool_calls : []) {
        if (!isRecord(call) || !isRecord(call.function)) continue;
        parts.push({ functionCall: { name: str(call.function.name), args: argumentsOf(call.function.arguments) } });
      }
      contents.push({ role: raw.role === 'assistant' ? 'model' : 'user', parts: parts.length === 0 ? [{ text: '' }] : parts });
    }
  } else {
    for (const raw of Array.isArray(body.messages) ? body.messages : []) {
      if (!isRecord(raw)) continue;
      const parts: Json[] = [];
      if (typeof raw.content === 'string') parts.push({ text: raw.content });
      else if (Array.isArray(raw.content)) {
        for (const block of raw.content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') parts.push({ text: block.text });
          else if (block.type === 'image' && isRecord(block.source)) {
            if (block.source.type === 'base64' && typeof block.source.data === 'string') {
              const media = typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png';
              parts.push({ inlineData: { mimeType: media, data: block.source.data } });
            } else if (block.source.type === 'url' && typeof block.source.url === 'string') {
              parts.push({ fileData: { fileUri: block.source.url } });
            }
          } else if (block.type === 'tool_use') {
            parts.push({ functionCall: { name: str(block.name), args: isRecord(block.input) ? block.input : {} } });
          } else if (block.type === 'tool_result') {
            parts.push({ functionResponse: { name: 'tool', response: { result: toolResultText(block.content) } } });
          }
        }
      }
      contents.push({ role: raw.role === 'assistant' ? 'model' : 'user', parts: parts.length === 0 ? [{ text: '' }] : parts });
    }
  }

  const out: Json = { contents };
  if (system !== '') out.systemInstruction = { parts: [{ text: system }] };
  const tools = geminiTools(api, body.tools);
  if (tools.length > 0) {
    out.tools = tools;
    const choice = geminiToolChoice(api, body.tool_choice);
    if (choice !== null) out.toolConfig = choice;
  }
  const config: Json = {};
  const maxTokens = api === 'openai' ? num(body.max_tokens) ?? num(body.max_completion_tokens) : num(body.max_tokens);
  if (maxTokens !== null) config.maxOutputTokens = maxTokens;
  if (num(body.temperature) !== null) config.temperature = body.temperature;
  if (num(body.top_p) !== null) config.topP = body.top_p;
  const stops = api === 'openai' ? stringList(body.stop) : stringList(body.stop_sequences);
  if (stops.length > 0) config.stopSequences = stops;
  if (asksJsonMode(body)) config.responseMimeType = 'application/json';
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

/**
 * The provider request for one client body: its route path (relative to the provider's base) and its body.
 * A provider on the client's own wire gets the body untouched but for the model (and no stream: this entry
 * writes the client's stream itself); the others get a faithful translation.
 */
export function upstreamRequest(providerWire: Wire, api: ClientApi, body: Json, model: string): UpstreamRequest {
  if (providerWire === 'openai') {
    if (api === 'openai') {
      const out: Json = { ...body, model, stream: false };
      delete out.stream_options;
      return { path: '/v1/chat/completions', body: out };
    }
    return { path: '/v1/chat/completions', body: anthropicToOpenAI(body, model) };
  }
  if (providerWire === 'anthropic') {
    if (api === 'anthropic') {
      const out: Json = { ...body, model, stream: false };
      delete out.stream_options;
      return { path: '/v1/messages', body: out };
    }
    return { path: '/v1/messages', body: openAIToAnthropic(body, model) };
  }
  return {
    path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    body: toGemini(api, { ...body, model }),
  };
}

// ---------------------------------------------------------------------------------------------
// The answer, read from the provider's wire
// ---------------------------------------------------------------------------------------------

/** The stop reason family every wire shares: a normal stop, a cap hit, a tool call, a filter. */
export type StopFamily = 'stop' | 'length' | 'tool' | 'filter';

export interface ToolCall {
  id: string;
  name: string;
  args: Json;
}

export interface ProviderAnswer {
  text: string;
  toolCalls: ToolCall[];
  family: StopFamily;
  usage: { input: number; output: number };
}

function familyOf(reason: unknown): StopFamily {
  if (reason === 'length' || reason === 'max_tokens' || reason === 'MAX_TOKENS') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call' || reason === 'tool_use') return 'tool';
  if (reason === 'content_filter' || reason === 'refusal' || reason === 'SAFETY') return 'filter';
  return 'stop';
}

/** Read a whole (non-streamed) provider answer. Null when it is not one of its wire's answers. */
export function readAnswer(providerWire: Wire, body: unknown): ProviderAnswer | null {
  if (!isRecord(body)) return null;
  if (providerWire === 'openai') {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : null;
    if (choice === null) return null;
    const message = isRecord(choice.message) ? choice.message : {};
    const usage = isRecord(body.usage) ? body.usage : {};
    const toolCalls: ToolCall[] = [];
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (!isRecord(call) || !isRecord(call.function)) continue;
      toolCalls.push({ id: str(call.id), name: str(call.function.name), args: argumentsOf(call.function.arguments) });
    }
    return {
      text: typeof message.content === 'string' ? message.content : textOf(message.content),
      toolCalls,
      family: toolCalls.length > 0 ? 'tool' : familyOf(choice.finish_reason),
      usage: { input: num(usage.prompt_tokens) ?? 0, output: num(usage.completion_tokens) ?? 0 },
    };
  }
  if (providerWire === 'anthropic') {
    const blocks = Array.isArray(body.content) ? body.content : null;
    if (blocks === null) return null;
    const usage = isRecord(body.usage) ? body.usage : {};
    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: str(block.id), name: str(block.name), args: isRecord(block.input) ? block.input : {} });
      }
    }
    return {
      text,
      toolCalls,
      family: toolCalls.length > 0 ? 'tool' : familyOf(body.stop_reason),
      usage: { input: num(usage.input_tokens) ?? 0, output: num(usage.output_tokens) ?? 0 },
    };
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : null;
  if (candidate === null) return null;
  const content = isRecord(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const toolCalls: ToolCall[] = [];
  let text = '';
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string') text += part.text;
    else if (isRecord(part.functionCall)) {
      toolCalls.push({
        id: `call_${toolCalls.length}`,
        name: str(part.functionCall.name),
        args: isRecord(part.functionCall.args) ? part.functionCall.args : {},
      });
    }
  }
  const meta = isRecord(body.usageMetadata) ? body.usageMetadata : {};
  return {
    text,
    toolCalls,
    family: toolCalls.length > 0 ? 'tool' : familyOf(candidate.finishReason),
    usage: { input: num(meta.promptTokenCount) ?? 0, output: num(meta.candidatesTokenCount) ?? 0 },
  };
}

// ---------------------------------------------------------------------------------------------
// The client's answer
// ---------------------------------------------------------------------------------------------

/** The client's own stop reason for a family. */
export function clientStopReason(api: ClientApi, family: StopFamily): string {
  if (api === 'openai') {
    if (family === 'length') return 'length';
    if (family === 'tool') return 'tool_calls';
    if (family === 'filter') return 'content_filter';
    return 'stop';
  }
  if (family === 'length') return 'max_tokens';
  if (family === 'tool') return 'tool_use';
  if (family === 'filter') return 'refusal';
  return 'end_turn';
}

/** A Chat Completions completion for a whole provider answer. */
export function openAICompletion(answer: ProviderAnswer, model: string): Json {
  const message: Json = { role: 'assistant', content: answer.text };
  if (answer.toolCalls.length > 0) {
    message.tool_calls = answer.toolCalls.map((call, i) => ({
      id: call.id === '' ? `call_${i}` : call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
  }
  return {
    id: 'chatcmpl-aggregate',
    object: 'chat.completion',
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, message, finish_reason: clientStopReason('openai', answer.family), logprobs: null }],
    usage: {
      prompt_tokens: answer.usage.input,
      completion_tokens: answer.usage.output,
      total_tokens: answer.usage.input + answer.usage.output,
    },
  };
}

/** An Anthropic message for a whole provider answer. */
export function anthropicMessage(answer: ProviderAnswer, model: string): Json {
  const content: Json[] = [];
  if (answer.text !== '') content.push({ type: 'text', text: answer.text });
  for (const call of answer.toolCalls) {
    content.push({ type: 'tool_use', id: call.id === '' ? 'toolu_call' : call.id, name: call.name, input: call.args });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: 'msg_aggregate',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: clientStopReason('anthropic', answer.family),
    stop_sequence: null,
    usage: { input_tokens: answer.usage.input, output_tokens: answer.usage.output },
  };
}

/** The pieces a text is streamed in: fixed size, so two runs write the same bytes. */
const DELTA_CHARS = 24;

function pieces(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += DELTA_CHARS) out.push(text.slice(at, at + DELTA_CHARS));
  return out;
}

/** One server-sent event: the event name when the wire names it, the JSON data line, then the blank line. */
function frame(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** The Chat Completions event stream for a whole answer: role chunk, content, one finish, usage, [DONE]. */
export function openAIStreamText(answer: ProviderAnswer, model: string): string {
  const chunk = (delta: Json, finish: string | null): Json => ({
    id: 'chatcmpl-aggregate',
    object: 'chat.completion.chunk',
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const out: string[] = [frame(null, chunk({ role: 'assistant', content: '' }, null))];
  for (const piece of pieces(answer.text)) out.push(frame(null, chunk({ content: piece }, null)));
  for (const call of answer.toolCalls) {
    out.push(
      frame(
        null,
        chunk(
          {
            tool_calls: [
              {
                index: answer.toolCalls.indexOf(call),
                id: call.id === '' ? `call_${answer.toolCalls.indexOf(call)}` : call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
          null,
        ),
      ),
    );
  }
  out.push(frame(null, chunk({}, clientStopReason('openai', answer.family))));
  out.push(
    frame(null, {
      id: 'chatcmpl-aggregate',
      object: 'chat.completion.chunk',
      created: FIXED_CREATED,
      model,
      choices: [],
      usage: {
        prompt_tokens: answer.usage.input,
        completion_tokens: answer.usage.output,
        total_tokens: answer.usage.input + answer.usage.output,
      },
    }),
  );
  out.push('data: [DONE]\n\n');
  return out.join('');
}

/** The Anthropic event stream for a whole answer, in the Messages API's order. */
export function anthropicStreamText(answer: ProviderAnswer, model: string): string {
  const out: string[] = [];
  out.push(
    frame('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_aggregate',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: answer.usage.input, output_tokens: 0 },
      },
    }),
  );
  let index = 0;
  if (answer.text !== '') {
    out.push(frame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
    for (const piece of pieces(answer.text)) {
      out.push(frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }));
    }
    out.push(frame('content_block_stop', { type: 'content_block_stop', index }));
    index += 1;
  }
  for (const call of answer.toolCalls) {
    out.push(
      frame('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: call.id === '' ? `toolu_${index}` : call.id, name: call.name, input: {} },
      }),
    );
    out.push(
      frame('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) },
      }),
    );
    out.push(frame('content_block_stop', { type: 'content_block_stop', index }));
    index += 1;
  }
  out.push(
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: clientStopReason('anthropic', answer.family), stop_sequence: null },
      usage: { output_tokens: answer.usage.output },
    }),
  );
  out.push(frame('message_stop', { type: 'message_stop' }));
  return out.join('');
}

/** GET /v1/models in OpenAI's list shape. */
export function openAIModelList(models: readonly { id: string; provider: string }[]): Json {
  return {
    object: 'list',
    data: models.map((m) => ({ id: m.id, object: 'model', created: FIXED_CREATED, owned_by: m.provider })),
  };
}

/** GET /v1/models in Anthropic's list shape. */
export function anthropicModelList(models: readonly { id: string; display_name: string }[]): Json {
  return {
    data: models.map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: '2026-01-01T00:00:00Z' })),
    has_more: false,
  };
}

/** An error in the client wire's own envelope. */
export function errorBody(api: ClientApi, type: string, message: string): Json {
  if (api === 'anthropic') return { type: 'error', error: { type, message } };
  return { error: { message, type, param: null, code: null } };
}
