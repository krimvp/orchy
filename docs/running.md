# Run a flow

## Choose a model

Orchy does not choose a model. Pi does. Version 1 uses one model for the whole
flow, so you set it once.

Declare a provider in `~/.pi/agent/models.json`. Declare it here, and not in a
Pi extension. Pi resolves the model before an extension runs, so a provider that
an extension registers comes too late and Pi falls back to another model.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "https://ollama.com/v1",
      "api": "openai-completions",
      "apiKey": "$OLLAMA_API_KEY",
      "models": [
        {
          "id": "qwen3.5:397b",
          "name": "Qwen 3.5 397B",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 256000,
          "maxTokens": 32768,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

`apiKey` reads an environment variable when it starts with `$`.

Then name the default in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "ollama",
  "defaultModel": "qwen3.5:397b"
}
```

A model must call tools well. Orchy takes the value of a step from a
`submit_result` tool, so a model that answers in prose fails the step.

The `cost` numbers come from you. A provider with a subscription price reports
no cost for one call, so `cost_usd` in the trajectory stays at zero.

## Run

```bash
orchy run flow.yaml        # or flow.ts
```

The command prints the events to the error stream and the run state to the
output stream. It ends with 0 when the run finishes or waits, and 1 when the run
fails.

## Answer a gate

A run that reaches a gate writes its state and ends. The command prints the run
id.

```bash
orchy resume <run id> '{"approved":true}'
```

Orchy checks the value against the contract of the gate, so a wrong value is
refused before the run continues.

## Read the record

Each run writes two files to `.orchy/runs/<run id>/`:

- `state.json` — the flow, the value of every step, and the cycle counts.
- `trajectory.json` — one ATIF trajectory, with a child for each agent step.
