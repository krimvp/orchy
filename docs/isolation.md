# Isolation

[Issue 4](https://github.com/krimvp/orchy/issues/4) asks whether Orchy can hold
a Pi setup of its own. This document studies that question. It holds no
decision. It names what a Pi step reads today, what each answer costs, and which
part of the ask the flow data already answers.

The issue holds three asks.

1. A Pi step must not read `~/.pi`, and must not read the `.pi` folder of the
   project.
2. A flow declares the Pi extensions it needs, and Orchy installs them apart.
3. A later step, or a later run, recovers the state of an earlier one.

## What a Pi step reads today

`src/pi.ts` calls `getAgentDir()`, `SettingsManager.create(cwd, agentDir)`, and
`DefaultResourceLoader`. Each one reads a file that no flow names.

| What | Where it comes from | What it changes |
| --- | --- | --- |
| Global settings | `~/.pi/agent/settings.json` | the default model, the extensions, the skills, the proxy |
| Project settings | `<cwd>/.pi/settings.json` | the same fields, and it wins |
| Extensions and skills | both settings files, and both `.pi` folders | a provider, a prompt, a hook |
| Context files | every `AGENTS.md` from the workspace to the root of the disk | what the model reads first |
| The session file | `~/.pi/agent/sessions/` | where the record of the step lands |

The project level is on by default. `SettingsManager.create` reads
`projectTrusted` and the value is `true` when a caller names none, and Orchy
names none. So a `.pi` folder in the workspace changes a run, and nothing says
so.

The issue is right about the cost. Two people who run the same flow on the same
commit get two different runs, and neither flow file records the difference.
This is the fault that AGENTS.md rates as the most expensive: a rule that looks
enforced and is not. Invariant 1 says a step calls only the tools it declares.
It says nothing about the model the step ends up on, or the text the model reads
before the prompt.

## Ask 1 — a configuration the flow never declared

Pi holds every door already. No fork, and no new dependency.

| Door | What it closes | Where |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | moves `~/.pi/agent` to a path Orchy owns | `dist/config.js` |
| `SettingsManager.inMemory({}, { projectTrusted: false })` | both settings files | `dist/core/settings-manager.js` |
| `noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes` | every resource of the user | `DefaultResourceLoaderOptions` |
| `noContextFiles` | every `AGENTS.md` above the step | the same |
| `SessionManager.create(cwd, sessionDir)` | moves the record into `.orchy` | `dist/core/session-manager.js` |

So the closing itself is cheap. The cost sits in one place: the model.

`ModelRuntime.create()` reads `auth.json` and `models.json` under the agent
directory. A move of that directory moves the key with it. Every flow that runs
today stops running, because the provider the flow names is in the file that
just moved.

The line to draw is between the model and the behaviour.

- **The model is the harness's own.** The README already says it: "Orchy holds
  no credential and no model catalogue." A flow names `ollama/glm-5.2`, and the
  key behind that name belongs to the machine. `CreateModelRuntimeOptions` holds
  `authPath` and `modelsPath`, so Orchy keeps pointing both at the real home.
- **The behaviour is the flow's own.** A default model, an extension, a skill, a
  prompt, and an `AGENTS.md` all change the result of a step. A flow does not
  name them, so a step must not read them.

That split closes the hole and keeps every flow running. It needs no field on a
flow, so it adds no knob: the assumption is that a step reads no behaviour it
did not declare.

Two limits stand.

- **`bash` walks through it.** A step with `bash` runs `pi` itself, and that
  process reads the real home again. ADR 0018 states this shape of limit
  already, and the answer stays the same: only a sandbox closes it.
- **The rule would be Pi's alone.** The `claude` command reads the account it
  is logged in to, and `~/.claude`. The `droid` command reads
  `~/.factory/config.json`. `claude.ts` already passes `--strict-mcp-config`,
  which closes one door of the three. So a rule stated for Pi alone is a rule
  that depends on the harness, and ADR 0012 put `harness` on the flow to stop
  exactly that. The study of ask 1 for Pi is the first third of the work, not
  the whole of it.

## Ask 2 — a flow declares its extensions

The issue proposes this shape.

```yaml
name: code-and-review
harness: pi
extensions:
  - npm:pi-mcp-adapter
  - npm:pi-web-access
model: claude-opus-4-5
```

The installation half is free once ask 1 lands. `DefaultPackageManager` takes
`agentDir` and writes under it, so an agent directory that Orchy owns already
puts every package apart from the user. That is the `.pi-home` folder of the
prototype, and Orchy needs no code of its own for it.

The tool half does not work as written.

Pi filters an extension tool through the same allowlist as a built-in one.
`dist/core/sdk.js` builds `allowedToolNames` from `options.tools`, and `pi.ts`
passes `[...request.tools, submit_result]`. So an extension loads, registers a
tool, and the step cannot call it. Invariant 1 holds, and the `extensions` field
gives the step nothing.

To make the tool reachable, the step must name it. `TOOLS` in `harness.ts` holds
nine names, the set is closed, and `GET /api/health` serves it so the editor can
draw the list. A name that only Pi knows does not fit that set.

There is already a tool of this shape, and it points at the answer. `orchy` is
one name in the closed set. `claude.ts` maps it to an MCP server it starts
itself. `droid.ts` maps it to nothing, and `SUPPLIES.droid` leaves it out, so
`validate()` refuses the flow before the run spends a token. The same three
lines would carry a memory tool, or a web tool, or any other server: one name
that Orchy holds, one mapping in each adapter, and one row of `SUPPLIES` that
says which harness has it.

`extensions:` is the other road. It names a package, not a capability. It works
under one harness of three, and a flow that holds it stops being portable, which
is what the owner answered in the thread. Under Pi that field is how the
capability gets built; it is not how a flow asks for one.

So the two roads meet: Orchy names a tool, the Pi adapter installs the extension
that supplies it, and the flow never says the word `npm`.

The interactive mode of the prototype belongs beside this, not inside a run. A
person who configures `pi-mcp-adapter` runs Pi by hand against the agent
directory Orchy owns. No step of a flow waits for a person, except a gate.

## Ask 3 — state across steps

The issue asks for a memory extension, a working folder named by a ticket, and a
follow-up flow that recovers what the first agent knew.

Most of that exists, under other names.

- `.orchy/runs/<run id>/` already holds `state.json` and `trajectory.json`. The
  run is the state on disk (ADR 0005), and the run id already names the folder.
- The value of every step that passed stays in that file. `orchy resume` goes
  back to a step, and every earlier step keeps its work (ADR 0023).
- A flow takes values and returns one (ADR 0015). A value that crosses steps is
  the value of a step, and the runner carries it already.

A memory extension answers the same question in a place Orchy cannot read.
Invariant 2 checks a value against a schema. It cannot check a note that a model
wrote into a folder. So a memory would be state that no rule covers, beside
state that every rule covers.

One part of the ask is real, and the flow data does not hold it. A run cannot
start from the value of an earlier run. `orchy resume` works inside one run
only, and a second run takes only what a person supplies. Stated as a value the
translation is small: a flow `takes` the value of a named step of a named run,
and Orchy reads it from the state on disk. It stays JSON, invariant 2 still
checks it, and it works under all three harnesses.

The second half — recover the messages, not the value — is a harness question
again. Pi can continue a session file. `claude.ts` writes a fresh session id on
purpose, so a step stays out of the transcript that started it. `droid.ts`
records that a session continues only under a Factory login. So a flow that
carried a conversation forward would run under one harness and fail under
another, and that is the shape ADR 0012 refuses.

## What this adds up to

| Ask | Where it lands | What it costs |
| --- | --- | --- |
| Close the user and project configuration | the Pi adapter, and later the other two | keep `authPath` and `modelsPath` on the real home, or every flow stops running |
| Install extensions apart | free, once the agent directory moves | none |
| A flow names an extension | refused as written | it is Pi's alone, and `validate()` cannot check it |
| A flow names a tool that an extension supplies | `TOOLS`, `SUPPLIES`, and one mapping in each adapter | the same three lines the `orchy` tool cost |
| Memory across steps | already the value of a step | none |
| A run reads the value of an earlier run | a field on `takes` | small, and it stays JSON |
| A run continues the conversation of an earlier run | refused | it works under one harness of three |

Nothing here is a decision. A decision that closes a door on a run belongs in
`docs/adr/`, and it needs a live run against a real model first, because reading
a package is not knowledge of it.

## What I ran

Node 22.22.2, `@earendil-works/pi-coding-agent` 0.84.1. One script builds the
managers the way `src/pi.ts` builds them, against a project that holds a
`.pi/settings.json` and an `AGENTS.md` that no flow names.

```
PI_CODING_AGENT_DIR = (unset)
getAgentDir() = /root/.pi/agent
today: projectTrusted = true
today: defaultProvider = the-project defaultModel = a-model-no-flow-named
today: context files = [ '/tmp/probe-project/AGENTS.md' ]
shut: defaultProvider = undefined defaultModel = undefined
shut: context files = []
session, default dir = /root/.pi/agent/sessions/--tmp-probe-project--/...jsonl
session, named dir   = /tmp/probe-home/sessions/...jsonl
```

The same script, with `PI_CODING_AGENT_DIR` set and the workspace two folders
deep under a parent that holds its own `AGENTS.md`:

```
getAgentDir() = /tmp/probe-home/agent
context files = [ '/tmp/probe-tree/AGENTS.md', '/tmp/probe-tree/a/b/AGENTS.md' ]
```

So a Pi step reads the settings of the project, and reads every `AGENTS.md` from
the workspace up to the root of the disk. The doors that close both are in the
package already.
