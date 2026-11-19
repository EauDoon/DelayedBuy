# delayedbuy v1.0

Reserve a fictional item. Give yourself time. Then decide whether to complete the purchase or cancel it.

**Simulation only.** There are no real accounts, card fields, wallets, deposits, payouts, merchants or fees. Every order and balance is an example stored in this browser. Nobody receives money. Nothing earns interest.

## Try it

1. From this directory, run `python3 -m http.server 4173 --bind 127.0.0.1` and open [the local demo](http://127.0.0.1:4173/).
2. In checkout, choose simulated SGD card or USDC. Create a hold and open its customer view. Try canceling one hold and advancing the demo clock to complete another.
3. In merchant view, compare funded, held, paid and refunded amounts. Card principal returns to the original simulated card; USDC returns to its original simulated wallet. The two units are never added together.

Alternatively, [download the single-file demo](https://github.com/EauDoon/DelayedBuy/raw/refs/heads/main/downloads/delayedbuy-demo.html). If the browser prevents opening local HTML, serve it over local HTTP as above.

## What's here

- `index.html`, `ui/` and `core/`: the static app, original fictional lamp illustration, interfaces and ledger. No server, external telemetry or payment integrations.
- `economics/`: a separate illustrative scenario model, fixtures and tests. Its rates and costs are hypothetical inputs, not available returns, provider approvals or investment recommendations. None of these rates are paid by this demo.
- `tests/`: ledger and Chromium browser checks. `scripts/package_demo.py` builds standalone HTML or a minimal static site.

## Verify and package

```sh
node --test tests/ledger.test.mjs
python3 -m unittest discover -s economics -v
python3 scripts/package_demo.py --standalone dist/delayedbuy-demo.html --pages dist/site
python3 tests/browser_smoke.py --standalone dist/delayedbuy-demo.html
```

The browser suite needs Python Playwright plus Chromium. The app and other checks require no package installation beyond standard Node and Python runtimes. Site packaging expects a new or empty destination. Refreshing or clearing this browser’s storage affects only its demo state. Browser storage is not an authentication boundary or a settlement system.

For v1.0, 9 ledger and 11 economics checks passed on release verification. The original browser suite passed 12 site journeys and the standalone HTTP journey; direct-file playback was not verified in that run. The released standalone file rebuilt byte-for-byte from the app source (SHA-256 `dbe5304f8fde158b553eba8b8e8b99734fae40a9400ea96d23e857f633d6faf8`).
