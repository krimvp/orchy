# Changelog

Every notable change to Orchy is written here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the version numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Orchy is below 1.0, so a minor version may still change the API. What changes is
named here.

## [Unreleased]

### Fixed
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
