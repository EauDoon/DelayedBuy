"""Browser checks for the one-unit reservation and its exact expiry."""
from datetime import timedelta

from playwright.sync_api import expect

from reservation_browser import (START, action, assert_metric, assert_stock,
                                 check_no_funded_workspace, enter, receipt, request, reservation_record)


def reservation_events(page):
    return reservation_record(page)['events']


def hold_writes(page):
    # A real IndexedDB writer holds both tabs' reviewed decisions in the queue.
    page.evaluate("""() => new Promise((resolve, reject) => {
        const open = indexedDB.open('delayedbuy.reservation.v1');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('rehearsal', 'readwrite');
            const store = tx.objectStore('rehearsal');
            let held = true;
            window.releaseWriter = () => { held = false; };
            function keepAlive() {
                const read = store.count('state');
                read.onsuccess = () => { resolve(); if (held) keepAlive(); };
            }
            tx.oncomplete = () => db.close();
            tx.onabort = () => { db.close(); reject(tx.error); };
            keepAlive();
        }
    })""")


def queue_accept(page, request_id):
    button = action(page, 'accept', request_id)
    expect(button).to_be_enabled()
    # Record when this click starts a transaction, before releasing the blocking writer.
    button.evaluate("""el => {
        const transact = IDBDatabase.prototype.transaction;
        window.acceptQueued = false;
        IDBDatabase.prototype.transaction = function(...args) {
            const tx = transact.apply(this, args);
            if (this.name === 'delayedbuy.reservation.v1' && tx.mode === 'readwrite') {
                IDBDatabase.prototype.transaction = transact;
                window.acceptQueued = true;
            }
            return tx;
        };
        el.click();
    }""")
    page.wait_for_function('window.acceptQueued === true', timeout=4000)


def reservation_race(page, base):
    page.clock.set_fixed_time(START)
    enter(page, base)
    first = request(page, 'A')
    second = request(page, 'B')
    peer = page.context.new_page()
    enter(peer, base)
    for tab in (page, peer):
        assert_stock(tab, 1)
        for request_id in (first, second):
            expect(receipt(tab, request_id)).to_have_attribute('data-status', 'pending')
            expect(action(tab, 'accept', request_id)).to_be_enabled()
    hold_writes(page)
    try:
        queue_accept(page, first)
        queue_accept(peer, second)
    finally:
        page.evaluate('() => window.releaseWriter()')
    for tab in (page, peer):
        expect(receipt(tab, first)).to_have_attribute('data-status', 'active')
        expect(receipt(tab, second)).to_have_attribute('data-status', 'pending')
        assert_stock(tab, 0)
        assert_metric(tab, 'accepted', 1)
    accepts = [event['id'] for event in reservation_events(page) if event['type'] == 'accept']
    assert accepts == [first], accepts

    # Releasing the winner frees the unit and enables the other tab's pending request.
    action(page, 'release', first).click()
    assert_stock(peer, 1)
    action(peer, 'accept', second).click()
    expect(receipt(page, second)).to_have_attribute('data-status', 'active')
    page.reload()
    expect(receipt(page, first)).to_have_attribute('data-status', 'released')
    expect(receipt(page, second)).to_have_attribute('data-status', 'active')
    assert_metric(page, 'accepted', 2)
    assert_stock(page, 0)
    check_no_funded_workspace(page)
    return {'tabs': 2, 'requests_for_one_unit': [first, second], 'initial_accepts': accepts,
            'unit_reassigned_after_release': second}


def reservation_expiry(page, base):
    # Pause the browser clock so the one-millisecond assertions do not depend on machine speed.
    page.clock.install(time=START - timedelta(seconds=5))
    page.clock.pause_at(START)
    enter(page, base)
    request_id = request(page, 'A')
    hour_ms = 3_600_000
    duration = 24 * hour_ms
    page.clock.fast_forward(hour_ms)
    action(page, 'accept', request_id).click()
    card = receipt(page, request_id)
    expect(card).to_have_attribute('data-status', 'active')
    offer = page.locator('[data-res-offer]')
    price = card.locator('.res-facts strong')
    expect(offer).to_have_text('S$180.00')
    expect(price).to_have_text('S$180.00')
    page.get_by_label('Price for new requests').select_option('20000')

    def assert_prices():
        expect(offer).to_have_text('S$200.00')
        expect(price).to_have_text('S$180.00')

    assert_prices()
    deadline = START + timedelta(hours=25)
    iso_deadline = deadline.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    expect(card.locator('[data-res-expiry]')).to_have_attribute('datetime', iso_deadline)
    page.clock.fast_forward(duration - 1)
    page.reload()
    expect(card).to_have_attribute('data-status', 'active')
    assert_prices()
    assert_stock(page, 0)
    assert_metric(page, 'timeHeldMs', duration - 1)
    page.clock.run_for(1)
    expect(card).to_have_attribute('data-status', 'expired')
    assert_prices()
    assert_stock(page, 1)
    assert_metric(page, 'expiries', 1)
    assert_metric(page, 'returns', 0)
    assert_metric(page, 'timeHeldMs', duration)
    events = reservation_events(page)
    assert [(e['type'], e.get('id')) for e in events] == [
        ('request', request_id), ('accept', request_id), ('price', None), ('expiry', request_id)]
    assert (events[0]['priceCents'], events[2]['priceCents']) == (18_000, 20_000)
    assert events[-1]['at'] == int(deadline.timestamp() * 1000)
    assert events[-1]['at'] - events[1]['at'] == duration
    page.clock.fast_forward(1)
    page.reload()
    expect(card).to_have_attribute('data-status', 'expired')
    assert_prices()
    assert_metric(page, 'timeHeldMs', duration)
    assert_stock(page, 1)
    assert reservation_events(page) == events
    check_no_funded_workspace(page)
    return {'request_id': request_id, 'acceptance_delay_ms': hour_ms, 'expiry_scheduled_utc': iso_deadline,
            'fixed_price_through_expiry': 'S$180.00', 'later_offer': 'S$200.00',
            'held_ms': duration, 'expiries_after_reload': 1, 'returns': 0}
