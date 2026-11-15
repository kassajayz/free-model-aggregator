# free model aggregator

One Node 22 server, standard library only. It reads the trial's brief, probes the ten free-tier providers'
catalog routes in each provider's own wire, builds one catalog, registers it with the env, and serves the
client's twenty requests through the strongest free model that can answer each one.

    node main.ts --list    print the catalog this entry registers, and exit 0
    node main.ts           listen on a free port, register, serve, exit 0 when the env says done

## Layout

    main.ts            the server: routes, the register POST, the /work poll, --list
    lib/brief.ts       the brief's three documents (providers, quality table, workload manifest)
    lib/catalog.ts     the catalog probes, the catalog document, the served model list
    lib/router.ts      candidate ranking, the provider call, refusals and failover
    lib/wire.ts        the two client wires and the three provider wires, and the translation between them

## How a request is served

1. The request arrives on `/v1/chat/completions` (OpenAI) or `/v1/messages` (Anthropic), JSON or SSE.
2. Its requirements come from the workload manifest's row for it, plus whatever its own body shows: tools,
   an image, JSON mode. A model that lacks one cannot serve it.
3. Candidates are the free models that meet the requirements, ranked by the quality table's rating, so the
   strongest legal model is tried first. A provider that asks for JSON mode is only used if its wire can carry
   it: the Anthropic wire cannot, so JSON-mode requests never go there.
4. The body is translated into the provider's wire faithfully: system prompt, last user text, tool names in
   order, `max_tokens`, stop sequences, image bytes and JSON mode all arrive as the client sent them, because
   the providers echo what they parsed.
5. The provider is asked for a whole answer; this entry writes the client's own JSON or event stream. The text
   arrives whole, and the usage counts and stop reason are the provider's, in the client's wire.
6. A refusal (402, 429, 5xx) is retried once on the same provider, then that provider is out for the trial and
   the request moves to the next best model. A refusal costs a call, never the request.

Nothing reads the clock or draws at random: two runs of one trial make the same calls in the same order and
leave the same state export.

## Licence

MIT, in `LICENSE`.
