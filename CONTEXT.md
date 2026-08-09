# Orchy

Orchy runs agent flows. A user declares the steps and the rules. Orchy runs the
steps and enforces the rules.

## Language

**Harness**:
The program that runs one agent turn: it holds the model, the tools, and the
conversation. Orchy does not replace a harness. Orchy drives one.
_Avoid_: Agent framework, runtime, engine

**Adapter**:
The code that connects Orchy to one harness. Orchy has two adapters, for Pi and
for Claude Code.
_Avoid_: Driver, backend, provider, integration

**Daemon**:
The program that keeps runs on the way. It holds a queue, starts each run as a
child process, serves the API, and serves the UI.
_Avoid_: Server, service, worker, scheduler

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
the record of what moved. A step promises nothing, or a list of paths.
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

**Wave**:
The set of steps that run at the same time, because every step they need has
passed.
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
Every step of the run reads them, and a name in a prompt takes one.
_Avoid_: Parameter, argument, input, variable

**Policy**:
The choice that Orchy makes when a cycle reaches its limit and the steps still
disagree. A policy sends the run to a gate, or accepts the disagreement.
_Avoid_: Strategy, resolution, tie-break

**Run**:
One execution of one flow. A run survives a stop. Orchy writes the state of a
run to disk after each step.
_Avoid_: Instance, job, execution, invocation

**Ticket**:
What the daemon gives back when it accepts a run. A ticket becomes a run when
the child process reports its run id.
_Avoid_: Job, request, handle

**Index**:
The database that the daemon builds from the runs on disk. It answers a list and
a search. The state on disk stays the run.
_Avoid_: Database, store, cache, registry

**Note**:
One thing a step says while it works. A note is a view, and the trajectory is
the record.
_Avoid_: Log line, message, chunk, token

**Trajectory**:
The full record of what a step did, from the first prompt to the last tool call.
Orchy writes a trajectory in the ATIF format.
_Avoid_: History, transcript, trace, log
