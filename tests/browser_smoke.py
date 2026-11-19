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
    dialog.locator('[data-confirm]').click()
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
    submit = page.locator('#checkout-form button[type=submit]')
    for _ in range(25):
        page.keyboard.press('Tab')
        if submit.evaluate('(el) => document.activeElement === el'):
            break
    expect(submit).to_be_focused()
    page.keyboard.press('Enter')
    cancel = page.locator('[data-action=cancel]')
    expect(cancel).to_be_visible()
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
    return {'first_tab': 'Skip to content', 'submit': 'Enter', 'dismiss_dialog': 'Escape', 'focus_restored': True}


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
    merchant.evaluate("""key => {
        navigator.locks.request(key, () => new Promise(resolve => { window.releaseQueue = resolve; }));
    }""", KEY)
    merchant.wait_for_function("typeof window.releaseQueue === 'function'")
    pending_count = """async ([key, n]) =>
        (await navigator.locks.query()).pending.filter(lock => lock.name === key).length === n"""
    merchant.locator('[data-confirm]').click()
    page.wait_for_function(pending_count, arg=[KEY, 1])
    page.locator('[data-confirm]').click()
    page.wait_for_function(pending_count, arg=[KEY, 2])
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


def review_viewports(browser):
    """Capture this revision's synthetic screens on the runner for the branch review."""
    import base64
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory(prefix='delayedbuy-design-', dir='/tmp') as temporary:
        checkout = Path(temporary) / 'checkout'
        subprocess.run(['git', 'clone', '--quiet', '--no-hardlinks', str(ROOT), str(checkout)], check=True)
        url = (checkout / 'docs' / 'index.html').as_uri()
        for width, height in [(390, 844), (1280, 850)]:
            context = browser.new_context(viewport={'width': width, 'height': height},
                                          timezone_id='Asia/Singapore', device_scale_factor=1)
            page = context.new_page()
            for route in ('home', 'how', 'checkout', 'customer', 'selected', 'dialog', 'merchant', 'report', 'scenarios', 'comparison'):
                target = {'selected': 'customer/ord_arc', 'dialog': 'customer/ord_arc', 'scenarios': 'report', 'comparison': 'report'}.get(route, route)
                page.goto(url + '#' + target)
                expect(page.locator('main h1')).to_be_visible()
                expect(page.locator('main .boot')).to_have_count(0)
                page.evaluate('() => Promise.all(Array.from(document.images, img => img.decode()))')
                if route == 'how':
                    page.locator('#how').evaluate("el => el.scrollIntoView()")
                elif route == 'selected':
                    expect(page.locator('#order-detail')).to_be_focused()
                elif route == 'dialog':
                    page.locator('[data-action=cancel]').click()
                elif route in ('scenarios', 'comparison'):
                    selector = '.r-controls-head' if route == 'scenarios' else '.r-comparison'
                    page.locator(selector).evaluate("el => el.scrollIntoView()")
                encoded = base64.b64encode(page.screenshot()).decode()
                stamp = page.evaluate('''async ({encoded, width}) => {
                  const img = new Image();
                  img.src = 'data:image/png;base64,' + encoded;
                  await img.decode();
                  const canvas = document.createElement('canvas');
                  canvas.width = Math.min(width, 960);
                  canvas.height = Math.round(img.height * canvas.width / img.width);
                  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                  return canvas.toDataURL('image/webp', .68).split(',')[1];
                }''', {'encoded': encoded, 'width': width})
                for offset in range(0, len(stamp), 3000):
                    print(f'VISUAL {width} {route} {offset} {stamp[offset:offset + 3000]}', flush=True)
            context.close()


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
        review_viewports(browser)
        run = Run(browser, base)
        for rail in ('card', 'usdc'):
            for decision in ('cancel', 'complete'):
                run.case(f'{rail} reserve, {decision}, refresh', rail_flow(rail, decision))
        run.case('Merchant totals and event filters reconcile across rails', merchant_reconciliation)
        run.case('Keyboard navigation through checkout and confirmation', keyboard_flow)
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
            report['standalone'] = {
                'file': standalone_path.name, 'sha256': hashlib.sha256(standalone_path.read_bytes()).hexdigest(),
                'unexpected_request_attempts': file_mode.attempts + loopback.attempts,
                'direct_file': file_mode.cases[0], 'loopback': loopback.cases[0],
                'without_storage': loopback.cases[1], 'without_javascript': loopback.cases[2]}
        browser.close()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'{passed}/{len(run.cases)} passed. Receipt: {OUTPUT}')
    if args.standalone:
        standalone = report['standalone']
        required = ('loopback', 'without_storage', 'without_javascript')
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


def no_script_explanation(page, base):
    expect(page.locator('main')).to_contain_text('Enable JavaScript to choose a waiting period')
    expect(page.locator('main')).to_contain_text('The checkout simulation pays no interest')
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
    outcome = rail_flow('card', 'cancel')(page, base)
    return {'location': urlsplit(base).scheme, 'embedded_image_decoded': True, 'hold_and_cancel': outcome}


if __name__ == '__main__':
    raise SystemExit(main())
