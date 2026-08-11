---
status: accepted
---

# A flow runs by itself: a schedule and a hook

A schedule fires one flow on a pace, and a hook starts one flow from a POST.
Both live in the daemon, and both start a run through the same checked door as
the button on the page.

A schedule holds the pace in minutes, the values the flow takes, and the moment
it last fired. The daemon checks every schedule on a beat of thirty seconds. A
schedule that has never fired is due at once, because that is what scheduling
it asked for, and the first run is the proof that the schedule works.

A hook is one token. The daemon makes it, the URL holds it, and a POST to the
URL starts the flow with the body as the values it takes. A wrong token starts
nothing, and says so.

## Why

Orchy sold "autonomous once configured", and a person still pressed every
button. The flows the repository ships are the argument: a standup reads the
last day, a sweep reads the tree as it stands. Work like that runs on a clock
or on an event, such as a git hook after a commit, and not on a hand.

## The limits, stated

- The pace has a floor of fifteen minutes. An agent step spends money, and a
  typo in a pace must not become a spend loop.
- A due schedule with a run of the same flow still on the way does not fire.
  Runs must not stack behind a slow one. It fires when that run has gone.
- A schedule for a flow that takes values must carry them, and the daemon
  refuses one that does not. A run that starts with no person watching cannot
  ask for what is missing.
- The token is the whole door. The daemon listens on this machine only, so the
  door opens to this machine, and to whatever a person forwards to it. The
  page says so where it shows the URL.
- The beat, the button, the schedule, and the hook all start a run through one
  function, which refuses a flow that `validate()` rejects and a flow that
  names a file that is not there. One door, so each refuses the same broken
  flow the same way.
