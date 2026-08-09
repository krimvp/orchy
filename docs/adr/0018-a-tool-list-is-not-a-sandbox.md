---
status: accepted
---

# A tool list is not a sandbox

`tools` stays a flat list of names. Orchy adds no bounded tool, such as a `bash`
that names the commands it may run.

```yaml
tools: [read, bash]              # this runs
tools: ["bash(npm test:*)"]      # this does not exist, and it will not
```

## Why

Invariant 1 says that a step calls only the tools that it declares, and it says
out loud that this is not a sandbox. A step that declares `bash` can change any
file and can call the network. A bound on `bash` reads as the fix for that hole.

Orchy does not intercept a tool call. A harness runs the tool, so only a harness
can hold a bound. A bound that Orchy cannot enforce is a rule that looks
enforced and is not, which is the fault this project rates as the most
expensive. So the answer depends on the harness, and only a probe answers it.

## What I ran

Claude Code, version 2.1.226. `claude --help` says that `--allowedTools` and
`--disallowedTools` take a bounded form, and that `--tools` takes bare names:

```
--allowedTools, --allowed-tools <tools...>
    Comma or space-separated list of tool names to allow (e.g. "Bash(git *)
    Edit")
--tools <tools...>
    Specify the list of available tools from the built-in set. Use "" to
    disable all tools, "default" to use all tools, or specify tool names (e.g.
    "Bash,Edit,Read").
```

Three probes, each one `claude --print ... --output-format json --model haiku`,
each one asking the model to run `ls -la` through `Bash`:

| Flags | `permission_denials` | The command |
| --- | --- | --- |
| `--tools Bash --allowedTools "Bash(echo:*)"` | `[]` | ran |
| `--tools Bash --allowedTools ""` | `[]` | ran |
| `--tools Bash --allowedTools "Bash(echo:*)" --disallowedTools "Bash(ls:*)"` | one denial | refused |

The third probe proves that the bounded form parses and that the deny path
works. The first two prove what `--allowedTools` is: a list that runs a tool
without a prompt, and not a list that refuses everything else. `--tools` is the
list that holds invariant 1, because it decides which tools exist, and it takes
no bound. `--tools "Bash(echo:*)"` supplied no Bash tool at all, and the model
answered with the text of a tool call instead of calling one.

A deny list is the inverse of a bound. To bound `bash` to `npm test` a user must
refuse every other command, and no deny rule says "everything else".

Pi, from the installed package. `CreateAgentSessionOptions` in
`dist/core/sdk.d.ts` declares `tools?: string[]` and `excludeTools?: string[]`,
and `AgentSessionConfig` declares `allowedToolNames?: string[]`. Every one of
them holds a tool name. The bash tool takes `command: string`, and
`BashToolOptions` holds `operations`, `commandPrefix`, `shellPath`,
`exposeSessionEnvironment`, and `spawnHook`. None of them is an allow list.
`docs/security.md` of the package says it under the heading **No Built-in
Sandbox**: "Pi does not include a built-in sandbox... A partial in-process
sandbox would be easy to misunderstand as a security boundary."

## The decision

No harness that Orchy drives can hold a bound, so Orchy offers none. `SUPPLIES`
in `harness.ts` keeps its shape: it names the tools of each adapter, and no
adapter has a bound to record beside them.

Orchy could write its own bound, with a `spawnHook` under Pi or with a component
that runs the command. Both refuse a command by matching a string, and a string
match is not a boundary: `npm test; rm -rf /` passes a prefix check. It would
also work under one adapter of the two, which makes the rule of a flow depend on
the harness that runs it.

Invariant 5 already covers what this bound wants. A step with `bash` that
promises `changes: nothing`, or `{ except: [src] }`, fails when the workspace
records a change it did not promise. That rule reads the record and not the
command, so no string match stands between the promise and the truth. The
README states the limit of invariant 1 for this reason, and the limit stays.

## What would change this

A harness that refuses a tool call by a rule, and reports the refusal. When one
arrives, the bound belongs beside `SUPPLIES`, and `validate()` refuses a bounded
tool under a harness that cannot hold it, before the run spends a token.
