// The verdict is arithmetic over what the judges said, so it cannot be argued
// into a different answer by the last model in the chain.
export default (inputs: Record<string, Record<string, unknown>>, say: (text: string) => void) => {
  const judged = Object.entries(inputs)
    .filter(([id]) => id.startsWith("judge/"))
    .map(([, value]) => value as { clause?: string; risk?: number; standing?: string });

  const total = judged.reduce((sum, one) => sum + Number(one.risk ?? 0), 0);
  const over = judged.filter((one) => Number(one.risk ?? 0) > 3);
  const worst = judged.reduce(
    (high, one) => (Number(one.risk ?? 0) > Number(high?.risk ?? -1) ? one : high),
    judged[0],
  );

  say(`${judged.length} clauses judged, ${over.length} of them over three, total ${total}`);

  return {
    total,
    worst: worst?.clause ?? "none",
    count_over_three: over.length,
    verdict: over.length >= 3 || total >= 18 ? "walk" : over.length > 0 ? "negotiate" : "sign",
  };
};
