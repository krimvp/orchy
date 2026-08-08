# Orchy

Orchy runs agent flows. A user declares the steps and the rules. Orchy runs the
steps and enforces the rules.

## Language

**Harness**:
The program that runs one agent turn: it holds the model, the tools, and the
conversation. Orchy does not replace a harness. Orchy drives one.
_Avoid_: Agent framework, runtime, engine

**Flow**:
An ordered set of steps that produces a result, such as a merge request.
_Avoid_: Pipeline, workflow, chain, graph

**Step**:
One unit of work in a flow. A step names the component that does the work.
_Avoid_: Task, node, stage, job

**Component**:
A named unit of work that a step calls. Orchy supplies some components. A user
writes the others.
_Avoid_: Plugin, module, block, primitive

**Workspace**:
The directory that a run owns. The steps of a run read and write files here.
_Avoid_: Working directory, sandbox, scratch space

**Invariant**:
A rule that Orchy enforces while a step runs. A broken invariant fails the step.
_Avoid_: Constraint, guard, policy, rule

**Contract**:
The set of files that a step must produce. The contract is one kind of
invariant.
_Avoid_: Output schema, signature, interface

**Run**:
One execution of one flow.
_Avoid_: Instance, job, execution, invocation

**Trajectory**:
The full record of what an agent did in one step, from the first prompt to the
last tool call.
_Avoid_: History, transcript, trace, log
