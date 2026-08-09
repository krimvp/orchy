// Merging a shopping list is bookkeeping. A model that does it forgets an
// aisle and buys the coriander twice.
export default (inputs: Record<string, Record<string, unknown>>, say: (text: string) => void) => {
  const dinners = Object.entries(inputs)
    .filter(([id]) => id.startsWith("dinner/"))
    .map(([, value]) => value as { ingredients?: Array<{ item: string; quantity: string; aisle: string }> });

  const byAisle = new Map<string, string[]>();
  const seen = new Map<string, number>();

  for (const dinner of dinners) {
    for (const one of dinner.ingredients ?? []) {
      const aisle = (one.aisle || "other").toLowerCase().trim();
      const key = one.item.toLowerCase().trim();
      seen.set(key, (seen.get(key) ?? 0) + 1);
      const lines = byAisle.get(aisle) ?? [];
      lines.push(`${one.item} — ${one.quantity}`);
      byAisle.set(aisle, lines);
    }
  }

  const repeated = [...seen.entries()].filter(([, count]) => count > 1).map(([item]) => item);
  say(`${dinners.length} dinners, ${seen.size} distinct items, ${repeated.length} bought for more than one night`);

  return {
    aisles: [...byAisle.entries()].sort().map(([aisle, lines]) => ({ aisle, lines })),
    items: seen.size,
    repeated,
  };
};
