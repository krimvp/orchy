# Orchy hunting brief — shared facts

You are hunting for real issues in Orchy (repo at `/home/user/orchy`, branch `main`).
Read `/home/user/orchy/README.md`, `AGENTS.md`, `CONTEXT.md`, and `docs/shape.md`
before you judge whether something is a fault or the design.

## Hard rules

- **Never modify anything under `/home/user/orchy`.** No edits, no `git` writes,
  no commits, no branch changes, no `npm install` there. It is read-only to you.
  Work only inside your own directory (given in your task).
- **Never run `pkill`, `killall`, or kill a process you did not start.** Other
  agents are working in this container. Kill only your own daemon, by the PID
  you captured when you started it.
- **Use only your own port** (given in your task). Nothing else.
- Do not push, do not open pull requests, do not write to `/home/user/orchy/.orchy`.

## The environment

- Node 22. Run Orchy straight from source: `node /home/user/orchy/src/cli.ts …`.
- `orchy daemon --port <yours>` serves the API and the built page at
  `http://127.0.0.1:<port>`. The page is already built in `ui/dist`.
- The daemon works in the directory it starts in, and refuses a flow file
  outside that root. Start it inside your own directory.
- The API refuses a foreign `Origin`/`Host`. From curl, send
  `-H "Origin: http://127.0.0.1:<port>"` on POST/PUT/DELETE.
- **The `claude` harness really works here** — the `claude` CLI is installed and
  authenticated. An agent step costs real money: a trivial one is ~$0.04 with the
  default model. Keep prompts tiny, prefer `model: haiku`, and do not exceed
  roughly **$2 of spend**. Deterministic `call` steps and `gate` steps cost
  nothing — use them for volume and spend model calls only where a real agent
  step is the point of the test.
- **The `pi` harness is not installed** (no `pi` binary, no `~/.pi`). Agent steps
  on `pi` will fail. How they fail — the message, where it appears, whether it
  costs a run — is itself worth testing.
- Claude model names are plain (`haiku`, `sonnet`, `opus`); pi names are
  `provider/model`. `validate()` checks the grammar, not the catalogue.
- Playwright: `playwright-core` is installed at
  `/tmp/claude-0/-home-user-orchy/b311d40f-dc91-564a-af5e-d08b95ea2a20/scratchpad/node_modules`.
  Run scripts with that directory as cwd so the import resolves. Chromium is at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

## A flow, minimally

```yaml
name: example
steps:
  - id: first
    kind: call            # runs a TypeScript module beside the flow, no model
    module: count.ts
    returns: { type: object, required: [count], properties: { count: { type: number } } }
  - id: ask
    kind: gate            # stops and waits for a person
    needs: [first]
    question: Is the count right?
    returns: { type: object, required: [approved], properties: { approved: { type: boolean } } }
```

A `call` module is a default-exported function `(inputs, say, values) => value`.
An `agent` step needs `tools` and a `prompt` file. See `docs/shape.md` for every
field, and `examples/` for whole flows.

## What counts as a finding

Anything a user would call wrong, confusing, or missing, in these areas:

- **Functional** — the engine does the wrong thing, or silently does nothing.
- **UI** — the page shows the wrong thing, breaks, or hides what matters.
- **UX** — a person cannot tell what happened or what to do next.
- **DevEx** — installing, writing a flow, reading an error, or the docs lying.
- **Observability** — you cannot tell what a run did, cost, or why it failed.

Prove every finding by running it. A claim from reading the code alone is a
hypothesis, not a finding — either run it or label it `UNVERIFIED`.

## How to report

Write your findings to the file named in your task, as Markdown, in this shape,
worst first. No preamble, no summary of what you were asked. Findings only.

```markdown
## <short title in plain words>

- **Area**: functional | ui | ux | devex | observability
- **Severity**: high | medium | low
- **What I did**: the exact commands or clicks.
- **What happened**: the output, quoted. Trim it, do not paraphrase it.
- **What I expected**: one sentence.
- **Where**: `src/file.ts:123` if you found the cause; otherwise leave it out.
```

If something works well where you expected it to break, say so at the end under
`## What held up`, in one line each. That is worth as much as a fault.
