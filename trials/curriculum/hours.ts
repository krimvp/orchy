// Adding up the hours is the one thing in this flow that must be right, so no
// model does it. The writer downstream reads `over_by` and cuts to fit.
export default (
  inputs: Record<string, Record<string, unknown>>,
  say: (text: string) => void,
  values: Record<string, unknown>,
) => {
  const modules = Object.entries(inputs)
    .filter(([id]) => id.startsWith("module/"))
    .map(([, value]) => value as { sessions?: Array<{ hours?: number }> });

  const planned = modules.reduce(
    (sum, one) => sum + (one.sessions ?? []).reduce((hours, session) => hours + Number(session.hours ?? 0), 0),
    0,
  );
  const available = Number(values?.weeks ?? 0) * Number(values?.hours_per_week ?? 0);
  const round = (value: number) => Math.round(value * 10) / 10;

  say(`${modules.length} modules plan ${round(planned)} hours against ${round(available)} available`);

  return {
    planned_hours: round(planned),
    available_hours: round(available),
    fits: planned <= available,
    over_by: round(Math.max(0, planned - available)),
  };
};
