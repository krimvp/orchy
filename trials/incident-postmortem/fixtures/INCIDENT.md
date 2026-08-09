# INC-2291: checkout returned 500 for 41 minutes

On 3 March we shipped a change to the pricing service that moved currency
rounding from the database into the application. The change passed CI and was
reviewed by two people.

The deploy went out at 14:02 UTC to all four regions at once. Checkout began
returning 500 for any basket containing an item priced in JPY, which is about
6% of orders. Everything else worked, so the overall error rate moved from
0.2% to 0.9% and stayed under the 2% page threshold.

A customer support agent noticed a cluster of complaints and posted in
#checkout at 14:31. An engineer saw it at 14:38 and paged the on-call at 14:40.
The on-call rolled back at 14:43. The rollback finished everywhere at 14:47.

Notes gathered afterwards:

- The alert that would have caught this is per-region, per-endpoint, and was
  set on absolute error count. JPY traffic is small enough that the count never
  crossed the line.
- There is a canary stage in the pipeline. It was skipped because the change
  was labelled "no schema change", and the pipeline treats that label as a
  reason to go straight to full rollout.
- The rounding change had a unit test. The test used USD.
- Nobody could find the runbook for the pricing service. It exists, in an old
  wiki nobody has linked since the migration.
- The 41 minutes are measured from the deploy to the end of the rollback. The
  first minute a customer complained was 14:09, in a channel nobody watches.
