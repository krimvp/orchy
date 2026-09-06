---
status: accepted
---

# Accepted work is durable and dispatched at most once

The daemon records a start or a resume in the `accepted_work` table before it
returns a ticket. Ticket numbers come from SQLite, so every daemon over one root
uses one sequence. The record holds the checked path, harness, values, and the
state revision that a resume saw. Its JSON is versioned, checked, and limited to
one megabyte before the transaction commits.

A daemon changes `queued` to `claimed` in an immediate SQLite transaction
before it loads the flow or starts a child. Only that owner may dispatch the
record. Another daemon can show the receipt, but it cannot start it. A restart
loads `queued` records, claims one, and then checks the flow or run again before
it starts a child. A refused check is a known failure because no child exists.

Claimed work is not safe to retry after its owner dies. The owner may have
started a detached child before it died. Orchy reports that receipt as
`uncertain` and does not dispatch it again. A start has a planned run id, so the
exact state directory proves that start was delivered. A general revision
change does not prove that a resume was delivered; another command may have
changed the run. Only the daemon that received that resume's `run_start` marks
it delivered.

## Consequences

An accepted receipt and its payload survive a daemon restart. This is durable
acceptance. It is not a promise that Orchy will retry the work until it runs.
Work that was still queued runs after restart. Work whose delivery is uncertain
stays stopped until a person resolves its outcome.

The queue reports `queued`, `dispatching`, `delivered`, `failed`, or
`uncertain`. A failed receipt is known not to have started and may be corrected
and submitted again. An uncertain receipt names the run and the API calls that
inspect it. Dismissing it acknowledges the uncertainty; it does not prove
delivery and it does not free an uncertain `starts.most` reservation.

A bounded child start links its reservation to accepted work in the same
transaction. A dead reservation that never reached acceptance is safe to
release. An accepted reservation stays fail closed until the exact child run is
indexed or its child is known to have ended without a run. Reservations from an
older database have an `unknown` phase and stay fail closed.

For a schedule, the due check, ticket insert, and `lastAt` update share one
immediate transaction. Two daemons cannot accept the same scheduled turn.

The claim is about daemon-process restarts over one readable SQLite database.
It does not add a storage replication or power-loss guarantee.
