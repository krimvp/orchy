# Orchy

Orchy runs agent flows. A user declares the steps and the rules. Orchy runs the
steps and enforces the rules.

## Language

**Harness**:
The program that runs one agent turn: it holds the model, the tools, and the
conversation. Orchy does not replace a harness. Orchy drives one.
_Avoid_: Agent framework, runtime, engine

**Adapter**:
The code that connects Orchy to one harness. Orchy has one adapter, for Pi.
_Avoid_: Driver, backend, provider, integration

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
waits.
_Avoid_: Approval, checkpoint, pause, breakpoint

**Workspace**:
The place where a step acts, and the source of the record of what changed
there. A code repository is one workspace. A task that changes nothing needs
none.
_Avoid_: Environment, sandbox, working directory, context

**Cycle**:
One pass through a group of steps that repeat, such as code and then review. A
flow sets a limit on the number of cycles.
_Avoid_: Iteration, loop, round, retry

**Invariant**:
A rule that Orchy enforces while a step runs. A broken invariant fails the step.
_Avoid_: Constraint, guard, policy

**Contract**:
The schema that the value of a step must match. The contract is one kind of
invariant.
_Avoid_: Output schema, signature, interface

**Policy**:
The choice that Orchy makes when a cycle reaches its limit and the steps still
disagree. A policy sends the run to a gate, or accepts the disagreement.
_Avoid_: Strategy, resolution, tie-break

**Run**:
One execution of one flow. A run survives a stop. Orchy writes the state of a
run to disk after each step.
_Avoid_: Instance, job, execution, invocation

**Trajectory**:
The full record of what a step did, from the first prompt to the last tool call.
Orchy writes a trajectory in the ATIF format.
_Avoid_: History, transcript, trace, log
