# The page with a keyboard and a narrow screen

Status: a record. This check used commit `7d6e35b` on 2026-09-05.

## Method

I read each page control and the responsive rules. I compared them with the browser findings in `docs/sweep/ui.md`.

I built the page and started a local daemon on port 4127. The supplied cloud browser refused each loopback address.

It reported `ERR_BLOCKED_BY_CLIENT` for `127.0.0.1` and `localhost`. Its route to `host.docker.internal` returned 502.

Thus, this record holds no new browser result. The browser evidence in `docs/sweep/ui.md` stays the current visual evidence.

## Changes from the check

- A contract is a form. Enter sends it, and a pending send disables its controls.
- The JSON editor gives valid object fields back to the form. It keeps invalid JSON open with an error.
- A run control waits for its accepted ticket or run state. An unknown delivery directs the person to Runs.
- An error announces itself. A selected choice and the current page expose their state.
- A keyboard selects a step or a link in the drawing.
- A drawer takes focus, holds it, closes with Escape, and returns focus.
- At 820 pixels, the CSS wraps flow controls and reduces a run row to its status, name, and link.

The daemon remains the source of each flow rule and contract result.
