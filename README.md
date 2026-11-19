# delayedbuy v1.1

Reserve a fictional item. Give yourself time. Then decide whether to complete the purchase or cancel it.

**Simulation only.** There are no real accounts, card fields, wallets, deposits, payouts, merchants or fees. Every order and balance is an example stored in this browser. Nobody receives money. Nothing earns interest.

## Try it

1. From this directory, run `python3 -m http.server 4173 --bind 127.0.0.1` and open [the local demo](http://127.0.0.1:4173/).
2. In checkout, choose simulated SGD card or USDC. Create a hold and open its customer view. Try canceling one hold and advancing the demo clock to complete another.
3. In merchant view, compare funded, held, paid and refunded amounts. Card principal returns to the original simulated card; USDC returns to its original simulated wallet. The two units are never added together.

Alternatively, [download the single-file demo](https://github.com/EauDoon/DelayedBuy/raw/refs/heads/main/downloads/delayedbuy-demo.html). If the browser prevents opening local HTML, serve it over local HTTP as above.

## The price of a pause

Open **Report** from the top navigation or visit `/#report` on a local server. Pick a basket, invested time and annual rate to compare 64 card-funded scenarios. A separate fixed example compares card funding with an already-funded wallet at S$100 equivalent, seven days and 4% simple APR. The charts distinguish gross interest, refundable principal, a cancellation reward and the modeled cost of prepayment. If deploying under a repository subpath, add `#report` to the repository’s Pages root URL instead.

## What's here

- `index.html`, `ui/` and `core/`: the static app, original fictional lamp illustration, interfaces and ledger. No server, external telemetry or payment integrations.
- `economics/`: a separate illustrative scenario model, fixtures and tests. Its rates and costs are hypothetical inputs, not available returns, provider approvals or investment recommendations. None of these rates are paid by this demo.
- `tests/`: ledger and Chromium browser checks. `scripts/package_demo.py` builds standalone HTML or a minimal static site.

## Verify and package

```sh
node --test tests/*.test.mjs
python3 scripts/build_report_data.py
python3 -m unittest discover -s economics -v
python3 scripts/package_demo.py --standalone dist/delayedbuy-demo.html --pages dist/site
python3 tests/browser_smoke.py --standalone dist/delayedbuy-demo.html
```

The browser suite needs Python Playwright plus Chromium. The app and other checks require no package installation beyond standard Node and Python runtimes. Site packaging expects a new or empty destination. Refreshing or clearing this browser’s storage affects only its demo state. Browser storage is not an authentication boundary or a settlement system.

The offline report uses `economics/sensitivity.csv` for its 64 card cases and `economics/scenarios.csv` for the fixed funding comparison. The downloadable sensitivity CSV stores APRs as fractions (0.04 means 4%). Its break-even APRs are continuous estimates before whole-cent settlement rounding. Browser tests cover the report and the checkout, including Back navigation during a confirmation, keyboard focus restoration and a queued checkout that must not override later navigation.

**Static hosting:** the prebuilt `docs/` directory contains only the standalone simulator and `.nojekyll`. To enable GitHub Pages, select **Settings → Pages → Deploy from a branch → main → /docs**. Publication of the source does not itself enable hosting.

[Read the v1.0 baseline](https://github.com/EauDoon/DelayedBuy/tree/818fedf9ec625a8cb9513f318a713c38789df7e7).