export type TicketStatus = "queued" | "dispatching" | "delivered" | "failed" | "uncertain";

export interface PendingTicket {
  ticket: number;
  status?: TicketStatus;
  error?: string;
  recovery?: string;
}

export interface RunMark {
  status: string;
  waitingFor?: string;
  revision?: number;
}

/** Gives a request a limit, so a control does not stay disabled for ever. */
export function withTimeout<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** True when the run state differs from the state that a control acted on. */
export function runMoved(before: RunMark, next: RunMark): boolean {
  return (
    next.status !== before.status ||
    next.waitingFor !== before.waitingFor ||
    (next.revision ?? 0) !== (before.revision ?? 0)
  );
}

/**
 * Waits for one accepted resume ticket to move its run. A queue fault stays
 * unknown, because an absent answer is not evidence that the ticket finished.
 */
export async function waitForTicket(
  ticket: PendingTicket,
  before: RunMark,
  readState: () => Promise<RunMark>,
  readQueue: () => Promise<PendingTicket[]>,
  options: {
    turns?: number;
    requestMilliseconds?: number;
    pause?: () => Promise<void>;
  } = {},
): Promise<void> {
  const turns = options.turns ?? 40;
  const requestMilliseconds = options.requestMilliseconds ?? 5_000;
  const pause = options.pause ?? (() => new Promise((rest) => setTimeout(rest, 500)));
  let lastStatus = ticket.status;

  for (let turn = 0; turn < turns; turn += 1) {
    await pause();
    const [state, queue] = await Promise.allSettled([
      withTimeout(readState(), requestMilliseconds, "The run did not answer."),
      withTimeout(readQueue(), requestMilliseconds, "The queue did not answer."),
    ]);
    if (state.status === "fulfilled" && runMoved(before, state.value)) return;
    if (queue.status === "rejected") {
      throw new Error(
        `Orchy accepted ticket ${ticket.ticket}, but the queue did not answer. Open Runs before you send it again.`,
      );
    }
    const held = queue.value.find((one) => one.ticket === ticket.ticket);
    if (held?.status) lastStatus = held.status;
    if (held?.status === "failed") {
      throw new Error([held.error, held.recovery].filter(Boolean).join(" ") || `Ticket ${ticket.ticket} failed.`);
    }
    if (held?.status === "uncertain") {
      throw new Error(
        `Ticket ${ticket.ticket} is uncertain. ${
          [held.error, held.recovery].filter(Boolean).join(" ") || "Open Runs and check the run before you send it again."
        }`,
      );
    }
  }
  const state = lastStatus === "queued" ? "is still queued" : "has not moved the run yet";
  throw new Error(`Ticket ${ticket.ticket} ${state}. Open Runs to follow it before you send it again.`);
}

/** A person can clear a known fault or acknowledge an uncertain ticket. */
export function canDismiss(ticket: PendingTicket): boolean {
  return ticket.status === "failed" || ticket.status === "uncertain" || (!ticket.status && Boolean(ticket.error));
}

/** The durable state of a ticket, in the words the queue shows. */
export function ticketLabel(ticket: PendingTicket): string {
  if (ticket.status === "failed" || (!ticket.status && ticket.error)) return "delivery failed";
  if (ticket.status === "uncertain") return "delivery uncertain";
  if (ticket.status === "delivered") return "starting";
  if (ticket.status === "dispatching") return "dispatching";
  return "queued";
}
