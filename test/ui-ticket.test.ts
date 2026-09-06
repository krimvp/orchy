import assert from "node:assert/strict";
import test from "node:test";
import { canDismiss, ticketLabel, waitForTicket, withTimeout } from "../ui/src/ticket.ts";

const still = { status: "waiting", waitingFor: "decide", revision: 4 };
const noWait = () => Promise.resolve();

test("a queued ticket stays pending and directs the person to Runs", async () => {
  await assert.rejects(
    waitForTicket(
      { ticket: 7, status: "queued" },
      still,
      async () => still,
      async () => [{ ticket: 7, status: "queued" }],
      { turns: 1, pause: noWait },
    ),
    /Ticket 7 is still queued\. Open Runs/,
  );
  assert.equal(ticketLabel({ ticket: 7, status: "queued" }), "queued");
  assert.equal(canDismiss({ ticket: 7, status: "queued" }), false);
  assert.equal(canDismiss({ ticket: 7, status: "dispatching" }), false);
  assert.equal(canDismiss({ ticket: 7, status: "delivered" }), false);
});

test("an uncertain ticket gives its recovery and can be acknowledged", async () => {
  await assert.rejects(
    waitForTicket(
      { ticket: 8, status: "dispatching" },
      still,
      async () => still,
      async () => [{ ticket: 8, status: "uncertain", recovery: "Check run 44 before a new start." }],
      { turns: 1, pause: noWait },
    ),
    /Ticket 8 is uncertain\. Check run 44/,
  );
  assert.equal(ticketLabel({ ticket: 8, status: "uncertain" }), "delivery uncertain");
  assert.equal(ticketLabel({ ticket: 8, status: "failed" }), "delivery failed");
  assert.equal(canDismiss({ ticket: 8, status: "uncertain" }), true);
  assert.equal(canDismiss({ ticket: 8, status: "failed" }), true);
});

test("a request timeout reports unknown delivery", async () => {
  await assert.rejects(
    withTimeout(new Promise<never>(() => undefined), 1, "Delivery is unknown. Open Runs before you send it again."),
    /Delivery is unknown/,
  );
});

test("a queue read fault does not count as ticket completion", async () => {
  await assert.rejects(
    waitForTicket(
      { ticket: 9, status: "dispatching" },
      still,
      async () => still,
      async () => {
        throw new Error("offline");
      },
      { turns: 1, pause: noWait },
    ),
    /accepted ticket 9, but the queue did not answer/,
  );
});
