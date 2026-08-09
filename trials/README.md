# Trials

Fifteen flows written to run Orchy on work that is not about code, plus one
that is. They exist to exercise the parts of Orchy that the eight flows in
[examples](../examples) touch lightly: a computed fanout with a long list, a
cycle driven by a module instead of a model, a condition that skips a step, a
flow inside a flow, and the three shapes of a promise.

[RESULTS.md](./RESULTS.md) holds what every run did, what it cost, and what
broke.

| Flow | What it is | What it exercises |
| --- | --- | --- |
| [travel-itinerary](./travel-itinerary) | ten days in Japan, three angles merged into one plan | fanout with a model per member, a cycle on a **call** step, `changes: { paths }`, a gate |
| [investment-plan](./investment-plan) | a 25-year savings plan, one sleeve at a time | **computed fanout**, a condition with `gt`, a projection module, a gate |
| [deep-research](./deep-research) | four readers on the web, one brief, one fact-check | the `web` tool, `budget`, `parallel: 4`, a cycle with `policy: accept` |
| [relocation-debate](./relocation-debate) | three fixed stances on two job offers, then a judge | **cross-harness**: pi advocates, a Claude judge that shares no model with them |
| [incident-postmortem](./incident-postmortem) | an outage read through three lenses | `changes: nothing` on the flow, proved by the workspace on every step |
| [lease-review](./lease-review) | eleven clauses of a tenancy, judged one by one | computed fanout over a long list, a scoring module, a condition, a gate |
| [curriculum](./curriculum) | sixteen weeks of study for one person | computed fanout, an hours module, a retry with `policy: escalate` |
| [meal-plan](./meal-plan) | five dinners and one shopping list | computed fanout over days, a merge module, `changes: { paths }` |
| [talk-prep](./talk-prep) | a conference outline, three critics, one reviewer | a cycle held by the reviewer, not by the critics |
| [portfolio-rebalance](./portfolio-rebalance) | the trades first, the explanation after | a **module before any model**, a condition, a gate |
| [retirement-drawdown](./retirement-drawdown) | four return paths against one pot | a simulation module, `changes: { except }`, a condition with `lt` |
| [market-scan](./market-scan) | one market, three steps | a flow that declares what it takes and returns, so another flow can hold it |
| [venture-check](./venture-check) | is this business worth starting | **a flow inside a flow**, plus arithmetic the model may not overrule |
| [weekend-guide](./weekend-guide) | two days in a city, from what is open now | the cheapest useful flow: two steps, the web, a gate |
| [cross-review](./cross-review) | the flow from the front of the README, run for real | one model writes on one harness, another reviews on another, with no tool that writes |

## Run one

Each flow keeps its inputs in `fixtures/`. Copy them into a working directory
first, because the working directory is where the steps act.

```bash
mkdir -p /tmp/trip && cp trials/travel-itinerary/fixtures/* /tmp/trip && cd /tmp/trip
git init -q .                     # the flow declares a git workspace
orchy run <path to>/trials/travel-itinerary/flow.yaml --harness pi \
  --with '{"destination":"Japan (Tokyo to Osaka)","days":10,"budget_usd":4200,"travelers":"two adults"}'
```

The flows that name `ollama/...` models need a provider in
`~/.pi/agent/models.json`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "$OLLAMA_API_KEY",
      "api": "openai-completions",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [{ "id": "glm-5.2" }, { "id": "kimi-k2.7-code" }, { "id": "minimax-m2.7" }]
    }
  }
}
```
