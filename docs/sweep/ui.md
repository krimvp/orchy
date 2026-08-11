# The page — UI and UX

Driven in Chromium against a daemon on port 4103, root
`/tmp/claude-0/-home-user-orchy/b311d40f-dc91-564a-af5e-d08b95ea2a20/scratchpad/hunt/ui`.
11 flows, 19 runs, one real `claude`/`haiku` agent run. Screenshots are under
`.../scratchpad/hunt/ui/shots/`.

## A run you stop reads as "did not start", for ever, with an unrelated Node warning as its reason

- **Area**: ui
- **Severity**: high
- **What I did**: Started `slow` and `tick` runs from the page, opened each run,
  and pressed `Stop this run`. Then opened `#/`.
- **What happened**: The Runs page header says `19 runs · 1 waiting for you · 5
  in the queue`, and five large red blocks stand above the list. Nothing is in
  the queue: every one of the five is a run I stopped, and each one is in the
  table below as `stopped`. Each block reads:

  ```
  did not start   slow
  (node:20301) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of
  file:///…/flows/slow.ts is not specified and it doesn't parse as CommonJS.
  Reparsing as ES module because module syntax was detected. …
  ```

  The warning has nothing to do with the stop. The blocks push the waiting run
  into a narrow column and the run table below the fold, and they stay until a
  person presses `Dismiss` on each one. `GET /api/queue` returns the same five
  tickets, each with `error` set, so the count is not the page inventing it.
- **What I expected**: A run I stopped leaves no ticket, and no queue entry
  says "did not start" about a run that started.
- **Where**: `src/daemon.ts:287` — `stop()` sends `SIGTERM` and never sets
  `job.settled`, so `src/daemon.ts:194` treats the non-zero exit as a failure to
  start and copies the whole of the child stderr into `job.error`.
- **Evidence**: `shots/35-runs-with-ghost-tickets.png`

## A gate answers "no" by default, and says nothing about it

- **Area**: ux
- **Severity**: high
- **What I did**: Opened the run of `many` that waits at the gate `Ship it?`.
  Its contract is `required: [approved]`, `approved: boolean`. The form shows an
  unticked checkbox labelled `approved · needed`. I pressed `Answer and
  continue` without touching it, and watched the request.
- **What happened**:

  ```
  REQUEST  POST /api/runs/54c0608e-…/resume  {"value":{"approved":false}}
  RESPONSE 200
  ```

  The label says `needed`, so a person reads it as "you must answer this". The
  page instead supplies `false` — a vote against the work — and no warning
  appears. `Write JSON` shows the same default: the box opens pre-filled with
  `{"approved": false, "why": ""}`. On the `loop` flow, whose gate cycles on
  `approved: false`, one careless press sends the whole run backwards.
- **What I expected**: Either the page refuses to send until a needed boolean is
  answered (as it does for a needed number: "Fill in issue first — the flow
  needs it"), or it stops calling it `needed`.
- **Evidence**: `shots/19-many-waiting.png`, `shots/24-odd-write-json.png`

## The Answer button says nothing, and a second press shows a red error on a healthy run

- **Area**: ux
- **Severity**: medium
- **What I did**: Answered the gate of the `gate` run from the page, then
  screenshotted 1.5 s later. Separately, pressed `Answer and continue` twice on
  the `many` run.
- **What happened**: After the press the page is unchanged: the badge still says
  `YOUR TURN`, the heading still says `This run waits for you`, the form is
  still filled in, and the button is still live. Nothing says the answer left.
  The page only changes when the child has restarted, seconds later. A person
  who presses again gets:

  ```
  the run 54c0608e-51fb-4b56-a4ab-ca5d4105d40a is already on its way
  ```

  in red, on a run that is in fact fine.
- **What I expected**: The button rests and says "Sending…" while the answer is
  on its way, as `Start a run` already does on the flow page.
- **Evidence**: `shots/17-gate-just-answered.png`,
  `shots/20-many-after-double-answer.png`

## A stopped run still reads as running, reports no length, and its trajectory line lies

- **Area**: ui
- **Severity**: medium
- **What I did**: Stopped a `tick` run, then opened it fresh in a new browser.
- **What happened**: The pill says `stopped`, and everything under it disagrees:

  ```
  STOPPED   This run is stopped
  1 running
  started: just now | took: — | steps done: 0/1 | cost: — | tokens: —
  work  … This step has not ended yet.
  trajectory
  No trajectory yet. Orchy writes it wherever the run stops.
  ```

  The step node in the drawing still carries the amber "running" ring. `Took`
  stays `—`, so nothing on the page says how long the run worked before it was
  stopped (`row.endedAt` is `null` for a stopped run). The trajectory sentence
  says Orchy writes the file "wherever the run stops" — the run stopped, and
  there is no file. The browser console also shows
  `Failed to load resource: the server responded with a status of 400` for
  `/api/runs/<id>/trajectory`.
- **What I expected**: A stopped run reports no running step, says how long it
  ran, and does not promise a trajectory it does not have.
- **Evidence**: `shots/32-stopped-fresh.png`, `shots/30-run-stopped.png`

## The Flows page never changes until a reload

- **Area**: ui
- **Severity**: medium
- **What I did**: Opened `#/flows`, read the `gate` row, started a run of that
  flow from outside the page, and waited 20 s.
- **What happened**: For 20 s the row kept saying
  `last run 28 min ago · done · 5m 16s`. A reload changed it at once to
  `last run just now · waiting`. Every other view keeps up by itself: the Runs
  page, the run page and the flow-runs page all follow the event stream, and the
  `Runs` tab even grows a dot. `Flows.tsx` never calls `useNotices`, so the one
  page that lists `Run` buttons is the one page that goes stale.
- **What I expected**: The row follows the run it just started, as the other
  lists do.
- **Where**: `ui/src/Flows.tsx:15` — `useLoad(() => api.flows(), [])` and no
  event subscription.
- **Evidence**: `shots/80-flows-stale.png`, `shots/81-flows-after-reload.png`

## Bad JSON in the value box does nothing at all, and throws in the console

- **Area**: ux
- **Severity**: medium
- **What I did**: On `#/flows/1/runs` pressed `Write JSON`, typed `{ not json`,
  and pressed `Start a run`.
- **What happened**: Nothing on the page. No message, no red line, no request.
  The console holds an uncaught error:

  ```
  [pageerror] Expected property name or '}' in JSON at position 2 (line 1 column 3)
  ```

  A person presses the only button on the panel and reads nothing at all.
- **What I expected**: "That is not JSON" beside the box, and no exception.
- **Evidence**: `shots/83-bad-json.png`, `shots/83-bad-json.console.txt`

## Keyboard focus is invisible on every link, and nearly invisible on the gate checkbox

- **Area**: ux
- **Severity**: medium
- **What I did**: Tabbed through the Runs page and the run page and read the
  computed style of each focused element.
- **What happened**: Every anchor takes the browser default ring, which resolves
  to `outline: rgb(16, 16, 16) auto 1px` on a `rgb(10, 10, 11)` ground — black
  on black. That covers the nav tabs, the waiting cards, every row of the run
  table, `Other runs`, and the `Runs`/`Edit` buttons of the flows list, which are
  anchors too. The cropped shot of a focused table row shows no ring at all. The
  gate checkbox is worse: `outline: none` and `box-shadow: oklab(0 0 0 / 0)`, so
  the only cue is the 3% white tint of the row around it. The stylesheet has a
  rule for `button:focus-visible` and none for `a:focus-visible` or a checkbox.
- **What I expected**: A visible ring on everything a Tab can reach.
- **Where**: `ui/src/styles.css:1079`
- **Evidence**: `shots/73-focus-on-row.png` (focused), `shots/75-focus-on-checkbox.png`

## The dimmest text token fails contrast, and it carries every field label

- **Area**: ui
- **Severity**: medium
- **What I did**: Composited `--text-3: rgba(215, 217, 222, 0.36)` over
  `--bg: #0e0f11` and computed the WCAG ratio.
- **What happened**: **2.68:1**. It fails AA for body text (4.5:1) and fails the
  large-text floor (3:1) as well. The token is used 46 times, and it carries the
  name of every value a person types (`.field > span:first-child`, 12 px), every
  table column heading (11 px), the placeholder text, the unpicked half of every
  segmented control (`pi` / `claude`, `not declared` / `none` / `git`), and the
  second line of every step in the drawing (`a person answers`, `echo.ts`).
  `--text-2` is 5.42:1 and passes, so the fix is one token.
- **What I expected**: A label a person must read reaches 4.5:1.
- **Where**: `ui/src/styles.css:28`

## The Flows list breaks up at 900 wide and collapses at 380

- **Area**: ui
- **Severity**: medium
- **What I did**: Opened `#/flows` at 1440, at 900 and at 380 wide.
- **What happened**: The row keeps one grid at every width, and the column that
  holds the name and the description never grows. At **900** that column is about
  110 px: `A step sends the run back to an earlier step until a person accepts.`
  breaks into six lines, the path breaks into five, and the `last run …` text
  sits a few pixels from the wrapped path. At **380** the same column is about
  10 px and prints one word — often one letter — per line, the `last run …` text
  is drawn on top of the path, and `Run`, `Schedule`, `Runs`, `Edit`, `Forget`
  run off the right edge: `document.scrollWidth` is 784 against a 380 viewport,
  so the whole page scrolls sideways. Only 1440 reads.
- **What I expected**: The row stacks below the desktop width, as the run page
  does.
- **Evidence**: `shots/60-900-flows.png`, `shots/60-380-flows.png`

## At 380 wide the run tables push the whole page sideways

- **Area**: ui
- **Severity**: medium
- **What I did**: Opened `#/` and `#/flows/1/runs` at 380 × 800.
- **What happened**: `document.scrollWidth` is 766 against a 380 viewport. The
  seven columns of the table (`Status Flow Started Took Cost Tokens ›`) keep
  their desktop widths, so `Started`, `Took`, `Cost` and `Tokens` sit off the
  screen and the body scrolls left and right. The queue error blocks are worse:
  each `pre` is squeezed to about 10 px and prints the warning one character per
  line, a column 40 lines tall. At 900 wide the tables fit and nothing overflows.
- **What I expected**: The table drops columns, or the row wraps; the body never
  scrolls sideways.
- **Evidence**: `shots/60-380-runs.png`, `shots/60-900-runs.png`

## A value field carries no box, so a person cannot see where to type

- **Area**: ux
- **Severity**: medium
- **What I did**: Opened the `Start a run` panel of the `slow` flow, on both
  `#/flows` and `#/flows/6/runs`, and read the computed style of the inputs.
- **What happened**: `border-color: rgba(0,0,0,0)` and
  `background: rgba(0,0,0,0)`. The panel shows the words `seconds` and `issue`
  with empty space beside them. Nothing says that space takes typing. The rule
  is deliberate — `styles.css:943` says "The value carries no box until the hand
  asks for one" — and the box appears on hover, which a touch screen and a
  keyboard never do. It cost me two failed attempts to drive the form, and my
  first screenshot reads as a broken panel.
- **What I expected**: A field a person must fill looks like a field before the
  pointer reaches it.
- **Where**: `ui/src/styles.css:943`
- **Evidence**: `shots/14b-flowruns-start-form.png`, `shots/10a-flows-run-form.png`

## Run on the Flows page opens its form 590 px away and pulls the list out from under the cursor

- **Area**: ux
- **Severity**: medium
- **What I did**: On `#/flows` pressed `Run` on the `slow` row, seventh in the
  list, and measured.
- **What happened**:

  ```
  clicked Run at y = 881
  panel opened at y = 288
  slow row before/after y: 851 -> 1064
  element now under the cursor: loop
  ```

  The form appears at the top of the page, far above the button that opened it,
  and every row below moves down 213 px. The pointer now rests on the `Run`
  button of a different flow. A second press starts the wrong flow.
- **What I expected**: The form opens under the row it belongs to.
- **Evidence**: `shots/85-run-panel-position.png`, `shots/10a-flows-run-form.png`

## A finished run shows no step until you click one

- **Area**: ux
- **Severity**: low
- **What I did**: Opened a finished run of `gate`, of `loop`, of `values` and of
  `agent-one` in a fresh browser.
- **What happened**: Every one says `Choose a step in the drawing to read its
  value.` The value, the cost and the changed files of every step are one more
  click away, and on the one-step `agent-one` run that click carries no choice at
  all. A run I watched while it worked does keep a step chosen, so the same page
  behaves two ways.
- **What I expected**: A run that ended opens on the step it ended with.
- **Where**: `ui/src/Run.tsx:826` — `followed()` falls back to the last **live**
  step, and a run that ended before the page opened has none.
- **Evidence**: `shots/87-done-run-fresh.png`, `shots/86-agent-run-done.png`

## A long gate question fills the run list card, with no clamp

- **Area**: ui
- **Severity**: low
- **What I did**: Started a run whose gate asks a 704-character question, and
  opened `#/`.
- **What happened**: The card grows to about 420 px tall and holds the whole
  question. The two other waiting runs beside it keep their own height, so the
  row of cards is mostly empty space, and the run table drops below the fold.
  The run page itself handles the same text well — it wraps across the full
  width and reads fine.
- **What I expected**: The card clamps the question to a few lines, since
  `Answer it` opens the whole of it.
- **Evidence**: `shots/09-runs-many-and-waiting.png`, `shots/22-odd-waiting-long-question.png`

## The page drops the key of a one-field value, and Copy copies something else

- **Area**: ui
- **Severity**: low
- **What I did**: Ran `agent-one` on `claude`/`haiku` and read the value.
- **What happened**: The API holds `{"word": "bat"}` in both `state.value` and
  the step record. The page prints:

  ```
  It returned this value          Copy
  bat
  ```

  The key is gone. `Copy` copies `{"word": "bat"}`, so what a person reads and
  what a person pastes are two different things. The behaviour is deliberate —
  `proseOf()` says "A standup note reads as a note" — but it also hides the name
  of the field on every single-field contract, which is most of them.
- **What I expected**: The value reads as the value, or the label says which
  field it is.
- **Where**: `ui/src/Run.tsx:655`
- **Evidence**: `shots/86-agent-run-done.png`

## The loop drawer clips its only "at the limit" option

- **Area**: ui
- **Severity**: low
- **What I did**: In the editor drew a loop from a gate step back to an earlier
  step, at 1440 wide, and measured the drawer.
- **What happened**: The drawer is 420 px and starts at x = 1020. Its `at the
  limit` control ends at x = 1444, four pixels past the window, so the right
  border of the only option (`the run accepts the answer`) is cut. The drawer
  scrolls sideways by those four pixels and shows no scrollbar.
- **What I expected**: The drawer holds its own controls.
- **Evidence**: `shots/46-loop-drawer.png`, `shots/44-editor-loop-drawn.png`

## A truncated JSON value in a list reads as broken JSON

- **Area**: ui
- **Severity**: low
- **What I did**: Started a run whose value is deeply nested JSON, and read the
  run list.
- **What happened**: The card and the row print
  `config {"level1":{"level2"'` — the text is cut mid-token, and the ellipsis
  sits next to an open quote, so it reads as a broken value rather than a long
  one. In the same list a run started with `label: ""` prints `issue 44 · label`,
  a key with nothing after it, which reads the same as a key the run never took.
- **What I expected**: A shortened value says it is shortened, and an empty
  value says it is empty.
- **Where**: `ui/src/Runs.tsx:174` (`taken`)
- **Evidence**: `shots/09-runs-many-and-waiting.png`

## The activity log says "the run started" again every time a run resumes

- **Area**: ux
- **Severity**: low
- **What I did**: Answered the gate of the `gate` run, and of the `loop` run
  three times.
- **What happened**: The activity list of one run holds `the run started` four
  times, at 10:12:57, 10:13:07, 10:13:20 and 10:13:43. The run started once; the
  other three are resumes, and the log gives a reader no way to tell them apart.
  The last line of a failed run reads `the run is failed`, which is not English.
- **What I expected**: A resume says it resumed.
- **Evidence**: `shots/26-loop-round-1.png`, `shots/28-run-failed.png`

## Took counts the time a run waited for a person

- **Area**: observability
- **Severity**: low
- **What I did**: Answered the `gate` run five minutes after it started, and
  read the tiles.
- **What happened**: `took: 5m 16s`, on a run whose three steps each report `0s`
  and whose trajectory reports `0 tokens`. The `many` run reads `6m 2s` for the
  same reason. A list of runs sorted by cost of time therefore ranks by how long
  a person was at lunch.
- **What I expected**: The page separates the work from the wait, or names what
  it measures.
- **Evidence**: `shots/18-run-done-after-gate.png`, `shots/35-runs-with-ghost-tickets.png`

## The Flows list rounds a cost to cents

- **Area**: observability
- **Severity**: low
- **What I did**: Compared the cost of the `agent-one` run on three views.
- **What happened**: The Flows row says `$0.01`, the run table says `$0.0123`,
  the run page says `$0.0123`. A cheaper run would read `$0.00`, which says a run
  was free when it was not.
- **What I expected**: One format everywhere.
- **Evidence**: `shots/40-new-flow-form.png` vs `shots/35-runs-with-ghost-tickets.png`

## Console, over the whole session

- **Area**: observability
- **Severity**: low
- `[pageerror] Expected property name or '}' in JSON at position 2` — twice, from
  the bad JSON above. The only true fault.
- `Failed to load resource: … 400` for `/api/runs/<id>/trajectory`, on every stopped run
  page: the run ended and wrote no trajectory, and the page asks for one anyway.
- `[requestfailed] /api/events net::ERR_ABORTED` on almost every navigation. It
  is the `EventSource` closing, and it costs nothing, but it makes a real error
  hard to see in the log.
- Every other view was clean: no React warning, no key warning, no failed fetch.

## What held up

- The gate form built from the contract: a checkbox for a boolean, a number
  field for a number, a `Write JSON` escape hatch that round-trips.
- Answering a gate from the page, three rejections, the cycle counting `1 of 3`,
  `2 of 3`, and the run accepting at the limit with `disagreement accepted` and
  `3 attempts that a loop dropped` in the trajectory.
- Two runs of one flow started from `#/flows/1/runs` on different values, both
  landing in the list within a second, with no reload.
- The live run page: notes arriving one per second, the pulse on the working
  step, the elapsed clock, and `Stop this run` really stopping the work — a
  module that writes a line per second wrote its last line one second after the
  press.
- The failed run: the message names the step and quotes the whole of the module
  error, and offers `Fix it and resume from reach`.
- A real `claude`/`haiku` agent run: the filled-in prompt, the structured output,
  `598 tokens · $0.0123`, and the model name in the trajectory head.
- The editor: adding one step of each kind, dragging a link, dragging a loop,
  cutting a link from the edge bar, opening and saving a prompt file, saving the
  YAML, and the confirm on leaving with unsaved changes — which held the page
  when I refused and let it go when I agreed.
- The editor refuses to save what `validate()` refuses, and names it:
  `step "gate" cycles on an empty condition, so it always cycles`, and
  `the step "call" names a module that is not there: step.ts`.
- A step link can be made without a mouse: the step panel holds a `runs after`
  checkbox for every other step, and a loop has an `Add a loop` button.
- A flow named `🚀 odd flow — éà中文` draws right in every list, in the title,
  in the drawing and in the trajectory head.
- A 500-character value shortens to one line in the table with a real ellipsis.
- A needed number left empty says `Fill in issue first — the flow needs it`.
- The tab title carries the state: `(3) Your turn — Orchy`, `Orchy — 1 running`.
- 900 wide holds on the runs list, the run page, the flow-runs page and the
  editor: nothing overflows and nothing overlaps. Only the flows list suffers.
