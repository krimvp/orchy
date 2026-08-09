// The money is arithmetic, so no model spends a token on it. The cycle above
// reads `within`, which means a step that cannot be argued with decides.
export default (
  inputs: Record<string, Record<string, unknown>>,
  say: (text: string) => void,
  values: Record<string, unknown>,
) => {
  const estimate = Number(inputs.itinerary?.est_total_usd ?? 0);
  const budget = Number(values?.budget_usd ?? 0);
  const over = Math.round(Math.max(0, estimate - budget) * 100) / 100;
  say(`the itinerary costs ${estimate} against a budget of ${budget}`);
  return {
    within: over === 0,
    over_by_usd: over,
    note:
      over === 0
        ? `${estimate} of ${budget}, with ${Math.round((budget - estimate) * 100) / 100} left`
        : `${estimate} of ${budget}. Cut ${over}.`,
  };
};
