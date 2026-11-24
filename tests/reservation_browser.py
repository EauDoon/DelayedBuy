"""Chromium journeys for the separate synthetic, one-unit reservation rehearsal."""
from datetime import datetime, timezone
import json

from playwright.sync_api import expect


START = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
FAIL_FIRST_OPEN = """(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function(name, ...args) {
        if (name === 'delayedbuy.reservation.v1' && !sessionStorage.getItem('qa.failed-reservation-open')) {
            sessionStorage.setItem('qa.failed-reservation-open', 'once');
            const failed = {error: new DOMException('Temporary database error', 'UnknownError')};
            queueMicrotask(() => failed.onerror());
            return failed;
        }
        return open.call(this, name, ...args);
    };
})();"""


def enter(page, base):
    if page.url != base + '#reservation':
        page.goto(base + '#reservation', wait_until='load')
    expect(page.locator('[data-res-offer]')).to_be_visible()


def receipt(page, request_id):
    return page.locator(f'#reservation-shopper [data-status][data-request-id="{request_id}"]')


def action(page, kind, request_id):
    return page.locator(f'[data-res-action="{kind}"][data-request-id="{request_id}"]')


def request(page, shopper):
    card = page.locator('#reservation-shopper article').filter(
        has=page.get_by_role('heading', name=f'Shopper {shopper}', exact=True))
    previous = card.get_attribute('data-request-id')
    page.get_by_role('button', name=f'Request as Shopper {shopper}', exact=True).click()
    expect(card).to_have_attribute('data-status', 'pending')
    new_id = card.get_attribute('data-request-id')
    assert new_id and new_id != previous
    return new_id


def assert_stock(page, units):
    expect(page.locator('[data-res-available]')).to_have_text(f'{units} of 1 available')


def assert_metric(page, name, value):
    metric = page.locator(f'[data-res-metric="{name}"]')
    expect(metric).to_be_visible()
    expect(metric).to_have_attribute('data-value', str(value))
    return int(metric.get_attribute('data-value'))


def reservation_record(page, replacement=None):
    """Read the committed pilot state, or install a deliberately damaged test record."""
    return page.evaluate("""async replacement => {
        const db = await new Promise((resolve, reject) => {
            const open = indexedDB.open('delayedbuy.reservation.v1');
            open.onupgradeneeded = () => open.transaction.abort();
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
        });
        try {
            const tx = db.transaction('rehearsal', replacement === null ? 'readonly' : 'readwrite');
            const store = tx.objectStore('rehearsal');
            const req = replacement === null ? store.get('state') : store.put(replacement, 'state');
            return await new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve(req.result);
                tx.onabort = () => reject(tx.error);
            });
        } finally { db.close(); }
    }""", replacement)


def check_no_funded_workspace(page):
    observed = page.evaluate("""async key => ({
        funded_db: !!window.indexedDB && (await indexedDB.databases()).some(db => db.name === key),
        local_save: localStorage.getItem(key), session_save: sessionStorage.getItem(key),
    })""", 'delayedbuy.sandbox.v1')
    assert observed == {'funded_db': False, 'local_save': None, 'session_save': None}, observed


def reservation_journey(page, base, funded_raw=None):
    before = funded_raw(page) if funded_raw else None
    page.clock.set_fixed_time(START)
    if funded_raw:
        page.get_by_role('link', name='Try the 24-hour reservation').click()
    enter(page, base)
    if funded_raw is None:
        check_no_funded_workspace(page)
    expect(page.locator('[data-res-offer]')).to_have_text('S$180.00')
    assert_stock(page, 1)
    first = request(page, 'A')
    stale = request(page, 'B')
    assert_stock(page, 1)
    assert_metric(page, 'accepted', 0)
    expect(receipt(page, first)).to_contain_text('This request holds no stock')
    action(page, 'accept', first).click()
    expect(receipt(page, first)).to_have_attribute('data-status', 'active')
    expect(page.locator('[data-res-outcomes]')).to_contain_text('No completed reservations yet')
    assert_stock(page, 0)
    page.get_by_label('Price for new requests').select_option('20000')
    expect(page.locator('[data-res-offer]')).to_have_text('S$200.00')
    expect(receipt(page, first)).to_contain_text('S$180.00')
    page.locator('[data-res-action=advance][data-hours="1"]').click()
    assert_metric(page, 'timeHeldMs', 3_600_000)
    action(page, 'return', first).click()
    expect(receipt(page, first)).to_have_attribute('data-status', 'returned')
    expect(receipt(page, first)).to_contain_text('No sale was recorded')
    assert_stock(page, 1)
    expect(action(page, 'accept', stale)).to_be_disabled()
    expect(receipt(page, stale)).to_have_attribute('data-status', 'pending')
    action(page, 'decline', stale).click()
    expect(receipt(page, stale)).to_have_attribute('data-status', 'declined')

    withdrawn = request(page, 'A')
    expect(receipt(page, withdrawn)).to_contain_text('S$200.00')
    action(page, 'withdraw', withdrawn).click()
    expect(receipt(page, withdrawn)).to_have_attribute('data-status', 'withdrawn')
    cases = [(first, 'A', 'S$180.00', 'returned'), (stale, 'B', 'S$180.00', 'declined'),
             (withdrawn, 'A', 'S$200.00', 'withdrawn')]
    for shopper, decision, terminal in [('B', 'cancel', 'cancelled'), ('A', 'release', 'released')]:
        request_id = request(page, shopper)
        expect(receipt(page, request_id)).to_contain_text('S$200.00')
        action(page, 'accept', request_id).click()
        expect(receipt(page, request_id)).to_have_attribute('data-status', 'active')
        assert_stock(page, 0)
        action(page, decision, request_id).click()
        expect(receipt(page, request_id)).to_have_attribute('data-status', terminal)
        assert_stock(page, 1)
        cases.append((request_id, shopper, 'S$200.00', terminal))
    expected = dict(requests=5, accepted=3, declined=1, withdrawn=1, returns=1, cancellations=1,
                    releases=1, expiries=0, timeHeldMs=3_600_000)
    page.reload(wait_until='load')
    metrics = {key: assert_metric(page, key, value) for key, value in expected.items()}
    expect(page.locator('[data-res-outcomes]')).to_contain_text('1 of 3 completed reservations')
    with page.expect_download() as pending:
        page.get_by_role('button', name='Download current results (JSON)').click()
    item = pending.value
    assert item.suggested_filename == 'delayedbuy-reservation-results.json'
    with open(item.path(), encoding='utf-8') as handle:
        snapshot = json.load(handle)
    assert snapshot['simulationOnly'] is True and snapshot['metrics'] == expected
    assert len(snapshot['requests']) == 5 and snapshot['availableUnits'] == 1
    assert_stock(page, 1)
    page.get_by_text('Request history', exact=True).click()
    history = page.locator('#res-history tbody tr')
    expect(history).to_have_count(len(cases))
    rows = []
    for request_id, shopper, price, status in cases:
        row = page.locator(f'#res-history tbody tr[data-request-id="{request_id}"]')
        expect(row).to_have_attribute('data-status', status)
        expect(row.get_by_role('rowheader')).to_have_text('Shopper ' + shopper)
        expect(row.get_by_role('cell').nth(1)).to_have_text(price)
        rows.append({'request_id': request_id, 'shopper': shopper, 'requested_price': price,
                     'outcome': status, 'unit_time': row.get_by_role('cell').last.inner_text()})
    if funded_raw:
        assert funded_raw(page) == before, 'Reservation rehearsal changed the funded simulation'
    else:
        check_no_funded_workspace(page)
    return {'requests': rows, 'metrics': metrics, 'available_units': 1, 'accepted_price': 'S$180.00',
            'later_offer': 'S$200.00', 'funded_ledger': 'unchanged' if funded_raw else 'never created'}


def tab_to(page, target):
    for _ in range(65):
        if target.evaluate('el => el === document.activeElement'):
            return
        page.keyboard.press('Tab')
    expect(target).to_be_focused()


def reservation_keyboard(page, base):
    enter(page, base)
    page.clock.set_fixed_time(START)
    offer = page.locator('.res-offer')
    for term in ('A request sets aside no stock', '24 hours from acceptance', 'expires automatically',
                 'No payment is taken and no sale is recorded'):
        expect(offer).to_contain_text(term)
    expect(page.locator('#reservation-shopper input, #reservation-shopper textarea')).to_have_count(0)
    request_button = page.get_by_role('button', name='Request as Shopper A', exact=True)
    tab_to(page, request_button)
    page.keyboard.press('Enter')
    card = page.locator('#reservation-shopper [data-status=pending][data-request-id]')
    expect(card).to_be_visible()
    request_id = card.get_attribute('data-request-id')
    accept = action(page, 'accept', request_id)
    tab_to(page, accept)
    page.keyboard.press('Enter')
    active = receipt(page, request_id)
    expect(active).to_have_attribute('data-status', 'active')
    expiry = active.locator('[data-res-expiry]')
    expect(expiry).to_be_visible()
    expect(expiry).to_contain_text('SGT')
    tab_to(page, action(page, 'cancel', request_id))
    page.keyboard.press('Space')
    expect(active).to_have_attribute('data-status', 'cancelled')
    assert_stock(page, 1)
    widths = page.evaluate('''() => ({content: document.documentElement.scrollWidth,
        body: document.body.scrollWidth, viewport: document.documentElement.clientWidth})''')
    assert max(widths.values()) == page.viewport_size['width'], widths
    check_no_funded_workspace(page)
    return {'keyboard': ['request', 'accept', 'cancel'], 'widths': widths, 'funded_ledger': 'never created'}


def reservation_recovery(page, base):
    def unavailable():
        expect(page.get_by_role('heading', name='Reservation unavailable.')).to_be_visible()
        expect(page.get_by_role('button', name='Request as Shopper A')).to_have_count(0)

    unavailable()
    initial_load = page.evaluate('performance.timeOrigin')
    page.get_by_role('button', name='Try again').click()
    enter(page, base)
    assert page.evaluate('performance.timeOrigin') == initial_load
    request(page, 'A')
    damaged = {'version': 1, 'offsetMs': 0, 'events': [{'type': 'unrecognized'}]}
    reservation_record(page, replacement=damaged)
    page.reload(wait_until='load')
    unavailable()
    # Wait for the retry to really read the bad record a second time.
    page.evaluate("""() => {
        const transact = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function(...args) {
            const tx = transact.apply(this, args);
            if (this.name === 'delayedbuy.reservation.v1') {
                IDBDatabase.prototype.transaction = transact;
                tx.addEventListener('abort', () => { document.documentElement.dataset.qaRetry = 'read'; });
            }
            return tx;
        };
    }""")
    page.get_by_role('button', name='Try again').click()
    expect(page.locator('html')).to_have_attribute('data-qa-retry', 'read')
    unavailable()
    assert reservation_record(page) == damaged
    check_no_funded_workspace(page)
    page.locator('#primary-nav').get_by_role('link', name='Customer view').click()
    expect(page.locator('.order-list .order-btn')).to_have_count(3)
    assert reservation_record(page) == damaged
    return {'transient_open_retried_in_place': True, 'damaged_record_preserved': True, 'funded_view_available': True}


def reservation_history_restart(page, base, funded_raw=None, session=False):
    funded = funded_raw(page) if funded_raw else None
    page.clock.set_fixed_time(START)
    enter(page, base)
    key = 'delayedbuy.reservation.v1'
    at = int(START.timestamp() * 1000)
    capped = {'version': 1, 'offsetMs': 3_600_000,
              'events': [{'type': 'price', 'priceCents': 20000, 'at': at}] * 999
                        + [{'type': 'advance', 'hours': 1, 'at': at}]}
    if session:
        page.evaluate('([key, record]) => sessionStorage.setItem(key, JSON.stringify(record))', [key, capped])
        current = lambda: page.evaluate('key => JSON.parse(sessionStorage.getItem(key))', key)
    else:
        reservation_record(page, capped)
        current = lambda: reservation_record(page)
    page.reload(wait_until='load')
    expect(page.get_by_text('No room for another request', exact=False)).to_be_visible()
    expect(page.get_by_role('button', name='Request as Shopper A')).to_be_disabled()
    expect(page.get_by_role('button', name='+24 hours')).to_be_disabled()
    expect(page.get_by_label('Price for new requests')).to_be_disabled()
    restart = page.get_by_role('button', name='Start a new rehearsal')
    page.once('dialog', lambda dialog: dialog.dismiss())
    restart.click()
    assert current() == capped, 'Cancelled restart changed the saved rehearsal'
    page.once('dialog', lambda dialog: dialog.accept())
    restart.click()
    expect(page.get_by_role('button', name='Request as Shopper A')).to_be_enabled()
    expect(page.locator('[data-res-offer]')).to_have_text('S$180.00')
    expect(page.get_by_text('Archived rehearsals: 1.')).to_be_visible()
    output = current()
    assert (output['state'] if session else output) == {'version': 1, 'offsetMs': 0, 'events': []}
    if session:
        assert output['archives'][0]['state'] == capped
    page.reload(wait_until='load')
    with page.expect_download() as download:
        page.get_by_role('button', name='Download archived histories (JSON)').click()
    data = json.loads(download.value.path().read_text(encoding='utf-8'))
    assert [archive['state'] for archive in data['archives']] == [capped]
    request(page, 'A')
    if funded_raw:
        assert funded_raw(page) == funded, 'Restart changed the demo-funded ledger'
    else:
        check_no_funded_workspace(page)
    return {'old_events': len(capped['events']), 'old_history_exported': True, 'new_request_succeeded': True,
            'funded_ledger': 'unchanged' if funded_raw else 'never created', 'storage': 'session' if session else 'shared'}
