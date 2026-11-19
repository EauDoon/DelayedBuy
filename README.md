# delayedbuy v1.2

Start a demo hold on the fictional Arc table lamp. The hold sets aside demo funds and fixes your price in the selected unit. It reserves no stock and has no automatic expiry. The waiting period determines when you can first buy. Choose **Complete purchase**, then **Confirm purchase** to buy, or cancel any time before buying for a full return to the original demo card or wallet.

**Simulation only.** There are no real accounts, card fields, wallets, deposits, payouts, merchants or fees. Every order and balance is an example stored in this browser. Nobody receives money. Nothing earns interest.

## Try it

1. From this directory, run `python3 -m http.server 4173 --bind 127.0.0.1` and open [the local demo](http://127.0.0.1:4173/).
2. In checkout, switch between the SGD card and USDC wallet, then choose a waiting period. Review the fixed price and earliest purchase time in SGT above **Create demo hold**. Open the customer view to see the terms saved for that hold.
3. In merchant view, compare funded, held, paid and refunded amounts. Card principal returns to the original simulated card; USDC returns to its original simulated wallet. The two units are never added together.

Alternatively, [download the single-file demo](https://github.com/EauDoon/DelayedBuy/raw/refs/heads/main/downloads/delayedbuy-demo.html). If the browser prevents opening local HTML, serve it over local HTTP as above.

## The price of a pause

Open **Report** from the top navigation or visit `/#report` on a local server. Pick a basket, invested time and annual rate to compare 64 card-funded scenarios. A separate fixed example compares card funding with an already-funded wallet at S$100 equivalent, seven days and 4% simple APR. The charts distinguish gross interest, refundable principal, a cancellation reward and the modeled cost of prepayment. If deploying under a repository subpath, add `#report` to the repository’s Pages root URL instead.

## Synthetic merchant rehearsal

Three fictional shoppers each start both paths with the same S$180 Arc table lamp on 12 January 2026 at 10:00 SGT. DelayedBuy uses the demo SGD card and a one-day wait. Both paths are observed through 14 January at 10:00 SGT. Chromium drives the DelayedBuy checkout. Ordinary checkout is a scripted reference inside the test fixture.

| Case | Ordinary checkout | DelayedBuy |
| --- | --- | --- |
| Buy at the first opportunity | Explicitly confirms at entry on 12 January. | Creates the hold at entry and confirms the purchase on 13 January at 10:00 SGT. |
| Explicitly decline | Leaves checkout at entry on 12 January. | Creates the hold, then cancels at entry while the wait is still running. |
| Leave without returning | No order by the cutoff. | Creates the hold at entry. It remains open at the cutoff, with no sale or refund. |

Only an explicit confirmation counts as a purchase. The three new DelayedBuy holds must reconcile to **S$540 funded = S$180 completed + S$180 refunded + S$180 still held**. The fixture excludes seeded orders and checks that ordinary checkout produces zero ledger movements. These scripted cases supply no estimate of conversion lift.

Run the verification commands below to reproduce the rehearsal. In `evidence/browser-tests.json`, the **Paired merchant rehearsal** case records each path’s start, decision time if any, observation cutoff, outcome and supporting fixture step or ledger request IDs.

## What's here

- `index.html`, `ui/` and `core/`: the static app, original fictional lamp illustration, interfaces and ledger. No server, external telemetry or payment integrations.
- `economics/`: a separate illustrative scenario model, fixtures and tests. Its rates and costs are hypothetical inputs, not available returns, provider approvals or investment recommendations. None of these rates are paid by this demo.
- `tests/`: ledger and Chromium browser checks. `scripts/package_demo.py` builds standalone HTML or a minimal static site.

## Verify and package

```sh
node --test tests/*.test.mjs
python3 -m unittest discover -s economics -v
python3 scripts/build_report_data.py
git diff --exit-code -- ui/report-data.mjs
stage=$(mktemp -d)
python3 scripts/package_demo.py --standalone "$stage/delayedbuy-demo.html" --pages "$stage/site"
cmp "$stage/delayedbuy-demo.html" docs/index.html
cmp "$stage/delayedbuy-demo.html" downloads/delayedbuy-demo.html
node tests/ui-events.cjs "$stage/delayedbuy-demo.html"
python3 tests/browser_smoke.py --standalone "$stage/delayedbuy-demo.html"
```

The browser suite uses Python Playwright (CI pins `playwright==1.62.0`) and Chromium. Set `CHROMIUM_BIN` if your Chromium executable is outside the usual path. The app and other checks require no package installation beyond standard Node and Python runtimes. Site packaging expects a new or empty destination. Refreshing or clearing this browser’s storage affects only its demo state. Browser storage is not an authentication boundary or a settlement system.

On first open, v1.2 imports a shared v1.1 save into IndexedDB with its original clock and ledger. Existing tab-only saves stay in their tab. Shared tabs check the latest saved hold inside a single transaction before recording a decision. If another tab changes the demo clock while checkout is waiting to save, the shopper reviews the revised purchase time before creating the hold.

The offline report uses `economics/sensitivity.csv` for its 64 card cases and `economics/scenarios.csv` for the fixed funding comparison. The downloadable sensitivity CSV stores APRs as fractions (0.04 means 4%). Its break-even APRs are continuous estimates before whole-cent settlement rounding. Browser tests cover the report and the checkout, including Back navigation during a confirmation, keyboard focus restoration and a queued checkout that must not override later navigation.

**Static hosting:** the prebuilt `docs/` directory contains only the standalone simulator and `.nojekyll`. To enable GitHub Pages, select **Settings → Pages → Deploy from a branch → main → /docs**. Publication of the source does not itself enable hosting.

[Read the v1.0 baseline](https://github.com/EauDoon/DelayedBuy/tree/818fedf9ec625a8cb9513f318a713c38789df7e7).
