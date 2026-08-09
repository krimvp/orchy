// A compounding projection is arithmetic, so it runs here and not in a model.
// The blended return comes from the weights the first step chose, through a
// fixed table of long-run assumptions. The table is the assumption, and it is
// visible, which is the point of doing this in a module.
const RETURN: Array<[RegExp, number]> = [
  [/cash|money market|savings|t-bill/i, 2.0],
  [/bond|fixed income|gilt|treasur/i, 3.5],
  [/property|reit|real estate/i, 5.5],
  [/emerging/i, 8.0],
  [/small.?cap/i, 8.0],
  [/equity|stock|share|index|global|world|s&p/i, 7.0],
  [/gold|commodit|crypto|bitcoin/i, 3.0],
];

const FALLBACK = 5.0;

function assumed(name: string): number {
  for (const [pattern, rate] of RETURN) if (pattern.test(name)) return rate;
  return FALLBACK;
}

export default (
  inputs: Record<string, Record<string, unknown>>,
  say: (text: string) => void,
  values: Record<string, unknown>,
) => {
  const sleeves = (inputs.profile?.sleeves ?? []) as Array<{ name: string; target_pct: number }>;
  const weight = sleeves.reduce((sum, one) => sum + Number(one.target_pct ?? 0), 0) || 100;
  const blended = sleeves.reduce((sum, one) => sum + (Number(one.target_pct ?? 0) / weight) * assumed(one.name), 0);

  const years = Number(values?.horizon_years ?? 0);
  const monthly = Number(values?.monthly_savings_usd ?? 0);
  const start = Number(values?.starting_usd ?? 0);
  const goal = Number(values?.goal_usd ?? 0);

  const rate = blended / 100 / 12;
  const months = years * 12;
  let balance = start;
  for (let month = 0; month < months; month++) balance = balance * (1 + rate) + monthly;

  const round = (value: number) => Math.round(value * 100) / 100;
  say(`${sleeves.length} sleeves blend to ${round(blended)}% a year over ${years} years`);

  return {
    blended_return_pct: round(blended),
    ending_usd: round(balance),
    shortfall_usd: round(Math.max(0, goal - balance)),
    contributions_usd: round(start + monthly * months),
  };
};
