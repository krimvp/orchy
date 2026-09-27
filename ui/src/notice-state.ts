type RunEvent = { type: string; at: string };

export const MAX_NOTICES = 500;

export function retainNotice(events: RunEvent[], event?: RunEvent): RunEvent[] {
  const next = event ? [...events, event] : events;
  return next.length > MAX_NOTICES ? next.slice(-MAX_NOTICES) : next;
}

export function keepGlobalNotice(event: RunEvent): boolean {
  return event.type === "run_start" || event.type === "waiting" || event.type === "run_end";
}

export function createRequestVersion() {
  let version = 0;
  return {
    next: () => (version += 1),
    isCurrent: (candidate: number) => candidate === version,
  };
}

export function validationView<T>(
  flow: T | undefined,
  validatedFlow: T | undefined,
  problems: string[],
  warnings: string[],
  errorFlow: T | undefined,
  error: string | undefined,
  pending = false,
) {
  const current = flow !== undefined && validatedFlow === flow && !pending;
  const failed = flow !== undefined && errorFlow === flow && !pending;
  return {
    problems: current ? problems : [],
    warnings: current ? warnings : [],
    error: failed ? error : undefined,
    checking: flow !== undefined && !current && !failed || pending,
    canSave: current && problems.length === 0 && !pending,
  };
}
