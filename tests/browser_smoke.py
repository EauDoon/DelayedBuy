"""Local end-to-end checks. Run `python tests/browser_smoke.py` with Playwright and Chromium."""
import argparse
import hashlib
import json
import re
import os
import platform
import shutil
import sys
import threading
import time
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PREFIX = '/qa/preview/delayedbuy/'
OUTPUT = ROOT / 'evidence' / 'browser-tests.json'


class SiteFiles(SimpleHTTPRequestHandler):
    """Only the non-root demo mount exists, so broken absolute asset paths cannot pass."""

    def translate_path(self, path):
        route = unquote(urlsplit(path).path)
        if not route.startswith(PREFIX) or '..' in route.split('/'):
            return str(ROOT / '__unmounted__')
        if route == PREFIX + 'delayedbuy-demo.html' and self.server.standalone_file:
            return str(self.server.standalone_file)
        return str(ROOT / route.removeprefix(PREFIX))

    def log_message(self, *args):
        pass


@contextmanager
def static_site(standalone_file=None):
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SiteFiles, directory=str(ROOT)))
    server.standalone_file = standalone_file
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}{PREFIX}'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def build_hashes():
    files = [ROOT / 'index.html', *sorted((ROOT / 'core').rglob('*.mjs')),
             *sorted(p for p in (ROOT / 'ui').rglob('*') if p.is_file()), Path(__file__)]
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


class Run:
    def __init__(self, browser, url):
        self.browser = browser
        self.url = url
        self.cases = []
        self.attempts = []
        self.local_paths = set()

    def case(self, name, fn, width=1280, height=850, mobile=False, javascript=True):
        record = {'case': name, 'viewport': [width, height], 'status': 'failed'}
        before = time.monotonic()
        alerts = []
        context = self.browser.new_context(viewport={'width': width, 'height': height},
                                           is_mobile=mobile, has_touch=mobile, java_script_enabled=javascript,
                                           timezone_id='Asia/Singapore', service_workers='block')
        context.set_default_timeout(4500)
        context.expose_binding('recordPaymentAttempt', lambda _, name: alerts.append(f'Unexpected payment API: {name}'))
        # An isolated, inert provider catches unexpected signing/account requests in a wallet-enabled browser.
        context.add_init_script('''(() => {
          window.__paymentAttempts = [];
          const guard = name => () => {
            window.__paymentAttempts.push(name);
            window.recordPaymentAttempt(name);
            return Promise.reject(new Error('Unexpected live payment API: ' + name));
          };
          Object.defineProperty(window, 'ethereum', {value: {request: guard('ethereum.request')}});
          if (window.PaymentRequest) window.PaymentRequest.prototype.show = guard('PaymentRequest.show');
        })()''')

        def permit_local(route):
            request = route.request
            parsed = urlsplit(request.url)
            if parsed.scheme == 'data':
                route.continue_()
                return
            matches = (parsed.scheme == 'file' and parsed.path == urlsplit(self.url).path) if self.url.startswith('file:') else request.url.startswith(self.url)
            allowed = matches and request.method == 'GET' and not parsed.query
            if not allowed:
                self.attempts.append({'method': request.method, 'url': request.url, 'case': name})
                alerts.append(f'Unexpected request {request.method} {request.url}')
                route.abort()
                return
            self.local_paths.add(parsed.path.removeprefix(PREFIX) or 'index.html')
            route.continue_()

        def websocket(ws):
            alerts.append(f'WebSocket attempted: {ws.url}')
            self.attempts.append({'method': 'WebSocket', 'url': ws.url, 'case': name})
            ws.close()

        context.route('**/*', permit_local)
        context.route_web_socket('**/*', websocket)
        page = context.new_page()
        page.on('pageerror', lambda e: alerts.append(f'Uncaught JS: {e}'))
        page.on('console', lambda m: alerts.append(f'{m.type}: {m.text}') if m.type == 'error' else None)
        page.on('response', lambda r: alerts.append(f'HTTP {r.status}: {r.url}') if r.status >= 400 else None)
        page.on('popup', lambda p: alerts.append(f'Unexpected popup {p.url}'))
        try:
            page.goto(self.url, wait_until='networkidle')
            record['observed'] = fn(page, self.url)
            if javascript:
                assert page.evaluate('window.__paymentAttempts') == [], 'A real payment API was invoked'
            assert not alerts, ' | '.join(alerts)
            record['status'] = 'passed'
        except Exception as exc:
            if self.url.startswith('file:') and 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(exc):
                record.update(status='blocked', reason='Local Chromium administrative URL policy blocks file:// navigation (ERR_BLOCKED_BY_ADMINISTRATOR).')
            else:
                record['failure'] = traceback.format_exc(limit=3)
        finally:
            record['browser_errors'] = list(alerts)
            record['seconds'] = round(time.monotonic() - before, 2)
            context.close()
        self.cases.append(record)
        print(f"{record['status'].upper():6} {name}", flush=True)
        if 'failure' in record:
            print(record['failure'], file=sys.stderr, flush=True)

KEY = 'delayedbuy.sandbox.v1'
ROUTES = ['report', 'home', 'how', 'checkout', 'customer', 'merchant']
DAY_MS = 86_400_000


def sgt(timestamp):
    return datetime.fromtimestamp(timestamp / 1000, ZoneInfo('Asia/Singapore')).strftime('%d-%m-%Y · %H:%M SGT')


def iso_time(timestamp):
    return datetime.fromtimestamp(timestamp / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def checkout_answers(page, price, unlock):
    terms = page.locator('#checkout-form #checkout-terms')
    expected = [
        ('Is one set aside for me?', 'This demo reserves no stock.'),
        ('Can my price change?', f'Your demo price stays {price} until you buy or cancel.'),
        ('When does the hold expire?', f'No automatic expiry. You can buy from {sgt(unlock)} or cancel any time before buying.'),
        ('When do I commit?', 'Creating the hold sets aside demo funds. After the wait, choose Complete purchase, then Confirm purchase to buy.'),
    ]
    submit = page.get_by_role('button', name='Create demo hold')
    terms.evaluate('el => el.scrollIntoView({block: "center", behavior: "instant"})')
    for question, answer in expected:
        row = terms.locator('.summary-line').filter(has=page.get_by_text(question, exact=True))
        expect(row).to_have_text(question + ' ' + answer, use_inner_text=True)
        expect(row).to_be_visible()
        expect(row).to_be_in_viewport(ratio=1)
    assert terms.evaluate('(el) => el.nextElementSibling === el.closest("form").querySelector("[type=submit]")')
    expect(submit).to_have_accessible_description(re.compile('This demo reserves no stock'))
    expect(terms.locator('time')).to_have_attribute('datetime', iso_time(unlock))


def saved_terms(page, opened, price):
    detail = page.locator('#order-detail')
    expect(detail.get_by_role('heading', name=opened['item'], exact=True)).to_be_visible()
    expect(detail.locator('dd.money')).to_have_text(price)
    expect(detail.get_by_text('Earliest purchase · SGT', exact=True)).to_be_visible()
    unlock = opened['at'] + opened['holdMs']
    purchase_time = detail.locator('dl time')
    expect(purchase_time).to_have_text(sgt(unlock).removesuffix(' SGT'))
    expect(purchase_time).to_have_attribute('datetime', iso_time(unlock))
    for term in ('reserves no stock', 'price stays fixed until you buy or cancel', 'No automatic expiry',
                 'choose Complete purchase, then Confirm purchase to buy', 'cancel any time before buying'):
        expect(detail).to_contain_text(term)


def visit(page, base, route):
    page.goto(f'{base}#{route}', wait_until='load')
    expect(page.locator('main .boot')).to_have_count(0)
    expect(page.locator('main h1')).to_be_visible()
    if route in ('merchant', 'checkout', 'customer'):
        selector = {'merchant': '#rail-filter', 'checkout': '#checkout-form', 'customer': '.order-list'}[route]
        expect(page.locator(selector)).to_be_visible()


def option(page, name, value):
    radio = page.locator(f'#checkout-form input[name="{name}"][value="{value}"]')
    radio.locator('xpath=ancestor::label').click()
    expect(radio).to_be_checked()


def reserve(page, base, rail, days=2):
    visit(page, base, 'checkout')
    option(page, 'rail', rail)
    option(page, 'days', str(days))
    page.locator('#checkout-form button[type=submit]').click()
    expect(page.locator('[data-action=cancel]')).to_be_visible()
    expect(page.locator('[data-action=complete]')).to_be_disabled()
    raw = page.evaluate('(key) => localStorage.getItem(key)', KEY)
    assert raw, 'No persisted simulation after reservation'
    return json.loads(raw)


def act(page, choice):
    page.locator(f'[data-action={choice}]').click()
    dialog = page.locator('#confirm-dialog')
    expect(dialog).to_be_visible()
    confirmation = 'Confirm cancellation' if choice == 'cancel' else 'Confirm purchase'
    dialog.get_by_role('button', name=confirmation, exact=True).click()
    expect(dialog).not_to_be_visible()
    expect(page.locator('#order-detail .status')).to_have_text('Refunded' if choice == 'cancel' else 'Completed')


def clock_unlock(page):
    page.locator('[data-action=unlock]').click()
    expect(page.locator('[data-action=complete]')).to_be_enabled()


def stored(page):
    return json.loads(page.evaluate('(key) => localStorage.getItem(key)', KEY))


def actions(snapshot):
    if 'ledger' in snapshot:
        return snapshot['ledger']['actions']
    return snapshot['actions']


def rail_flow(rail, decision):
    def exercise(page, base):
        initial = reserve(page, base, rail)
        opened = actions(initial)[-1]
        assert opened['type'] == 'hold' and opened['rail'] == rail, opened
        assert opened['source'] == {'card': 'card_demo', 'usdc': 'wallet_demo'}[rail], opened
        assert opened['holdMs'] == 2 * 86400000, opened
        if decision == 'complete':
            page.locator('[data-action=advance]').click()
            expect(page.locator('[data-action=complete]')).to_be_disabled()
            clock_unlock(page)
            assert actions(stored(page)) == actions(initial), 'Advancing time moved funds'
        act(page, decision)
        final_actions = actions(stored(page))
        assert len(final_actions) == len(actions(initial)) + 1
        closed = final_actions[-1]
        assert (closed['type'], closed['orderId']) == (decision, opened['orderId'])
        timeline = page.locator('.timeline')
        expect(timeline).to_be_visible()
        terminal_text = timeline.inner_text().lower()
        assert ('principal returned' if decision == 'cancel' else 'purchase completed') in terminal_text, terminal_text
        page.reload(wait_until='load')
        expect(page.locator('.timeline')).to_be_visible()
        assert actions(stored(page)) == final_actions, 'Refresh changed the event history'
        return {'rail': rail, 'source': opened['source'], 'amount_minor_units': opened['amount'],
                'hold_days': 2, 'closed_by': closed['type'], 'persisted_actions': len(final_actions)}
    return exercise


def viewport_check(page, base, screenshots=None):
    measurements = {}
    for route in ROUTES:
        visit(page, base, route)
        badge = page.locator('.sim-badge')
        expect(badge).to_be_visible()
        expect(badge).to_contain_text('Simulation')
        if route == 'checkout':
            forbidden = page.locator('input:not([type=radio]):not([type=checkbox]):not([type=hidden]), textarea, iframe, [contenteditable=true]')
            expect(forbidden).to_have_count(0)
            if page.viewport_size['width'] == 320:
                checkout_answers(page, 'S$180.00', stored(page)['now'] + 2 * DAY_MS)
        if route == 'home':
            expect(page.locator('.product-shot').first).to_be_visible()
            page.wait_for_function('document.querySelector(".product-shot").naturalWidth > 0')
            if screenshots and page.viewport_size['width'] in (390, 1280):
                viewport = 'mobile' if page.viewport_size['width'] == 390 else 'desktop'
                page.screenshot(path=str(screenshots / f'delayedbuy-{viewport}.png'), full_page=True)
        sizes = page.evaluate('''() => ({viewport: window.innerWidth,
          content: document.documentElement.scrollWidth, body: document.body.scrollWidth,
          client: document.documentElement.clientWidth})''')
        expected_width = page.viewport_size['width']
        assert sizes['content'] <= expected_width + 1 and sizes['viewport'] <= expected_width + 1, sizes
        assert sizes['client'] == expected_width, sizes
        measurements[route] = sizes
    return measurements


def landing_to_hold(page, base):
    visit(page, base, 'home')
    wait = page.get_by_label('Waiting period', exact=True)
    wait.select_option('7')
    setup = page.get_by_role('link', name='Set up my hold')
    expect(setup).to_be_in_viewport()
    setup.focus()
    page.keyboard.press('Enter')
    expect(page.locator('input[name=days][value="7"]')).to_be_checked()
    before = len(actions(stored(page)))
    submit = page.get_by_role('button', name='Create demo hold')
    submit.focus()
    page.keyboard.press('Enter')
    detail = page.locator('#order-detail')
    expect(detail).to_be_focused()
    expect(detail.locator('.status')).to_be_in_viewport()
    expect(detail).to_contain_text('7 days left')
    cancel = detail.get_by_role('button', name='Cancel hold')
    cancel.focus()
    page.keyboard.press('Enter')
    dialog = page.get_by_role('dialog', name='Cancel this hold?')
    expect(dialog).to_have_accessible_description(re.compile(r'S\$180\.00.*demo card'))
    expect(dialog.get_by_role('button', name='Go back')).to_be_focused()
    page.keyboard.press('Escape')
    expect(cancel).to_be_focused()
    assert len(actions(stored(page))) == before + 1
    page.go_back()
    expect(page.locator('input[name=days][value="7"]')).to_be_checked()
    page.go_back()
    expect(wait).to_have_value('7')
    assert len(actions(stored(page))) == before + 1
    return {'wait_days': 7, 'new_holds': 1, 'dismissed_without_refund': True}


def report_shortcut(page, base):
    visit(page, base, 'report')
    button = page.get_by_role('button', name='Explore the scenarios')
    button.focus()
    page.keyboard.press('Enter')
    expect(page.get_by_role('combobox', name='Basket', exact=True)).to_be_focused()
    expect(page.locator('.r-comparison')).to_contain_text('−S$0.0950')
    page.get_by_role('combobox', name='Basket', exact=True).select_option('25')
    expect(page.locator('.r-comparison')).to_contain_text('S$100 equivalent basket')
    page.get_by_text('Read the assumptions and limits', exact=True).click()
    with page.expect_download() as saved:
        page.get_by_role('link', name='Download the 64 card-funded cases (CSV)').click()
    assert saved.value.suggested_filename == 'sensitivity.csv'
    assert Path(saved.value.path()).read_text() == (ROOT / 'economics/sensitivity.csv').read_text()
    return {'keyboard_shortcut': True, 'fixed_wallet_example': True, 'offline_csv_matched': True}


def mobile_navigation(page, base):
    visit(page, base, 'home')
    menu = page.get_by_role('button', name='Open menu')
    expect(menu).to_be_visible()
    menu.focus()
    page.keyboard.press('Enter')
    page.keyboard.press('Tab')
    expect(page.locator('#primary-nav a').first).to_be_focused()
    page.keyboard.press('Escape')
    expect(menu).to_be_focused()
    page.keyboard.press('Enter')
    toggler = page.locator('button[aria-controls="primary-nav"]')
    expect(toggler).to_have_attribute('aria-expanded', 'true')
    page.locator('#primary-nav').get_by_role('link', name='Merchant view').click()
    expect(page.locator('#rail-filter')).to_be_visible()
    expect(toggler).to_have_attribute('aria-expanded', 'false')
    return {'opened_menu': True, 'navigated_to': 'merchant', 'auto_closed': True}


def keyboard_flow(page, base):
    visit(page, base, 'checkout')
    page.locator('#main').evaluate('(el) => el.blur()')
    # Reliable first Tab from a fresh document, independent of prior SPA focus.
    page.reload(wait_until='load')
    expect(page.locator('#checkout-form')).to_be_visible()
    page.keyboard.press('Tab')
    focus = page.evaluate('document.activeElement.outerHTML')
    assert 'Skip to content' in focus, f'First Tab: {focus}'
    page.keyboard.press('Enter')
    expect(page.locator('#main')).to_be_focused()
    expect(page.locator('#checkout-form')).to_be_visible()
    now = stored(page)['now']
    checkout_answers(page, 'S$180.00', now + 2 * DAY_MS)
    card = page.get_by_role('radio', name='SGD card')
    for _ in range(25):
        page.keyboard.press('Tab')
        if card.evaluate('(el) => document.activeElement === el'):
            break
    expect(card).to_be_focused()
    page.keyboard.press('ArrowRight')
    expect(page.get_by_role('radio', name='USDC wallet')).to_be_checked()
    checkout_answers(page, '135.00 USDC', now + 2 * DAY_MS)
    page.keyboard.press('Tab')
    expect(page.get_by_role('radio', name='2 days')).to_be_focused()
    page.keyboard.press('ArrowRight')
    expect(page.get_by_role('radio', name='7 days')).to_be_checked()
    checkout_answers(page, '135.00 USDC', now + 7 * DAY_MS)
    page.keyboard.press('Tab')
    submit = page.get_by_role('button', name='Create demo hold')
    expect(submit).to_be_focused()
    page.keyboard.press('Enter')
    cancel = page.locator('[data-action=cancel]')
    expect(cancel).to_be_visible()
    opened = actions(stored(page))[-1]
    assert (opened['item'], opened['rail'], opened['amount']) == ('Arc table lamp', 'usdc', 135_000_000)
    assert (opened['at'], opened['holdMs']) == (now, 7 * DAY_MS)
    saved_terms(page, opened, '135.00 USDC')
    cancel.focus()
    page.keyboard.press('Enter')
    dialog = page.locator('#confirm-dialog')
    expect(dialog).to_be_visible()
    assert dialog.evaluate('(el) => el.contains(document.activeElement)')
    before = actions(stored(page))
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    assert actions(stored(page)) == before, 'Escape confirmed a payment decision'
    expect(cancel).to_be_focused()
    return {'first_tab': 'Skip to content', 'submit': 'Enter', 'dismiss_dialog': 'Escape', 'focus_restored': True,
            'four_answers_before_submit': True, 'saved_price': '135.00 USDC', 'buy_from_sgt': sgt(now + 7 * DAY_MS)}


def saved_v11_decisions(page, base):
    # Original v1.1 demoLedger seed (10f2354), including its stable request IDs and storage envelope.
    now = 1_700_000_000_000
    history = [
        dict(type='hold', requestId='req_daypack_hold', orderId='ord_daypack', item='Canvas daypack',
             rail='card', source='card_demo', amount=8_500, at=now - 4 * DAY_MS, holdMs=2 * DAY_MS),
        dict(type='hold', requestId='req_studio_hold', orderId='ord_studio', item='Studio headphones',
             rail='usdc', source='wallet_demo', amount=120_000_000, at=now - 3 * DAY_MS, holdMs=2 * DAY_MS),
        dict(type='complete', requestId='req_daypack_complete', orderId='ord_daypack', at=now - DAY_MS),
        dict(type='hold', requestId='req_arc_hold', orderId='ord_arc', item='Arc table lamp',
             rail='card', source='card_demo', amount=18_000, at=now - DAY_MS, holdMs=3 * DAY_MS),
    ]
    # Restore a saved browser clock one millisecond before the card hold unlocks.
    unlock = history[3]['at'] + history[3]['holdMs']
    snapshot = dict(version=1, now=unlock - 1, ledger=dict(version=1, actions=history))
    page.evaluate('([k, v]) => localStorage.setItem(k, JSON.stringify(v))', [KEY, snapshot])
    page.reload(wait_until='load')
    visit(page, base, 'customer/ord_arc')
    expect(page.locator('[data-action=complete]')).to_be_disabled()
    expect(page.locator('[data-action=cancel]')).to_be_enabled()
    assert stored(page) == snapshot
    clock_unlock(page)
    assert stored(page)['now'] == unlock
    assert actions(stored(page)) == history
    page.locator('[data-action=advance]').click()
    expect(page.locator('.clock-label')).to_contain_text(sgt(unlock + DAY_MS))
    page.reload(wait_until='load')
    assert actions(stored(page)) == history, 'Clock advance or reload moved principal'
    for opened, price in [(history[3], 'S$180.00'), (history[1], '120.00 USDC')]:
        visit(page, base, 'customer/' + opened['orderId'])
        detail = page.locator('#order-detail')
        expect(detail.locator('.status')).to_have_text('Ready to decide')
        saved_terms(page, opened, price)
        purchase = detail.get_by_role('button', name='Complete purchase')
        purchase.focus()
        before = actions(stored(page))
        page.keyboard.press('Enter')
        dialog = page.get_by_role('dialog', name='Complete this purchase?')
        expect(dialog).to_have_accessible_description(re.compile(re.escape(price) + '.*' + re.escape(opened['item'])))
        expect(dialog.get_by_role('button', name='Go back')).to_be_focused()
        assert actions(stored(page)) == before
        page.keyboard.press('Enter')
        expect(dialog).not_to_be_visible()
        expect(purchase).to_be_focused()
        expect(detail.get_by_role('button', name='Cancel hold')).to_be_enabled()
        assert actions(stored(page)) == before
        act(page, 'cancel')
        final = actions(stored(page))
        assert final[:-1] == before
        assert (final[-1]['type'], final[-1]['orderId']) == ('cancel', opened['orderId'])
    return {'v1_1_openings': [history[3]['requestId'], history[1]['requestId']],
            'one_ms_before': 'waiting', 'at_unlock': 'open', 'after_advance_and_reload': 'open',
            'purchase_dialog_dismissed_without_movement': True, 'canceled_after_unlock': ['card', 'usdc']}


def corrupted_store(page, base):
    visit(page, base, 'customer')
    broken = '{unreadable-demo-state'
    page.evaluate('([key, value]) => localStorage.setItem(key, value)', [KEY, broken])
    page.reload(wait_until='load')
    panel = page.locator('.error-panel')
    expect(panel).to_be_visible()
    assert page.evaluate('(key) => localStorage.getItem(key)', KEY) == broken, 'Unreadable history overwritten'
    expect(page.locator('[data-action=complete], [data-action=cancel]')).to_have_count(0)
    title = panel.locator('h1').inner_text()
    panel.locator('[data-action=reset]').click()
    page.locator('[data-dismiss]').click()
    assert page.evaluate('(key) => localStorage.getItem(key)', KEY) == broken
    panel.locator('[data-action=reset]').click()
    page.locator('[data-confirm]').click()
    expect(page.locator('.order-list .order-btn')).to_have_count(3)
    assert len(actions(stored(page))) == 4
    return {'corrupt_data_preserved_until_confirmation': True, 'payments_unavailable_while_corrupt': True,
            'confirmed_reset_recovers_sample_orders': 3, 'message': title}


def report_interaction(page, base):
    visit(page, base, 'home')
    page.get_by_role('link', name='Explore the illustrated report').click()
    expect(page.locator('.r-cover h1')).to_contain_text('pause.')
    expect(page.locator('[data-net]')).to_have_text('−S$1.1700')
    page.get_by_role('combobox', name='Annual rate', exact=True).focus()
    page.get_by_role('combobox', name='Annual rate', exact=True).select_option('0')
    expect(page.locator('.r-gross b')).to_have_text('S$0.0000')
    expect(page.get_by_role('combobox', name='Annual rate', exact=True)).to_be_focused()
    page.get_by_role('combobox', name='Basket', exact=True).select_option('1000')
    page.get_by_role('combobox', name='Invested time', exact=True).select_option('30')
    page.get_by_role('combobox', name='Annual rate', exact=True).select_option('8')
    expect(page.locator('.r-gross b')).to_have_text('S$6.5753')
    expect(page.locator('.r-share b')).to_have_text('S$5.26')
    expect(page.locator('.r-active')).to_contain_text('30d')
    return {'default': '−S$1.1700', 'zero_rate': True, 'upper_case': 'S$6.5753'}


def stale_confirmation(page, base):
    snapshot = reserve(page, base, 'card')
    page.locator('[data-action=cancel]').click()
    expect(page.locator('dialog')).to_be_visible()
    page.go_back()
    expect(page.locator('#checkout-form')).to_be_visible()
    expect(page.locator('dialog')).not_to_be_visible()
    assert actions(stored(page)) == actions(snapshot)
    return {'back_closed_dialog': True, 'ledger_unchanged': True}


def reset_focus(page, base):
    visit(page, base, 'merchant')
    page.locator('[data-action=reset]').focus()
    page.keyboard.press('Enter')
    page.locator('[data-confirm]').click()
    expect(page.locator('#main')).to_be_focused()
    expect(page.locator('#rail-filter')).to_be_visible()
    return {'workspace_focus_restored': True}


def queued_checkout_navigation(page, base):
    visit(page, base, 'checkout')
    old_count = len(actions(stored(page)))
    page.evaluate("() => { window.testLockHeld = false; navigator.locks.request('delayedbuy.sandbox.v1', () => new Promise(r => { window.testRelease = r; window.testLockHeld = true; })); }")
    page.wait_for_function('window.testLockHeld === true')
    page.locator('#checkout-form button[type=submit]').click()
    page.locator('#primary-nav a[href="#merchant"]').click()
    expect(page.locator('#rail-filter')).to_be_visible()
    page.evaluate('() => window.testRelease()')
    page.wait_for_function("([k, n]) => JSON.parse(localStorage.getItem(k)).ledger.actions.length === n+1", arg=[KEY,old_count])
    expect(page.locator('#rail-filter')).to_be_visible()
    assert page.url.endswith('#merchant')
    expect(page.locator('[data-totals="card"] .big')).to_have_text('S$360.00')
    return {'exactly_one_new_hold': True, 'newer_route_preserved': True}


def hold_queue(page):
    page.evaluate("""key => new Promise(acquired => {
        navigator.locks.request(key, () => new Promise(resolve => {
            window.releaseQueue = resolve;
            acquired();
        }));
    })""", KEY)


def wait_for_pending(page, count):
    # Poll from the test process; the page's CSP also applies under the fixed clock.
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        pending = page.evaluate("""async key =>
            (await navigator.locks.query()).pending.filter(lock => lock.name === key).length""", KEY)
        if pending == count:
            return
        time.sleep(0.01)
    raise AssertionError(f'Expected {count} queued demo locks, found {pending}')


def clock_change_during_checkout(page, base):
    visit(page, base, 'checkout')
    option(page, 'days', '1')
    before = stored(page)
    unlock = before['now'] + DAY_MS
    checkout_answers(page, 'S$180.00', unlock)
    merchant = page.context.new_page()
    visit(merchant, base, 'merchant')
    hold_queue(merchant)
    merchant.locator('[data-action=advance]').click()
    wait_for_pending(page, 1)
    submit = page.get_by_role('button', name='Create demo hold')
    submit.click()
    wait_for_pending(page, 2)
    merchant.evaluate('() => window.releaseQueue()')
    expect(page.locator('#feedback')).to_contain_text('Review the new purchase time')
    checkout_answers(page, 'S$180.00', unlock + DAY_MS)
    assert actions(stored(page)) == actions(before)
    submit.click()
    expect(page.locator('#order-detail .status')).to_have_text('Waiting')
    final = actions(stored(page))
    assert final[:-1] == actions(before)
    opened = final[-1]
    assert (opened['type'], opened['at'], opened['holdMs']) == ('hold', before['now'] + DAY_MS, DAY_MS)
    saved_terms(page, opened, 'S$180.00')
    return {'earlier_preview_funded': False, 'new_preview_funded_once': True}


def reset_during_confirmation(page, base):
    visit(page, base, 'customer/ord_arc')
    before = stored(page)
    merchant = page.context.new_page()
    visit(merchant, base, 'merchant')

    # Model a reset in the same clock tick. The replacement has the same date and order URL.
    merchant.clock.set_fixed_time(datetime.fromtimestamp(before['now'] / 1000, timezone.utc))
    page.locator('[data-action=cancel]').click()
    merchant.locator('[data-action=reset]').click()

    # Queue the reset ahead of the already-reviewed decision using the real cross-tab lock.
    hold_queue(merchant)

    merchant.locator('[data-confirm]').click()
    wait_for_pending(page, 1)
    page.locator('[data-confirm]').click()
    wait_for_pending(page, 2)
    merchant.evaluate('() => window.releaseQueue()')

    expect(page.locator('#feedback')).to_contain_text('Review the current order')
    expect(page.locator('#order-detail .status')).to_have_text('Waiting')
    after = stored(page)
    def opening(snapshot):
        return next(a for a in actions(snapshot) if a['type'] == 'hold' and a['orderId'] == 'ord_arc')

    original, replacement = opening(before), opening(after)
    assert original['at'] == replacement['at']
    assert original['requestId'] != replacement['requestId']
    assert len(actions(after)) == len(actions(before))
    act(page, 'cancel')
    final = actions(stored(page))
    assert final[:-1] == actions(after)
    assert (final[-1]['type'], final[-1]['orderId']) == ('cancel', 'ord_arc')
    return {'replacement_stayed_open': True, 'new_confirmation_closed_it_once': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--standalone', type=Path, help='Also exercise the downloaded single HTML file.')
    parser.add_argument('--screenshots', type=Path, help='Optionally save mobile and desktop home screenshots in this directory.')
    args = parser.parse_args()
    if args.screenshots:
        args.screenshots.mkdir(exist_ok=True, parents=True)
    executable = os.environ.get('CHROMIUM_BIN') or shutil.which('chromium') or shutil.which('google-chrome')
    if not executable:
        raise SystemExit('Install Chromium or set CHROMIUM_BIN to its local executable.')
    standalone_path = args.standalone.resolve(strict=True) if args.standalone else None
    with static_site(standalone_path) as base, sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True,
                args=['--disable-background-networking', '--disable-component-update'])
        run = Run(browser, base)
        for rail in ('card', 'usdc'):
            for decision in ('cancel', 'complete'):
                run.case(f'{rail} reserve, {decision}, refresh', rail_flow(rail, decision))
        run.case('Merchant totals and event filters reconcile across rails', merchant_reconciliation)
        run.case('Paired merchant rehearsal', merchant_rehearsal)
        run.case('Keyboard navigation through checkout and confirmation', keyboard_flow)
        run.case('Saved v1.1 holds stay open across unlock and allow cancellation on both rails', saved_v11_decisions)
        run.case('Unreadable saved data is preserved with safe recovery options', corrupted_store)
        for w, h in [(320, 740), (390, 844), (768, 1024), (1280, 850)]:
            run.case(f'Route fit, labels and checkout fields at {w}px', partial(viewport_check, screenshots=args.screenshots), w, h, w < 600)
        run.case('Mobile hold setup, confirmation and Back', landing_to_hold, 390, 844, True)
        run.case('Keyboard scenario shortcut and offline CSV', report_shortcut)
        run.case('Mobile menu opens, navigates and closes', mobile_navigation, 390, 844, True)
        run.case('Scenario report thresholds and accessible controls', report_interaction)
        run.case('Back closes an obsolete confirmation', stale_confirmation)
        run.case('Reset preserves meaningful keyboard focus', reset_focus)
        run.case('Queued checkout respects newer navigation', queued_checkout_navigation)
        run.case('Queued checkout requires review if another tab changes the clock', clock_change_during_checkout)
        run.case('Another tab resets a hold before its queued confirmation', reset_during_confirmation)
        passed = sum(c['status'] == 'passed' for c in run.cases)
        report = {'executed_at_utc': datetime.now(timezone.utc).isoformat(),
                  'suite': 'Playwright local Chromium browser smoke checks', 'served_at': PREFIX,
                  'chromium': browser.version, 'playwright': version('playwright'),
                  'python': platform.python_version(), 'passed': passed, 'total': len(run.cases),
                  'snapshot_sha256': build_hashes(), 'unexpected_request_attempts': run.attempts,
                  'local_paths_requested': sorted(run.local_paths), 'cases': run.cases}
        if standalone_path:
            file_mode = Run(browser, standalone_path.as_uri())
            file_mode.case('Standalone HTML opened directly as file://', standalone_check)
            loopback = Run(browser, base + 'delayedbuy-demo.html')
            loopback.case('Identical standalone HTML served alone on loopback', standalone_check)
            loopback.case('Standalone hold with browser storage unavailable', standalone_without_storage)
            loopback.case('Standalone explanation without JavaScript', no_script_explanation, javascript=False)
            loopback.case('Standalone scenario shortcut and offline CSV', report_shortcut)
            report['standalone'] = {
                'file': standalone_path.name, 'sha256': hashlib.sha256(standalone_path.read_bytes()).hexdigest(),
                'unexpected_request_attempts': file_mode.attempts + loopback.attempts,
                'direct_file': file_mode.cases[0], 'loopback': loopback.cases[0],
                'without_storage': loopback.cases[1], 'without_javascript': loopback.cases[2],
                'scenario_download': loopback.cases[3]}
        browser.close()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'{passed}/{len(run.cases)} passed. Receipt: {OUTPUT}')
    if args.standalone:
        standalone = report['standalone']
        required = ('loopback', 'without_storage', 'without_javascript', 'scenario_download')
        if standalone['direct_file']['status'] == 'failed' or any(standalone[key]['status'] != 'passed' for key in required):
            return 1
    return 0 if passed == len(run.cases) else 1


def merchant_reconciliation(page, base):
    held = {'card': 180, 'usdc': 120}
    funded = {'card': 265, 'usdc': 120}
    paid = {'card': 85, 'usdc': 0}
    refunded = {'card': 0, 'usdc': 0}
    expected = {'card': 'S$180.00', 'usdc': '135.00 USDC'}
    order_ids = {}
    for rail, outcome in [('card', 'cancel'), ('usdc', 'complete')]:
        snapshot = reserve(page, base, rail)
        order_ids[rail] = actions(snapshot)[-1]['orderId']
        expect(page.locator('#order-detail dd.money')).to_have_text(expected[rail])
        if outcome == 'complete':
            clock_unlock(page)
        act(page, outcome)
        expect(page.locator('#order-detail .status')).to_have_text('Refunded' if outcome == 'cancel' else 'Completed')
    funded['card'] += 180
    funded['usdc'] += 135
    refunded['card'] += 180
    paid['usdc'] += 135
    visit(page, base, 'merchant')
    result = {}
    for rail, source in [('card', 'Demo card'), ('usdc', 'Demo wallet')]:
        section = page.locator(f'[data-totals="{rail}"]')
        labels = section.locator('.balance-mini div').all_text_contents()
        assert all(name in value for name, value in zip(('Gross funded', 'Paid to merchant', 'Returned to source'), labels, strict=True))
        values = section.locator('.big, .balance-mini b').all_text_contents()
        expected_values = [held[rail], funded[rail], paid[rail], refunded[rail]]
        numeric = [Decimal(re.search(r'[\d,]+(?:\.\d+)?', val).group().replace(',', '')) for val in values]
        assert numeric == expected_values and numeric[1] == numeric[0] + numeric[2] + numeric[3], values
        assert all(('S$' in val) if rail == 'card' else ('USDC' in val) for val in values), values
        page.locator('#rail-filter').select_option(rail)
        rows = page.locator('#ledger-rows tr')
        assert rows.count() == (5 if rail == 'card' else 3)
        for row in rows.all():
            assert ('S$' if rail == 'card' else 'USDC') in row.locator('td').last.inner_text()
        own = rows.filter(has_text=order_ids[rail])
        expect(own).to_have_count(2)
        assert any(f'{source} → Order hold' in t for t in own.all_text_contents())
        terminal = 'Order hold → Demo card' if rail == 'card' else 'Order hold → Demo merchant'
        assert any(terminal in t for t in own.all_text_contents())
        result[rail] = {'held': values[0], 'gross_funded': values[1], 'paid': values[2], 'refunded': values[3], 'movements': rows.count()}
    page.locator('#rail-filter').select_option('all')
    expect(page.locator('#ledger-rows tr')).to_have_count(8)
    return result


def merchant_rehearsal(page, base):
    day = 86_400_000
    entry = datetime(2026, 1, 12, 2, tzinfo=timezone.utc)  # 10:00 SGT
    start = int(entry.timestamp() * 1000)
    cutoff = start + 2 * day

    def timestamp(ms):
        return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()

    def card_totals():
        values = page.locator('[data-totals="card"] .big, [data-totals="card"] .balance-mini b').all_text_contents()
        assert all(value.startswith('S$') for value in values), values
        cents = [int(Decimal(value[2:].replace(',', '')) * 100) for value in values]
        return dict(zip(('held', 'funded', 'completed', 'refunded'), cents, strict=True))

    # Reset this isolated browser context through the UI to seed both paths at a repeatable time.
    visit(page, base, 'merchant')
    page.clock.set_fixed_time(entry)
    page.get_by_role('button', name='Reset demo data').click()
    page.get_by_role('dialog').get_by_role('button', name='Reset demo').click()
    expect(page.locator('#feedback')).to_contain_text('Sample orders and demo clock restored')
    seeded = stored(page)
    assert seeded['now'] == start
    baseline_totals = card_totals()
    shared = {'start': timestamp(start), 'cutoff': timestamp(cutoff),
              'item': 'Arc table lamp', 'amount_sgd_cents': 18_000}

    # Ordinary checkout exists only in this fixture. Entering never purchases the lamp.
    rows = []
    scripts = {'buy': 'confirm_purchase', 'decline': 'leave_checkout', 'leave': None}
    for case_id, decision in scripts.items():
        outcome = {'confirm_purchase': 'purchased', 'leave_checkout': 'declined', None: 'no_order'}[decision]
        rows.append({**shared, 'case_id': case_id, 'path': 'ordinary_scripted_reference',
                     'decision_at': timestamp(start) if decision else None, 'outcome': outcome,
                     'fixture_step': decision or 'observe_cutoff_without_return'})
    assert actions(stored(page)) == actions(seeded), 'Ordinary fixture moved demo funds'

    order_ids = {}
    for case_id in scripts:
        snapshot = reserve(page, base, 'card', days=1)
        opening = actions(snapshot)[-1]
        assert (opening['type'], opening['at'], opening['holdMs'], opening['item'],
                opening['rail'], opening['amount']) == ('hold', start, day, shared['item'], 'card', 18_000)
        order_ids[case_id] = opening['orderId']
        if case_id == 'decline':
            act(page, 'cancel')
    assert len(set(order_ids.values())) == 3
    visit(page, base, 'customer/' + order_ids['buy'])
    clock_unlock(page)
    act(page, 'complete')
    visit(page, base, 'merchant')
    page.locator('[data-action=advance]').click()
    expect(page.locator('#feedback')).to_contain_text('Demo clock advanced by one day')
    final = stored(page)
    assert final['now'] == cutoff
    history = actions(final)
    seed_count = len(actions(seeded))
    assert history[:seed_count] == actions(seeded)
    movements = history[seed_count:]
    assert len(movements) == 5
    expected = {
        'buy': [('hold', start), ('complete', start + day)],
        'decline': [('hold', start), ('cancel', start)],
        'leave': [('hold', start)],
    }
    for case_id, order_id in order_ids.items():
        events = [event for event in movements if event['orderId'] == order_id]
        assert [(event['type'], event['at']) for event in events] == expected[case_id], events
        last = events[-1]
        outcome = {'complete': 'purchased', 'cancel': 'refunded', 'hold': 'hold_open'}[last['type']]
        rows.append({**shared, 'case_id': case_id, 'path': 'delayedbuy',
                     'decision_at': None if outcome == 'hold_open' else timestamp(last['at']),
                     'outcome': outcome, 'order_id': order_id,
                     'ledger_request_ids': [event['requestId'] for event in events]})

    assert [(row['case_id'], row['outcome']) for row in rows] == [
        ('buy', 'purchased'), ('decline', 'declined'), ('leave', 'no_order'),
        ('buy', 'purchased'), ('decline', 'refunded'), ('leave', 'hold_open')]
    observed_totals = {key: value - baseline_totals[key] for key, value in card_totals().items()}
    assert observed_totals == {'held': 18_000, 'funded': 54_000, 'completed': 18_000, 'refunded': 18_000}
    assert observed_totals['funded'] == sum(observed_totals[key] for key in ('completed', 'refunded', 'held'))
    paths = {}
    for path in ('ordinary_scripted_reference', 'delayedbuy'):
        cohort = [row for row in rows if row['path'] == path]
        paths[path] = {'starts': len(cohort), 'purchases': sum(row['outcome'] == 'purchased' for row in cohort)}
        assert paths[path] == {'starts': 3, 'purchases': 1}
    return {'rows': rows, 'paths': paths, 'ordinary_ledger_movements': 0,
            'delayedbuy_ledger_movements': len(movements), 'delayedbuy_sgd_cents': observed_totals}


def no_script_explanation(page, base):
    expect(page.locator('main .boot-help p').first).to_be_visible()
    expect(page.locator('main')).to_contain_text('Enable JavaScript to choose a waiting period')
    expect(page.locator('main')).to_contain_text('The checkout simulation pays no interest')
    for term in ('sets aside demo funds and fixes your price', 'This demo reserves no stock.',
                 'no automatic expiry', 'Complete purchase, then Confirm purchase', 'cancel any time before buying'):
        expect(page.locator('main')).to_contain_text(term)
    expect(page.locator('main')).not_to_contain_text('Loading')
    expect(page.locator('#checkout-form')).to_have_count(0)
    return {'static_explanation_visible': True}


def standalone_without_storage(page, base):
    page.add_init_script("""for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(window, name, {get() { throw new DOMException('Storage unavailable', 'SecurityError'); }});
    }""")
    page.reload(wait_until='load')
    visit(page, base, 'checkout')
    option(page, 'rail', 'usdc')
    page.get_by_role('button', name='Create demo hold').click()
    expect(page.locator('#order-detail dd.money')).to_have_text('135.00 USDC')
    act(page, 'cancel')
    expect(page.locator('#order-detail .action-help')).to_contain_text('original demo wallet')
    return {'in_memory_hold_and_refund': True}


def standalone_check(page, base):
    expect(page.locator('.hero h1')).to_be_visible()
    image = page.locator('.hero .product-shot')
    expect(image).to_be_visible()
    page.wait_for_function('document.querySelector(".hero .product-shot").naturalWidth > 0')
    assert image.get_attribute('src').startswith('data:image/')
    expect(page.locator('.sim-badge')).to_have_text('Simulation')
    visit(page, base, 'checkout')
    checkout_answers(page, 'S$180.00', stored(page)['now'] + 2 * DAY_MS)
    outcome = rail_flow('card', 'cancel')(page, base)
    return {'location': urlsplit(base).scheme, 'embedded_image_decoded': True, 'hold_and_cancel': outcome}


if __name__ == '__main__':
    raise SystemExit(main())
