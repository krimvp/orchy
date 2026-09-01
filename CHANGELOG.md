# Changelog

Every notable change to Orchy is written here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the version numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Orchy is below 1.0, so a minor version may still change the API. What changes is
named here.

## [Unreleased]

### Added
- A cycle that reaches its limit under the `accept` policy says so: the run
  emits an `accept` event, the console prints `≠`, and the page says the step
  still disagrees. Before, the console printed `✓` and `— done`, and a reader
  took that for agreement.
- The `cycle` event carries `limit` beside `count`, so the console and the page
  say `1 of 3` instead of `1`.
- `orchy runs` prints a header, says why a failed run failed, and names the
  step a waiting run waits for. The `--events` rows carry `error`.
- `orchy check` names what a valid flow takes, each value with its type, and
  the `--with` that supplies them.
- A run that waits prints the contract its answer must match, beside the
  `orchy resume` command that gives it.
- The run state holds `startedAt`. A run that stopped at a gate before any
  step ran had no time at all, and every list sorted it last.
- `orchy run --help` prints the help, as `orchy --help` does.

### Changed
- A `validate()` refusal names the fix: a tool that does not exist lists the
  tools that do, a tool the harness lacks names the harness that has it, a
  field a flow cannot hold lists the fields it holds, and a promise under
  `workspace: { kind: none }` says the workspace is `none` instead of sending
  the reader to look for a field the flow has.

### Fixed
- A flag on a command that does not take it passed in silence: `orchy run
  flow.yaml --from fix` ran the whole flow from the top. Every command now
  refuses a flag it does not take, a flag given twice, and a flag with no value
  after it, and ends with `2`.
- A directory, or a file that is not a flow file, met the loader of Node and
  got its words. Both are refused with the file to name.
- A run's row carries `error`: why the run failed, as the fault of the run
  itself or the failed step's error under the step's name. The runs list and a
  flow's runs list show it on the row, so a person reads why without opening
  the run. The index adds the column to a database from before it.
- A gate folds the answers of the steps behind its needs under "What the steps
  further back answered", so the why behind an answer stands one unfold away
  instead of a walk through the drawing.
- An attempt that a loop dropped shows what it ended as and, when it failed,
  its reason — the reason is what a person opens that fold to read.
- The feed says why a step failed, where it said only `ended failed`.

### Changed
- The planning-poker flow takes a task of at least one character, so an empty
  task is refused at the door and not sized by three estimators.

## [0.0.2] - 2026-08-13

### Added
- A third harness adapter: `droid`, the coding agent of Factory. A flow writes
  `harness: droid` and the id droid reads, as
  `model: "custom:glm-5.2-[Ollama-Cloud]-0"`. A custom model in
  `~/.factory/config.json` — Ollama Cloud among them — serves a step without a
  Factory account. Droid supplies every tool but `orchy`, reports no cost, and
  its adapter reads the contract value out of the answer, because the `droid`
  command takes no schema. The runner still checks the value against the real
  schema.

### Changed
- The landing page says what `orchy mcp` gives an agent — ten tools, and a flow
  refused at the write when it does not validate — and that a step reaches the
  same door with the `orchy` tool, under the bound that `starts` declares.

### Fixed
- The README, ADR 0003, and `docs/api/atif.md` promised the four ATIF names for
  `final_metrics`, and `src/atif.ts` writes the per-step names there. The
  trajectory is ATIF everywhere else. All three now name the deviation, which
  the sweep recorded and nothing closed.
- `docs/plan.md` mapped the package to the bare import `orchy`, said a component
  loads through the loader Pi uses — Orchy imports it, and Node strips the types
  — and named a version the project has left.
- `docs/sweep.md` counted 568 runs of 545, and its last part read as the state
  of the product where it is the record of the sweep. `docs/sweep/00-matrix.md`
  sent a reader to `BRIEF.md`, which is `00-brief.md`.
- Nothing but `docs/usability.md` linked `docs/sweep.md`. The README and
  AGENTS.md name it now.
- The landing page counted eight flows, and twenty ship: eight in `examples/`
  and twelve in `flows/`, which no document but `docs/usability.md` named. The
  README now points at them too.
- The run on the landing page showed steps that its own flow file does not
  hold, a gate form under a contract the flow does not declare, a budget that
  neither flow declares, and a value outside the contract shown beside it. It
  shows what those flows really do. A step whose value fires a cycle is `done`,
  not `failed`, so it no longer reads as a failure.
- The landing page said `examples/code-review` runs two harnesses; it names one
  harness and one model, and the cycle escalates to a person at its limit.
- `docs/running.md` said a step cannot both fan out and cycle. ADR 0021 narrowed
  that: a fanout cycles to itself, and each member retries its own work. It also
  said Orchy uses one model for the whole flow, which a step has overridden
  since ADR 0012.
- `docs/api/index.md` mapped the package to the bare import `orchy`. It is
  `@krimvp/orchy`.
- `docs/api/cli.md` named four commands, and there are six: `check` and `runs`
  were missing.
- `docs/api/store.md` gave `runs()` a limit as its first argument, where it takes
  a flow path; its example built an event of a type that no run emits; and it
  cited ADR 0008 for the index, which is ADR 0009.
- `docs/api/flow.md` passed prompt text where a prompt is the path of a file.
- `docs/api/harness.md` left `prompt` out of the kinds a `Note` takes, and `run`
  out of an `AgentRequest`. `docs/api/daemon.md` left the gate a resume names
  out of `resume()`. `docs/api/server.md` named a `serve` command; it is
  `orchy daemon`.
- `docs/shape.md` claimed to name every field that runs, and named neither
  `command` on a call step nor `starts` on an agent step.
- The two flow files on the landing page now pass `validate()`. One fanned out
  with a syntax Orchy has never had, both wrote a contract that Ajv refuses in
  strict mode, and one asked `pi` for the `web` tool, which only `claude`
  supplies.
- The flow at the top of the README declared a `budget` beside a step on a free
  provider, which reports no cost — a run Orchy refuses. It declares none now,
  and the README says where a budget belongs.
- `docs/running.md` said a provider whose prices are all zero reports a cost of
  zero and never stops a budgeted run. It reports no cost, and it does stop one.
- `docs/api/cli.md` said a waiting run exits `0`. It exits `3`.
- ADR 0008 said the daemon never rewrites the state on disk. It writes one word
  there: the `stopped` of a run no child drives.
- `docs/api/workspace.md` described `Snapshot.files` as the porcelain status
  alone. Each value also carries a short hash of what the file holds.
- The docs called Orchy "not on npm yet", and registered the MCP server as
  `npx orchy mcp`. The package is `@krimvp/orchy`.

## [0.0.1] - 2026-08-13

The first release on npm, as `@krimvp/orchy`. The bare name `orchy` belongs to
another package, so the scope carries it; the command the package installs is
still `orchy`.

### Added
- A flow declares its steps in TypeScript or YAML, and the run enforces what it
  declares: the value each step takes and returns, the tools it may reach, the
  files it may change, and the budget the whole run may spend.
- Four step kinds: `agent` for a model, `call` for a component of your own,
  `gate` for a person, and `flow` for a whole flow reused as one step.
- Control flow on a step: a condition, a cycle that sends the run back, and a
  fanout that runs one step once for each member.
- Two harnesses, `pi` and `claude`. A step names its own harness and model, so
  one flow may write with one model and review with another.
- A run is a state machine on disk. It writes its state after every step, so
  `orchy resume` continues a run that a gate held, a failure stopped, or a crash
  cut short.
- `orchy run`, `check`, `resume`, `runs`, `daemon`, and `mcp` on the command
  line, and `--events` for a parent process that reads one JSON event per line.
- A daemon with a web UI that draws the flows, the runs, and the events, and
  answers a gate.
- An MCP server, so an agent may start a flow and answer a gate.
- `npm run build` compiles `src` to `dist` for the published package. A clone
  still runs the TypeScript as it stands, because Node strips the types, but
  Node refuses to strip the types of a file under `node_modules`, so what ships
  is JavaScript. A file that Orchy starts or loads by name — the CLI a harness
  spawns, and a shipped component — now takes the extension it is running under,
  so both halves work.
- A release goes out from GitHub: publishing a Release whose tag is `vX.Y.Z`
  builds, publishes to npm with provenance, and opens a PR that brings
  `package.json` on `main` to the version that went out. See
  [.github/workflows/README.md](./.github/workflows/README.md).
