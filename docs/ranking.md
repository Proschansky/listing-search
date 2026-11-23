# Ranking and duplicates

## How a home is scored

```
relevanceScore = 0.7 × budgetFit + 0.3 × recency          (from 0 to 1)

budgetFit = max(0, 1 − |price − targetBudget| / (0.25 × targetBudget))
recency   = 0.5 ^ (daysOnMarket / 30)
```

Budget gets 70% of the weight because it's the preference the user stated. Recency gets 30%, enough to reorder homes that fit the budget about equally well, but not enough to push a badly priced home to the top. Without a `targetBudget`, the score is recency alone.

Every result includes a `scoreBreakdown` with the budget fit, the recency and the days on market. The app shows it under the score, so you can always see why a home ranked where it did.

### Budget fit

Budget fit falls in a straight line as the price moves away from the target, measured as a share of the target:

| Price compared with the target | Budget fit |
|---|---|
| At the target | 1.0 |
| 10% away | 0.6 |
| 25% or more away | 0 |

The distance is relative because a $20,000 gap matters more on a $300,000 home than on a $3 million one. Being over budget and under budget score the same, because a target budget means "around this number". Users who need a hard ceiling can set `maxPrice`.

### Recency

Recency halves every 30 days a home is on the market:

| Days on market | Recency |
|---|---|
| 0 (listed today) | 1.0 |
| 30 | 0.5 |
| 60 | 0.25 |

A smooth curve avoids the sudden drop a cutoff such as "listed in the last 14 days" would cause. It never goes below zero, and its single setting is easy to tune. A listing dated in the future counts as 0 days on market, so its score can't go above 1.

Days on market are counted from `asOf`, which defaults to today. The sample data is a few months old, so today its recency values are small and close together. The order is still right, and `asOf` reproduces scores as they would have been when the homes were listed. The tests set `asOf` to a fixed date, so they give the same results on any day. The app has no input for it, because shoppers never need it; add `?asOf=YYYY-MM-DD` to the page URL to try it.

### Ties

Scores are rounded to 4 decimal places, so rounding noise in the arithmetic can't create a meaningless order. Equal scores are then ordered by:

1. Newer listing first
2. Lower price
3. `listingKey`, which is unique

So the same search always returns the same order, and pages never overlap or skip a home.

The weights, the 25% budget tolerance and the 30-day half-life are constants at the top of `backend/app/scoring.py`. They're reasonable starting values. A production service would tune them against what users click and save.

## How duplicate listings are merged

The same home often appears in several feeds, with different formatting and sometimes different facts. In the sample, 4 homes appear twice (records A1 and B7, A2 and B8, A3 and B9, A5 and B11). For example, one feed has `123 Main St, Apt 4B` and the other `123 Main Street, Unit 4B`, and 456 Oak Ave has zip code 22150 in one feed and 22151 in the other. Like consumer property sites, the service shows one result per home, so the 12 records become 8 listings.

Two records count as the same home when all of these hold:

- Their addresses match after cleanup: lowercase, punctuation removed, `Street` read as `St` and `Avenue` as `Ave`, and `Apt`, `Unit`, `Suite` and `#` all treated alike.
- They're in the same city and state.
- Their map coordinates are within 200 meters of each other. This guards against merging two different homes.

Zip codes are ignored, because the feeds disagree on them.

When records merge:

- Price, address, description and the other display fields come from the most recently listed record, the freshest view of the home.
- The listing date is the earliest one across feeds, which reflects the real time on market. A feed that picked a home up late can't make it look new.
- Keyword search covers every feed's description.
- Each result keeps a `sources` list of every record that went into it, each with its own ID, price and date. It's a list and not a single comma-separated value because IDs are only unique within one feed.

If one feed proves more reliable than the others, a ranking of feeds by trust would be the natural next step for choosing display fields.
