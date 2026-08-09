// The size of the prize is arithmetic over the numbers the founder supplied.
// It runs here so that the model downstream argues about the number rather
// than producing one.
export default (
  _inputs: Record<string, unknown>,
  say: (text: string) => void,
  values: Record<string, unknown>,
) => {
  const price = Number(values?.price_monthly_usd ?? 0);
  const clinics = Number(values?.clinics ?? 0);
  const rate = Number(values?.win_rate_pct ?? 0) / 100;

  const reachable = Math.round(clinics * 0.6);
  const won = Math.round(reachable * rate);
  const arr = Math.round(won * price * 12);
  const ramen = arr > 0 ? Math.round((60000 / (arr / 12)) * 10) / 10 : Infinity;

  say(`${won} clinics at ${price} a month is ${arr} a year`);

  return {
    reachable_clinics: reachable,
    arr_at_win_rate_usd: arr,
    months_to_ramen: Number.isFinite(ramen) ? ramen : -1,
    big_enough: arr >= 250000,
  };
};
