// Four fixed return paths, run year by year against a spend that grows with
// inflation. Fixed, not random, so the same flow gives the same numbers twice
// and a reader can check them by hand. The paths are the assumption, and they
// are visible here rather than buried in a prompt.
const PATHS: Array<{ name: string; returns: number[] }> = [
  { name: "steady 5%", returns: [5] },
  { name: "lost decade first", returns: [-8, -3, 1, -6, 2, 0, 3, -2, 4, 1, 8, 8, 8, 7, 7] },
  { name: "crash in year three", returns: [6, 6, -34, 12, 9, 7, 6, 6, 5, 5] },
  { name: "high inflation, thin returns", returns: [2, 1, 3, 2, 1, 2, 3, 2] },
];

export default (
  _inputs: Record<string, unknown>,
  say: (text: string) => void,
  values: Record<string, unknown>,
) => {
  const pot = Number(values?.pot_usd ?? 0);
  const spendOne = Number(values?.spend_year_one_usd ?? 0);
  const years = Number(values?.years ?? 30);
  const inflation = Number(values?.inflation_pct ?? 2.5) / 100;
  const round = (value: number) => Math.round(value * 100) / 100;

  const walked = PATHS.map((path) => {
    let balance = pot;
    let spend = spendOne;
    let ranOut = 0;
    for (let year = 1; year <= years; year++) {
      const rate = (path.returns[(year - 1) % path.returns.length] as number) / 100;
      balance = (balance - spend) * (1 + rate);
      spend = spend * (1 + inflation);
      if (balance <= 0 && ranOut === 0) {
        ranOut = year;
        balance = 0;
        break;
      }
    }
    return { name: path.name, ending_usd: round(balance), ran_out_in_year: ranOut };
  });

  const survived = walked.filter((one) => one.ran_out_in_year === 0);
  const endings = [...walked].sort((first, second) => first.ending_usd - second.ending_usd);
  const failures = walked.filter((one) => one.ran_out_in_year > 0).map((one) => one.ran_out_in_year);

  say(`${survived.length} of ${walked.length} paths lasted ${years} years`);

  return {
    paths: walked,
    survived_pct: round((survived.length / walked.length) * 100),
    worst_case_year: failures.length > 0 ? Math.min(...failures) : 0,
    median_ending_usd: round(
      ((endings[Math.floor((endings.length - 1) / 2)] as { ending_usd: number }).ending_usd +
        (endings[Math.ceil((endings.length - 1) / 2)] as { ending_usd: number }).ending_usd) /
        2,
    ),
  };
};
