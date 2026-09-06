---
status: accepted
---

# The daemon refuses a page that is not its own

The daemon reads two headers on every request. It refuses a `Host` that it does
not answer to, and it refuses an `Origin` that is not itself.

```
this daemon does not answer to the host "orchy.example". Reach it at
http://127.0.0.1:4000.

the page at "https://example.com" is not this daemon, so it starts nothing
here. Open the page at http://127.0.0.1:4000.
```

The daemon learns its own names when it listens, because a caller can ask for
the port 0. It answers to `127.0.0.1`, to `[::1]`, and to `localhost`, on the
port it got.

## Why

The daemon listens on `127.0.0.1`, it has no user and no password, and it
starts an agent that can hold `bash`. The README said so, and it read as the
whole answer. It is not.

A loopback address is not a boundary against a browser. Two attacks walk
through it, and the server read neither header:

- **A page a person visits.** The page posts to `http://127.0.0.1:4000`. The
  browser sends the request, and the daemon starts a flow. The page reads no
  answer, and it does not need one: the run already runs code on the machine.
- **DNS rebinding.** A name that the attacker owns resolves to `127.0.0.1`.
  The page is then same-origin with the daemon, so it reads every answer as
  well.

An `Origin` closes the first one. A browser sends `Origin` with every request
that changes something, even one whose answer it cannot read. A `Host` closes
the second one, because a rebound name arrives in that header.

## Why a browser and not a program

`curl` writes any header it wants, so this rule stops no program on the
machine. It does not try to. A person who runs a program on the machine already
runs code on the machine.

The actor this rule bounds is a browser, because a browser obeys a page that
the person did not write. A browser sets `Host` and `Origin` itself, and no
page can change either one.

## Why the page still works

A browser sends no `Origin` for a request of a page to its own daemon. That is
what the `fetch` of the page sends, and what its `EventSource` sends. So an
absent `Origin` passes, and a foreign one does not.

The three names of the loopback address are one machine, so a person types
whichever one they like. A daemon that answered to `127.0.0.1` alone would
refuse the person who opened `http://localhost:4000`.

## Why it reads no content type

A rule about `content-type: application/json` is the third guard that a reader
expects here. It does not land.

The page sends no content type when it stops a run, because that request
carries no body. A rule about the header would refuse that request, so the page
would break. It would also add nothing: a form post carries a content type that
a browser allows, so the header refuses no attack that `Origin` allows.

## Why not a user and a password

A password is the rule that this decision does not make, and the README keeps
saying so.

A user and a password need a store, a session, and a way to reset one. Each of
those is a question that every user of a local daemon must answer, and the
answer for one person on one machine is always the same. [AGENTS.md](../../AGENTS.md)
refuses a knob with one good answer.

This rule needs no state at all. It reads two headers that the browser already
writes.

## Consequences

The check runs before every route, and before the page files as well. So one
function answers for the whole daemon, and a new route inherits the rule.

`serve()` takes the host, and a daemon on another host answers to that name
alone. A person who puts the daemon behind a name, a tunnel, or another machine
gets a 403 that names the address to use. This is deliberate: the deferred item
in [docs/plan.md](../plan.md) is a daemon that listens beyond this machine, and
it needs a user and a password before it needs a name.

The daemon refuses a flow file outside its root in the same change, because
`POST /api/flows` resolved a path that a caller gives and never asked where it
landed. `../..` read a file anywhere on the machine. Every step acts in the
root, so a flow file above it belongs to another project.

The check uses canonical paths. For a new file, it checks the nearest existing
parent. Thus, a symbolic link under the root cannot carry a read or a write to
another directory.

The check and the file action are two operations. It does not stop another
local process from replacing a path between them. The daemon has no boundary
against a program on the same machine.

The rule is not a sandbox and it is not a login. Anyone who reaches the port
from a program still runs code on the machine, and the README states that limit
beside this one.
