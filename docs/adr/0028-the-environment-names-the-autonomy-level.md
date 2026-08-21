---
status: accepted
---

# The environment names the autonomy level

Droid runs a step under an autonomy level, and the level lives in the
environment of the machine, not in the flow.

```bash
ORCHY_DROID_AUTO=medium orchy run flow.yaml   # this runs
```

```yaml
harness: droid
auto: medium                                  # this does not exist
```

Orchy names `high` when the variable is absent, because no one sits at the
keyboard of a step. A value that names no level fails the run before the first
step starts.

## Why

The adapter wrote `--auto high` and nothing could change it. An organisation
caps the level of the `droid` command in its own settings, and a machine under
a cap below `high` fails every droid step, at the door of the command. The user
who met this holds such a cap. So a real flow fails without this, which is the
one reason [AGENTS.md](../../AGENTS.md) accepts for a new knob.

The level is not a second tool list. Invariant 1 still bounds what exists:
`--enabled-tools` names the tools, and the level only says which of them run
without a question. A level below `high` therefore takes work away from a step
and adds none: droid asks, no person answers, and the step fails or comes back
short. The knob exists to make a step run at all where `high` is refused. It is
not a way to make a step safer, and the documents say so.

## Why not a field of the flow

A flow is data, and the same data runs on every machine. See [ADR
0004](./0004-a-flow-is-data-not-code.md). The cap belongs to one organisation
and one machine, so a flow that wrote `auto: medium` would carry one machine's
policy to every other, and a flow that wrote `auto: high` would still fail
under the cap. The value answers "what may this machine do", as
`CLAUDE_CONFIG_DIR` does, and not "what does this flow need".

The same reason keeps it off the command line. A run starts from the command,
from the daemon, from a schedule, and from an agent through MCP. One variable
reaches all four. A flag reaches one.

## Why the whole run, and not one step

One level holds for every droid step of a run. A per-step level would be a
field of the flow, and the part above refuses that.

## Consequences

`AUTONOMY` in `harness.ts` holds the variable, the levels, and the fallback. It
sits beside `SUPPLIES` and `MODELS`, for the reason those tables give: the
runner reads it without loading an adapter. Droid alone reads a level, so it is
one row and not a table. A second harness with a level makes it one.

`execute()` refuses a value that names no level, on a run and on a resume, so a
misspelling costs no token. The adapter reads the same rule when it starts the
command, so the two cannot drift.

Droid names the level in its own words when it refuses one. Those words ask the
adapter for one more sentence on the error, which names the variable. A reason
that names no level costs that sentence and nothing else.

## What would change this

Droid is not installed on the machine where this was written, so the three
levels come from the documentation of the command and not from a probe here. A
release that adds a level makes `AUTONOMY.levels` wrong, and Orchy then refuses
a level that droid accepts. The list is one line, and a probe of
`droid exec --help` corrects it.

A second harness that reads an autonomy level turns the row into a table, keyed
by the adapter name, as `SUPPLIES` and `MODELS` already are.
