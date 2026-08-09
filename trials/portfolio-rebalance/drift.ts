import { readFileSync } from "node:fs";

interface Holding {
  name: string;
  target_pct: number;
  value_usd: number;
  account: string;
}

/**
 * Reads the holdings off disk and works out the trades. No model sees this
 * arithmetic, and no prompt can talk it into a different number. New cash is
 * spent on the most underweight holdings first, which is the cheapest way to
 * rebalance because it sells nothing.
 */
export default (
  _inputs: Record<string, unknown>,
  say: (text: string) => void,
  values: Record<string, unknown>,
) => {
  const holdings = JSON.parse(readFileSync("HOLDINGS.json", "utf8")) as Holding[];
  const cash = Number(values?.new_cash_usd ?? 0);
  const band = Number(values?.band_pct ?? 5);

  const held = holdings.reduce((sum, one) => sum + one.value_usd, 0);
  const total = held + cash;
  const round = (value: number) => Math.round(value * 100) / 100;

  const drifts = holdings.map((one) => {
    const actual = (one.value_usd / total) * 100;
    return {
      holding: one.name,
      target_pct: one.target_pct,
      actual_pct: round(actual),
      drift_pct: round(actual - one.target_pct),
    };
  });

  const wanted = holdings.map((one) => ({
    name: one.name,
    gap: (one.target_pct / 100) * total - one.value_usd,
  }));

  // The new cash goes to the biggest gaps first, and only then does anything sell.
  let left = cash;
  const trades: Array<{ holding: string; action: string; amount_usd: number }> = [];
  for (const one of [...wanted].sort((first, second) => second.gap - first.gap)) {
    if (left <= 0 || one.gap <= 0) continue;
    const buy = Math.min(left, one.gap);
    left -= buy;
    one.gap -= buy;
    trades.push({ holding: one.name, action: "buy with new cash", amount_usd: round(buy) });
  }

  const outside = drifts.filter((one) => Math.abs(one.drift_pct) > band);
  for (const one of wanted) {
    if (!outside.some((drift) => drift.holding === one.name)) continue;
    if (Math.abs(one.gap) < total * 0.005) continue;
    trades.push({
      holding: one.name,
      action: one.gap > 0 ? "buy" : "sell",
      amount_usd: round(Math.abs(one.gap)),
    });
  }

  say(`${holdings.length} holdings, ${outside.length} outside the ${band}% band, ${trades.length} trades`);

  return { total_usd: round(total), needs_rebalance: outside.length > 0, trades, drifts };
};
