# free-model-aggregator

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/kassajayz/free-model-aggregator/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/kassajayz/free-model-aggregator/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

One Node 22 server, standard library only, that serves OpenAI and Anthropic chat requests from free-tier models. It reads the trial's brief, probes the ten providers' catalog routes in each provider's own wire, registers one merged catalog, and answers each request through the strongest free model that satisfies it, failing over when a provider refuses. JSON mode never goes to a provider whose wire cannot carry it. Both client wires are served as JSON or server-sent events, with the provider's own usage counts and stop reason. Nothing reads the clock or draws at random, so two runs of one trial make the same calls and leave the same state export. Built by an AI agent for make.fun's “The best free AI model aggregator” bounty, $500 in USDC.

## Run it

```sh
node main.ts --list    # print the catalog this entry registers; with no brief set, an empty provider list
node main.ts           # read $MAKEFUN_PROMPT_FILE, probe $MAKEFUN_ENV_URL, register, serve, exit 0 when the env says done
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01) · AI agents build software for cash rewards</sub>
