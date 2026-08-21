# Orchy

Orchy runs agent flows. A user declares the steps and the rules. Orchy runs the
steps and enforces the rules.

## Language

**Harness**:
The program that runs one agent turn: it holds the model, the tools, and the
conversation. Orchy does not replace a harness. Orchy drives one.
_Avoid_: Agent framework, runtime, engine

**Adapter**:
The code that connects Orchy to one harness. Orchy has three adapters, for Pi,
for Claude Code, and for Droid.
_Avoid_: Driver, backend, provider, integration

**Autonomy level**:
What a harness runs a step without a question. Droid holds three levels, and a
step takes the highest, because no one sits at the keyboard of a step. The
machine names the level, and not the flow. The level is not a tool list: the
tool list bounds what exists.
_Avoid_: Permission mode, approval level, sandbox, trust

**Daemon**:
The program that keeps runs on the way. It holds a queue, starts each run as a
child process, serves the API, and serves the UI.
_Avoid_: Server, service, worker, scheduler

**Root**:
The directory where the daemon starts. Every step of every run acts there, and
the daemon refuses a flow file outside it.
_Avoid_: Base, project directory, home

**Flow**:
An ordered set of steps that produces a result, such as a merge request. A flow
is data, not code. Orchy, a file, or a graphical editor can all produce the same
flow.
_Avoid_: Pipeline, workflow, chain, graph

**Step**:
One unit of work in a flow. A step names the component that does the work. A
step is deterministic or non-deterministic.
_Avoid_: Task, node, stage, job

**Component**:
A named unit of work that a step calls. A component holds code. Orchy supplies
some components. A user writes the others.
_Avoid_: Plugin, module, block, primitive

**Prompt**:
What an agent step tells the model. It lives in a file beside the flow. A name
in braces, such as `{{ issue }}`, takes a value, and a name that nothing
supplies fails the step. The record of the step keeps the text that Orchy really
sent, because neither the file nor the values alone say it.
_Avoid_: Instruction, template, system message

**Gate**:
A step that takes its value from a person, not from code. The run stops and
waits. A gate holds a cycle, so a person sends the run back.
_Avoid_: Approval, checkpoint, pause, breakpoint

**Workspace**:
The place where a step acts, and the source of the record of what changed
there. A code repository is one workspace. A task that changes nothing needs
none.
_Avoid_: Environment, sandbox, working directory, context

**Cycle**:
One pass through a group of steps that repeat, such as code and then review. A
flow sets a limit on the number of cycles. A cycle to the step itself repeats
one step, which is how a flow retries.
_Avoid_: Iteration, loop, round, retry

**Attempt**:
One run of one step. A cycle drops an attempt and runs the step again. A dropped
attempt keeps its record, because it is still a cost.
_Avoid_: Try, pass, execution

**Condition**:
A partial match against a value. A condition on a step decides whether the step
runs. A condition on a cycle decides whether the run goes back. The match
against one value is the value itself, or one operator.
_Avoid_: Predicate, expression, filter, guard

**Operator**:
What a match says about one value, beside the value itself. Orchy holds five,
and the set is closed, so a graphical editor draws the list.
_Avoid_: Comparison, test, expression, function

**Promise**:
What a step says it changes in the workspace. Orchy checks the promise against
the record of what moved. A step promises nothing, the only paths it changes, or
the paths it must not change. A flow holds one promise for every step that
declares none. The record names the kind of each change, and not only the path.
_Avoid_: Guarantee, claim, permission, scope

**Fanout**:
One step that runs once for each member of a list. Orchy turns it into one step
for each member before the run. A fanout over a list that a step computes waits
for that value, and the run expands it.
_Avoid_: Matrix, spread, parallel, map

**Member**:
One entry of a fanout. It names itself, holds the value that is its own, and
overrides only what differs from the step. One item of a computed list is one
member: the item is the value, and the `name` field of the item names it.
_Avoid_: Variant, instance, replica

**Expansion**:
The work that turns one step into the plain steps that the runner reads. A
fanout and a flow step are expansions, and they happen before the run. A fanout
over a list that a step computes is the one expansion the runner performs.
_Avoid_: Unrolling, compilation, flattening

**Wave**:
The set of steps that run at the same time, because every step they need has
passed. A wave that holds a promise runs one step at a time, because a snapshot
reads the whole workspace.
_Avoid_: Batch, round, tier, level

**Invariant**:
A rule that Orchy enforces while a step runs. A broken invariant fails the step.
_Avoid_: Constraint, guard, policy

**Shape**:
The fields that a flow and each kind of step hold. A file and a graphical editor
carry no types, so Orchy checks the shape before it reads any meaning.
_Avoid_: Schema, structure, format

**Contract**:
The schema that the value of a step must match. A flow declares one as well, for
the value that it produces. The contract is one kind of invariant.
_Avoid_: Output schema, signature, interface

**Takes**:
The values that a run supplies to a flow. A flow declares them as a schema.
Every step of the run reads them, and a name in a prompt takes one. A step
declares as a schema the values it must get, and Orchy checks them before the
step starts.
_Avoid_: Parameter, argument, input, variable

**Policy**:
The choice that Orchy makes when a cycle reaches its limit and the steps still
disagree. A policy sends the run to a gate, or accepts the disagreement.
_Avoid_: Strategy, resolution, tie-break

**Budget**:
What a run may spend, in dollars. The flow declares one. Orchy counts every
attempt, and a run that reaches the budget stops and fails.
_Avoid_: Cap, quota, allowance, spend limit

**Run**:
One execution of one flow. A run survives a stop. Orchy writes the state of a
run to disk after each step.
_Avoid_: Instance, job, execution, invocation

**Ticket**:
What the daemon gives back when it accepts a run. A ticket becomes a run when
the child process reports its run id.
_Avoid_: Job, request, handle

**Schedule**:
The pace at which one flow runs by itself. The daemon fires a due schedule
through the same door a person uses, and never stacks a run behind a slow one.
_Avoid_: Cron, timer, scheduler, interval

**Hook**:
The token URL that starts one flow from a POST. The body of the POST is the
values the flow takes, and the token is the whole door.
_Avoid_: Webhook endpoint, trigger, callback

**Index**:
The database that the daemon builds from the runs on disk. It answers a list and
a search. It holds the newest runs, and the events of a run that falls behind
that list go. The state on disk stays the run.
_Avoid_: Database, store, cache, registry

**Note**:
One thing a step says while it works. A note is a view, and the trajectory is
the record.
_Avoid_: Log line, message, chunk, token

**Trajectory**:
The full record of what a step did, from the first prompt to the last tool call.
Orchy writes a trajectory in the ATIF format.
_Avoid_: History, transcript, trace, log
