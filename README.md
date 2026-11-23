# Listing Search

Listing Search finds homes for sale across several MLS feeds and shows each home once, ranked by how well it fits your budget and how recently it was listed. MLS feeds are the listing databases real estate agents publish to, and the same home often appears in more than one.

It's a full-stack web app built for a software engineering assessment. It combines a small bundled sample of 12 listings with about 80 more from SimplyRETS, a free live MLS feed, and it's built and tested the way a production service would be.

![Search results ranked against a $500,000 target budget. Each card shows its score and the budget fit and recency behind it.](docs/images/results.png)

## What you can do with it

- Search by price range, bedrooms, city, keywords and status (active, pending, sold). Type a price ("1,250,000") or drag a slider. The sliders reach $50 million, in steps that get bigger as prices rise.
- Set a target budget to rank homes by how close their price is to it.
- See why each home ranked where it did. Every result shows its score and the two things behind it: budget fit and how new the listing is.
- Switch between a list of cards and a map.
- Open any home for full details and photos, including how each MLS feed described it.
- Sort by best match, newest, price or size.
- Save searches and rerun them later.
- Share any view as a link. The search, sort, page and open listing are all in the URL.
- Use it with a keyboard or screen reader, in light or dark mode, on a phone or a desktop.

Dragging a price handle fills in the box above it, and typing an amount moves the handle:

![Dragging the maximum and minimum price handles, then typing 650000 as the target budget, which shows as 650,000 once the box loses focus](docs/images/price.gif)

Click any home to see why it ranked where it did. This one scored 0.717: its $470,000 price is close to the $500,000 target, and it had been on the market for three weeks. Two MLS feeds listed it, one as "55 Elm Ct" and one as "55 Elm Court", and the app shows it once.

![Clicking the 55 Elm Ct card in dark mode opens the detail panel with its facts, the score breakdown and both feeds' records](docs/images/details.gif)

The map shows the same results, and clicking a marker opens the same panel.

![Switching the results to a map of northern Virginia and clicking a marker, which opens the detail panel for 123 Main St](docs/images/map.gif)

On a phone, each card leads with the price and score, the two things people scan for.

<img src="docs/images/phone.png" alt="The results on a phone in dark mode: price and score first, then the address" width="320">

## Run it

You need Python 3.10 or newer, and Node 20.19 or newer in the 20 line or 22.12 or newer (Vite's requirement).

```bash
bash start.sh
```

The script installs everything the first time, then starts the app at http://localhost:5173 and the API at http://localhost:8000. Interactive API docs are at http://localhost:8000/docs. Press Ctrl+C to stop both.

To run it the way it would run in production, with Docker:

```bash
docker compose up --build    # then open http://localhost:8080
```

Both load the sample data and the SimplyRETS feed. To run offline on the sample alone, start with `LISTING_SOURCES='["sample"]'`. Other ways to run it, and every command, are in [the engineering guide](docs/engineering.md#run-it-other-ways).

## How it works

The app has two parts. The backend is a Python API built with FastAPI. The frontend is a React and TypeScript web app built with Vite. The browser only talks to the API, and the API holds all the search logic.

```mermaid
flowchart LR
  B[Browser<br/>React app] -- "/api/v1 requests" --> A[API<br/>FastAPI]
  A --> S[Search<br/>filter · score · sort · page]
  S --> D[(Merged listings<br/>in memory)]
  F[(Bundled sample file)] -- "loaded and de-duplicated" --> D
  L[(SimplyRETS API)] -- "downloaded every 15 minutes" --> D
```

The API loads listings from each data source, checks every record and merges duplicates. The 12 sample records become 8 homes, because several feeds list the same house. Two records count as the same home when their addresses match after cleanup ("Street" and "St" count as the same) and they sit within 200 meters of each other. Each search then filters those homes, scores them, sorts them and returns one page of results.

The score is 70% budget fit and 30% recency. A home priced at your target budget gets full marks for fit, and the mark falls to zero once the price is 25% away. Recency halves every 30 days a home spends on the market. Without a target budget, homes rank by recency alone. [Ranking and duplicates](docs/ranking.md) explains the formulas and the reasons behind them.

The API is versioned (`/api/v1`). Bad input gets a single error response that lists every problem at once, so the app can highlight all the wrong fields together:

![Two errors shown at once: the minimum price is above the maximum, and bedrooms is negative](docs/images/validation.png)

The browser doesn't check any of this itself. Every rule lives in the API, so the app and anyone calling the API directly get the same answers. [The API reference](docs/api.md) lists every endpoint and parameter.

## Data sources

The app has two sources of listings, set with `LISTING_SOURCES`:

- `sample`: 12 hand-written records in `backend/data/sample_listings.json`, spread across two made-up MLS feeds so duplicate merging has something to do. On by default.
- `simplyrets`: the [SimplyRETS](https://simplyrets.com) demo API. It's a real HTTP service in MLS format, with about 80 made-up listings and photos around Houston, Texas. It uses the public demo login, so it needs no account or key. `start.sh` and Docker switch it on; tests don't, so they never need the internet.

SimplyRETS is someone else's service, so the app expects it to fail sometimes. The API starts at once on the sample data and the last saved SimplyRETS download, then fetches fresh data in the background and again every 15 minutes. Brief failures are retried. If SimplyRETS stays down, the app keeps serving the last good download and `/api/v1/health/ready` reports the source as `degraded`. After three failures in a row it stops calling SimplyRETS for five minutes (a circuit breaker), so a dead API isn't hit on every refresh. Searches keep working throughout.

`make live-check` makes one real call to SimplyRETS to confirm the feed still loads. CI doesn't run it, because an outage at SimplyRETS shouldn't break our build.

## Built for production

The data is a sample, but the service around it behaves like a production one:

- Health checks. One endpoint says whether the service is running, and another says whether it can serve searches. Load balancers and Kubernetes use this split to stop sending traffic to a broken instance without restarting it.
- Request IDs. Every request gets an ID that appears in the logs and in error messages, so a user's bug report leads straight to the right log lines.
- Rate limiting. Each client can make about 120 requests a minute. Extra requests are refused with a message saying how many seconds to wait.
- Graceful failure. If the data file is missing or broken, the service still starts and its health check explains what's wrong. If the API is briefly unreachable, the app retries on its own, and shows a "Try again" button only when it has to.
- Security headers on every response, and the API container runs as a non-root user.
- Settings come from environment variables and are checked at startup. [The engineering guide](docs/engineering.md#configuration) lists them.

## How quality is enforced

Checks run automatically at three points:

| When | What runs |
|---|---|
| Every commit | Linters and type checks for the part of the code you changed, in seconds. Documentation-only commits skip them. |
| Every push | A dependency security check, all linters, all tests and the end-to-end tests, once per version of the code: pushing files that already passed, or only documentation changes, skips everything except the security check, which runs on every push |
| Every pull request | The same checks on GitHub Actions, which must pass before anything merges into `main` |

- Test coverage must stay at 95% or above on both the backend and the frontend, or the build fails. Coverage is the share of the code that the tests exercise.
- End-to-end tests drive a real browser through the real app with Playwright. They search, filter, open details, use the map, and check how the app behaves when the API fails.
- Accessibility is tested automatically with axe-core, in a simulated browser and in a real one, including color contrast in both themes.
- The dependency security check blocks a push when a library the app ships with has a high or critical vulnerability that already has a fix. If no fix exists yet, the check only warns, because there's nothing to upgrade to. You can override a block at the prompt, and every override is logged.
- Pull requests follow a template: a short summary, the files changed and why, and checklists for testing and review.

### Screenshots in pull requests

When a pull request changes an end-to-end test, one command (`npm run pr:evidence:publish`) reruns those tests and adds what they saw to the pull request description. That's a screenshot at each step and a browser-style network panel listing every API call, with its status, timing and response. Reviewers can see what a change does without running it themselves. If no end-to-end test changed, nothing is added. Map screenshots show markers without the street map behind them, because the tests block map tiles; a note in the pull request explains this when it applies.

The screenshots are stored on a separate branch in the repository called `pr-evidence`. GitHub can only show an image in a pull request description if the image has a web address, and GitHub has no way to upload an image to a pull request from the command line. A branch gives each image a stable address inside the same repository. Keeping it separate means the images never appear in the code history or in a pull request's list of changed files.

[The engineering guide](docs/engineering.md) covers testing, the checks and the tooling in detail.

## Trade-offs

- The data lives in memory. 12 records don't need a database, and the code that loads data is a single replaceable piece, so adding a database later only changes that piece.
- Keyword search is literal. "pets" also matches "no pets". Fixing that properly means pulling structured facts out of descriptions, which is a product decision.
- "pet" doesn't match "pets". Matching word variants would be a small, contained change.
- Only active listings show by default, as on consumer property sites.
- The ranking weights are reasonable starting values, not tuned on real user behavior.
- Saved searches live in your browser. Syncing them to an account would need sign-in.
- Rate limits are counted per server process. Running several servers would need a shared counter, such as Redis.
- Map tiles come from OpenStreetMap's free public servers, which suits a demo. A production app would pay for a tile provider.

## What's next

Another source plugs in the same way SimplyRETS did: one module that turns its records into the app's feed format. The Kaggle "USA Real Estate Dataset", about 2.2 million real listings, is the next candidate. Its license is unclear, so it would be downloaded by a script rather than stored in the repository, and at that size the in-memory list would give way to a database.

## More documentation

- [API reference](docs/api.md): endpoints, parameters, responses and errors.
- [Ranking and duplicates](docs/ranking.md): how scores are calculated and how duplicate listings are merged.
- [Engineering guide](docs/engineering.md): architecture, configuration, testing, quality checks, styling and project layout.
