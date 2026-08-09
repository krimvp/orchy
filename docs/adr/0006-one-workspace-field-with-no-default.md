---
status: accepted
---

# One workspace field, with no default

A flow declares one `workspace` field. The workspace holds the place where a
step acts, and it supplies the record of what changed there. Orchy has no
default workspace. A flow that does not declare one gets none.

## Why one field

The thing that knows where a step acts is the thing that knows how to look at
it. Two fields would make a user configure one idea twice.

A remote sandbox breaks that pair, because the place is remote but the record
can come from more than one source. So the value of the field is a tagged
object, and it nests:

```
{ kind: "git", path: "." }
{ kind: "sandbox", handle: "...", track: { kind: "git", path: "/work" } }
```

Version 1 builds `git` and `none`. A remote sandbox becomes a new `kind`, not a
change to the format.

## Why no default

Orchy must also run a task that touches no files. A default that detects a code
repository would fire without a request, and it would surprise that user. A code
flow writes one line to opt in.

## Consequences

Version 1 ships two proof flows, and both of them use a code repository. So the
`none` path ships with test cover only. This is a known risk and the cost to fix
it later is a test, not a redesign.
