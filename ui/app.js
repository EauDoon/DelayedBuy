import { applyAction, demoLedger, getView, validateLedger } from '../core/ledger.mjs';
import { icon } from './icons.js';

const DAY = 86_400_000;
const STORE_KEY = 'delayedbuy.sandbox.v1';
const rails = {
  card: { label: 'Demo card', currency: 'SGD', source: 'card_demo', amount: 18_000 },
  usdc: { label: 'Demo wallet', currency: 'USDC', source: 'wallet_demo', amount: 135_000_000 }
};
const accountNames = { card_demo: 'Demo card', wallet_demo: 'Demo wallet', hold_demo: 'Order hold', merchant_demo: 'Demo merchant' };
const eventNames = { held: 'Hold funded', completed: 'Purchase completed', refunded: 'Principal returned' };
const pageNames = { home: 'Reserve now. Decide later.', how: 'How it works', checkout: 'Demo checkout', customer: 'Customer view', merchant: 'Merchant view' };
const main = document.querySelector('#main');
const feedback = document.querySelector('#feedback');
const dialog = document.querySelector('#confirm-dialog');
const menu = document.querySelector('#primary-nav');
const menuButton = document.querySelector('.menu-button');
const stamp = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Singapore'
});
let storage;
let shared = false;
let state;
let loadError = false;
let busy = false;
let railFilter = 'all';
let checkout = { rail: 'card', days: 2 };
let pending = null;
let feedbackTimer;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function showDate(value) {
  const parts = Object.fromEntries(stamp.formatToParts(value).map(part => [part.type, part.value]));
  return parts.day + '-' + parts.month + '-' + parts.year + ' · ' + parts.hour + ':' + parts.minute;
}
function money(rail, units) {
  const precise = rail === 'usdc';
  const digits = precise ? 6 : 2;
  const scale = 10 ** digits;
  const whole = Math.floor(units / scale).toLocaleString('en-SG');
  const remainder = String(units % scale).padStart(digits, '0');
  const fraction = precise ? remainder.slice(0, 2) + remainder.slice(2).replace(/0+$/, '') : remainder;
  return precise ? whole + '.' + fraction + ' USDC' : 'S$' + whole + '.' + fraction;
}
function initialState() {
  const now = Date.now();
  return { version: 1, now, ledger: demoLedger(now) };
}
function findStorage() {
  // Without a cross-tab lock, keep each tab's simulation independent.
  const candidates = navigator.locks ? ['localStorage', 'sessionStorage'] : ['sessionStorage'];
  for (const name of candidates) {
    try {
      const target = window[name];
      const probe = STORE_KEY + '.probe';
      target.setItem(probe, '1');
      target.removeItem(probe);
      storage = target;
      shared = name === 'localStorage';
      return;
    } catch { /* Restricted browsers can still run an in-memory simulation. */ }
  }
}
function readState() {
  const raw = storage?.getItem(STORE_KEY);
  if (raw == null) return storage ? null : state;
  if (raw.length > 1_650_000) throw new Error('The saved demo is too large to read.');
  const saved = JSON.parse(raw);
  if (saved?.version !== 1 || !Number.isSafeInteger(saved.now) || saved.now < 0 || saved.now > 8_640_000_000_000_000)
    throw new Error('The saved simulation clock is invalid.');
  validateLedger(saved.ledger);
  if (saved.ledger.actions.some(entry => entry.at > saved.now)) throw new Error('The saved clock precedes a recorded event.');
  return saved;
}
function saveState(next) {
  if (storage) storage.setItem(STORE_KEY, JSON.stringify(next));
  state = next;
}
async function locked(callback) {
  return shared ? navigator.locks.request(STORE_KEY, callback) : callback();
}
async function updateState(change) {
  return locked(() => {
    const current = readState() ?? initialState();
    const next = change(current);
    saveState(next);
  });
}
function uniqueId(prefix) {
  if (globalThis.crypto?.randomUUID) return prefix + crypto.randomUUID();
  const random = new Uint32Array(4);
  crypto.getRandomValues(random);
  return prefix + Array.from(random, n => n.toString(16).padStart(8, '0')).join('');
}
function route() {
  const [name, id] = location.hash.slice(1).split('/');
  return { page: name && Object.hasOwn(pageNames, name) ? name : 'home', id };
}
function statusOf(order) {
  if (order.eligible) return { key: 'ready', label: 'Ready to decide' };
  return { key: order.status, label: ({ holding: 'Waiting', completed: 'Completed', refunded: 'Refunded' })[order.status] };
}
function statusBadge(order) {
  const status = statusOf(order);
  return '<span class="status ' + status.key + '"><i></i>' + status.label + '</span>';
}
function announce(text) {
  clearTimeout(feedbackTimer);
  feedback.innerHTML = '';
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = text;
  feedback.append(toast);
  feedbackTimer = setTimeout(() => feedback.replaceChildren(), 5000);
}
function productFigure(link = false, rail = 'card') {
  const tag = link ? 'a' : 'figure';
  const end = link ? '<span class="round-icon">' + icon('diagonal', 14) + '</span>' : '';
  return '<' + tag + (link ? ' href="#checkout" aria-label="Try checkout with the Arc table lamp"' : '') + ' class="product-figure">' +
    '<img class="product-shot" src="./ui/assets/arc-lamp.webp" width="1254" height="1254" alt="A vermilion mushroom-shaped table lamp on a lilac studio floor" fetchpriority="high">' +
    '<span class="photo-label">' + icon('box', 12) + ' Demo item</span>' +
    '<div class="product-caption"><strong>Arc table lamp</strong><span class="caption-right"><small>' +
    money(rail, rails[rail].amount) + '</small>' + end + '</span></div></' + tag + '>';
}
function homePage() {
  const steps = [
    ['box', 'Reserve an item', 'Choose a demo payment method and how long you want to wait. The full price goes into the simulated hold.'],
    ['hourglass', 'Give it time', 'The item stays reserved through your waiting period. You can change your mind and cancel at any point while it is on hold.'],
    ['split', 'Make the call', 'Once the wait ends, complete the purchase to pay the demo merchant, or cancel to return the principal to its original source.']
  ];
  return '<section class="frame hero"><div class="hero-copy"><div class="eyebrow kicker">Delayed checkout</div>' +
    '<h1>Reserve now.<br><em>Decide later.</em></h1>' +
    '<p>Hold the item you want, give yourself time to think, then choose whether to buy it.</p>' +
    '<div class="hero-buttons"><a class="btn orange" href="#checkout">Try demo checkout ' + icon('arrow', 18) + '</a>' +
    '<a class="text-link" href="#how">How it works ' + icon('down', 15) + '</a></div>' +
    '<div class="hero-note">' + icon('lock', 14) + ' No sign-up. No real payments.</div></div>' +
    productFigure(true) + '</section>' +
    '<section class="how-section" id="how" tabindex="-1"><div class="frame"><div class="section-head"><h2>How it works</h2>' +
    '<p>You stay in control of the final purchase.</p></div><div class="steps">' +
    steps.map(([symbol, title, copy], i) => '<article class="step"><div class="step-top"><span class="step-icon">' + icon(symbol, 22) + '</span><span class="micro">Step 0' + (i + 1) + '</span></div><h3>' + title + '</h3><p>' + copy + '</p></article>').join('') +
    '</div></div></section>' +
    '<section class="showcase"><div class="frame show-grid"><div><span class="kicker">Merchant view</span><h2>Follow the money.</h2><p>See each hold, completed purchase, and refund in the demo ledger.</p></div><a class="btn outline" href="#merchant">Open merchant view ' +
    icon('arrow', 17) + '</a></div></section>';
}
function backLink() { return '<a href="#home" class="backlink">' + icon('back', 15) + ' Back to home</a>'; }
function checkoutTerms() {
  if (checkout.rail === 'usdc') return 'A fictitious wallet supplies demo USDC. Canceling returns the same units to that wallet. No blockchain transaction occurs.';
  return 'A simulated card payment funds this hold in SGD. Canceling returns the full principal to the original demo card.';
}
function checkoutPage() {
  const selected = checkout.rail;
  const option = (rail, symbol, title) => '<label class="choice"><input type="radio" name="rail" value="' + rail + '"' + (rail === selected ? ' checked' : '') +
    '><span>' + icon(symbol, 17) + title + '<i class="pick"></i></span></label>';
  const days = [1,2,7].map(n => '<label class="choice"><input type="radio" name="days" value="' + n + '"' +
    (n === checkout.days ? ' checked' : '') + '><span>' + (n === 1 ? '1 day' : n + ' days') + '</span></label>').join('');
  return '<div class="frame workspace">' + backLink() + '<div class="kicker">Simulation / Checkout</div><h1>Reserve your item.</h1>' +
    '<p class="intro">Choose a payment method and a waiting period. You make the final purchase decision later.</p>' +
    '<div class="checkout-grid" id="checkout-grid">' + productFigure(false, selected) +
    '<form class="checkout-form" id="checkout-form"><fieldset aria-describedby="rail-help"><legend>Payment method</legend><div class="choices">' +
    option('card', 'card', 'SGD card') + option('usdc', 'coin', 'USDC wallet') + '</div>' +
    '<p class="help" id="rail-help">' + checkoutTerms() + '</p></fieldset>' +
    '<fieldset><legend>Waiting period</legend><div class="choices durations">' + days + '</div><p class="help">The timer opens the option to buy. It never completes a purchase automatically.</p></fieldset>' +
    '<div class="summary-lines"><div class="summary-line"><span>Earliest completion</span><strong id="checkout-unlock">' + showDate(state.now + checkout.days * DAY) + ' SGT</strong></div>' +
    '<div class="summary-line"><span>Customer yield</span><strong>None</strong></div><div class="summary-line total"><span>Amount held</span><strong id="checkout-total">' + money(selected, rails[selected].amount) + '</strong></div></div>' +
    '<button type="submit" class="btn orange full">Reserve item ' + icon('arrow', 17) + '</button>' +
    '<p class="payment-note">' + icon('lock', 14) + ' Simulation only. Demo prices are set independently for each payment method.</p></form></div></div>';
}
function clockPanel() {
  return '<section class="clock-panel" aria-label="Simulation clock"><div class="clock-label">' + icon('clock', 20) +
    '<div><strong>Demo clock</strong><small>' + showDate(state.now) + ' SGT</small></div></div><button type="button" data-action="advance">' +
    icon('fast', 14) + ' +1 day</button></section>';
}
function resetRow() { return '<div class="reset-row"><button class="plain-button" data-action="reset">Reset demo data</button></div>'; }
function itemIcon(item) {
  if (item === 'Arc table lamp') return ['lamp', 'lamp'];
  if (item === 'Studio headphones') return ['audio', 'audio'];
  if (item === 'Canvas daypack') return ['bag', 'bag'];
  return ['box', ''];
}
function orderList(orders, selected) {
  return '<section class="panel"><div class="pane-head"><h2>Your orders</h2><span class="micro">' + orders.length + (orders.length === 1 ? ' order' : ' orders') +
    '</span></div><div class="order-list" aria-label="Select an order">' +
    (orders.length ? orders.map(order => {
      const [symbol, color] = itemIcon(order.item);
      return '<button type="button" class="order-btn" data-select="' + escapeHtml(order.id) + '" aria-pressed="' + (order.id === selected?.id) +
        '"><span class="item-dot ' + color + '">' + icon(symbol, 21) + '</span><span class="order-copy"><strong>' + escapeHtml(order.item) +
        '</strong><small>' + money(order.rail, order.amount) + ' · ' + statusOf(order).label + '</small></span>' + icon('diagonal', 13) + '</button>';
    }).join('') : '<p class="empty">Your first hold will appear here.</p>') +
    '</div><div class="list-end"><a class="text-link" href="#checkout">Start a new hold ' + icon('arrow', 14) + '</a></div></section>';
}
function orderDetails(order, missing) {
  if (missing) return '<section class="panel"><h2>Order unavailable</h2><p class="help">This order is missing from this browser’s simulation. Select a saved order or start a new hold.</p></section>';
  if (!order) return '<section class="panel"><h2>Order details</h2><p class="help">Choose a hold to see its payment and history.</p></section>';
  const isOpen = order.status === 'holding';
  let actions = '';
  if (isOpen) {
    const unlock = order.eligible ? '' : '<button data-action="unlock" class="plain-button">Advance to end of wait</button>';
    const help = order.eligible ? 'Your waiting period has ended. Choose what happens to this hold.' : 'Completion opens ' + showDate(order.unlockAt) + ' SGT. You can cancel now.';
    actions = '<p class="action-help">' + help + '</p>' + unlock + '<div class="action-row"><button class="btn orange" data-action="complete"' +
      (order.eligible ? '' : ' disabled') + '>Complete purchase ' + icon('check', 16) + '</button><button class="btn outline" data-action="cancel">Cancel hold ' + icon('refund', 15) + '</button></div>';
  } else {
    actions = '<p class="action-help">' + (order.status === 'completed' ? 'The demo merchant received the principal for this purchase.' :
      'The full principal returned to the original ' + rails[order.rail].label.toLowerCase() + '.') + '</p>';
  }
  return '<section class="panel detail-panel" id="order-detail" data-order="' + escapeHtml(order.id) + '" aria-label="Selected order">' +
    statusBadge(order) + '<h2 class="detail-title">' + escapeHtml(order.item) + '</h2><p class="detail-sub">Order ' + escapeHtml(order.id) + '</p>' +
    '<dl class="details-grid"><div><dt>Principal</dt><dd class="money">' + money(order.rail, order.amount) +
    '</dd></div><div><dt>Original source</dt><dd>' + rails[order.rail].label +
    '</dd></div><div><dt>Hold opened · SGT</dt><dd>' + showDate(order.createdAt) +
    '</dd></div><div><dt>Earliest completion · SGT</dt><dd>' + showDate(order.unlockAt) + '</dd></div></dl>' +
    actions + '<div class="timeline"><h3>Order history</h3><ol>' +
    order.events.map(event => '<li><span>' + eventNames[event.type] + '</span><time datetime="' + new Date(event.at).toISOString() + '">' + showDate(event.at) + ' SGT</time></li>').join('') +
    '</ol></div></section>';
}
function customerPage(orders, selected, missing) {
  return '<div class="frame workspace">' + backLink() + '<div class="dash-heading"><div><div class="kicker">Simulation / Customer</div><h1>Your holds.</h1>' +
    '<p class="intro">Check your waiting period and decide what happens to each order.</p></div>' + clockPanel() +
    '</div><div class="customer-grid">' + orderList(orders, selected) + orderDetails(selected, missing) + '</div>' + resetRow() + '</div>';
}
function balanceCard(rail, totals) {
  const amount = number => money(rail, number);
  const funded = totals.held + totals.completed + totals.refunded;
  return '<section class="balance-card ' + rail + '" data-totals="' + rail + '"><h2>' + icon(rail === 'card' ? 'card' : 'coin', 19) +
    (rail === 'card' ? 'SGD card ledger' : 'USDC wallet ledger') + '</h2><div class="big">' + amount(totals.held) + '</div><p class="money-label">Currently held for customers</p>' +
    '<div class="balance-mini"><div>Gross funded<b>' + amount(funded) + '</b></div><div>Paid to merchant<b>' +
    amount(totals.completed) + '</b></div><div>Returned to source<b>' + amount(totals.refunded) + '</b></div></div></section>';
}
function ledgerRows(view) {
  const entries = view.orders.flatMap(order => order.events.map((event, index) => ({ order, event, index })))
    .filter(({ order }) => railFilter === 'all' || order.rail === railFilter)
    .sort((a, b) => b.event.at - a.event.at || b.index - a.index);
  if (!entries.length) return '<tr><td colspan="5" class="empty">No movements for this payment method yet.</td></tr>';
  return entries.map(({ order, event }) => '<tr><td>' + showDate(event.at) + '</td><td><strong>' + escapeHtml(order.item) + '</strong><small>' +
    escapeHtml(order.id) + '</small></td><td class="event-name">' + eventNames[event.type] + '</td><td>' + accountNames[event.from] + ' → ' +
    accountNames[event.to] + '</td><td>' + money(order.rail, event.amount) + '</td></tr>').join('');
}
function merchantPage(view) {
  return '<div class="frame workspace">' + backLink() + '<div class="dash-heading"><div><div class="kicker">Simulation / Merchant</div><h1>Merchant ledger.</h1>' +
    '<p class="intro">Reconcile reserved principal, completed sales, and refunds by payment method.</p></div>' + clockPanel() +
    '</div><div class="totals">' + balanceCard('card', view.totals.card) + balanceCard('usdc', view.totals.usdc) +
    '</div><section class="panel"><div class="pane-head"><h2>Payment movements</h2><label class="ledger-select">Show <select id="rail-filter">' +
    [['all','All methods'],['card','SGD card'],['usdc','USDC wallet']].map(([key, label]) => '<option value="' + key + '"' + (key === railFilter ? ' selected' : '') + '>' + label + '</option>').join('') +
    '</select></label></div><div class="ledger-scroll" role="region" aria-label="Payment movements table, scroll horizontally as needed" tabindex="0"><table><thead><tr><th scope="col">Time · SGT</th>' +
    '<th scope="col">Order</th><th scope="col">Movement</th><th scope="col">From → to</th><th scope="col">Principal</th></tr></thead><tbody id="ledger-rows">' + ledgerRows(view) +
    '</tbody></table></div><p class="table-note">Each ledger balances independently. Gross funded equals currently held plus paid to merchant plus returned to source. All movements are simulated.</p></section>' + resetRow() + '</div>';
}
function render() {
  const {page, id} = route();
  document.title = 'delayedbuy · ' + pageNames[page];
  for (const link of menu.querySelectorAll('a')) {
    if (link.hash === '#' + page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (loadError) {
    main.innerHTML = '<div class="frame workspace"><section class="panel error-panel"><div class="kicker">Simulation</div><h1>Saved demo unavailable.</h1><p>The browser could not read the saved simulation. Reset the sample data to start again.</p>' + resetRow() + '</section></div>';
    return;
  }
  if (page === 'home' || page === 'how') main.innerHTML = homePage();
  else if (page === 'checkout') main.innerHTML = checkoutPage();
  else {
    const view = getView(state.ledger, state.now);
    const selected = id ? view.orders.find(o => o.id === id) : view.orders[0];
    main.innerHTML = page === 'customer' ? customerPage(view.orders, selected, Boolean(id && !selected)) : merchantPage(view);
  }
}
function closeMenu() {
  menu.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Open menu');
}
function onRouteChange(event) {
  closeMenu();
  render();
  if (route().page === 'how' && !loadError) {
    document.querySelector('#how').focus({ preventScroll: true });
    document.querySelector('#how').scrollIntoView();
  } else if (route().page === 'customer' && new URL(event.oldURL).hash.startsWith('#customer') && document.querySelector('#order-detail')) {
    const detail = document.querySelector('#order-detail');
    detail.tabIndex = -1;
    detail.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 640px)').matches) detail.scrollIntoView({ block: 'start' });
  } else {
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }
}
function ask(action) {
  const id = document.querySelector('#order-detail')?.dataset.order;
  const order = state && getView(state.ledger, state.now).orders.find(entry => entry.id === id);
  if (action !== 'reset' && !order) return;
  const amount = order && money(order.rail, order.amount);
  const isCancel = action === 'cancel';
  const config = action === 'reset'
    ? ['Reset this demo?', 'This replaces the saved orders and simulation clock with the original examples.', 'Reset demo']
    : isCancel ? ['Cancel this hold?', 'Return ' + amount + ' for ' + order.item + ' to the original ' + rails[order.rail].label.toLowerCase() + '.', 'Confirm cancellation']
    : ['Complete this purchase?', 'Release ' + amount + ' for ' + order.item + ' to the demo merchant and close this hold.', 'Confirm purchase'];
  pending = { action, id };
  dialog.innerHTML = '<div class="dialog-box"><div class="kicker">Simulation</div><h2 id="dialog-title">' + config[0] + '</h2><p>' + escapeHtml(config[1]) +
    '</p><div class="action-row"><button type="button" class="btn outline" data-dismiss autofocus>Go back</button><button type="button" class="btn orange" data-confirm>' + config[2] + '</button></div></div>';
  dialog.showModal();
}
async function perform(action, id) {
  if (busy) return;
  busy = true;
  try {
    if (action === 'reset') {
      await locked(() => saveState(initialState()));
      loadError = false;
      railFilter = 'all';
      checkout = { rail: 'card', days: 2 };
      if (route().page === 'customer' && route().id) location.hash = '#customer';
      render();
      announce('Sample orders and demo clock restored.');
    } else if (action === 'advance' || action === 'unlock') {
      await updateState(current => {
        if (action === 'advance') {
          if (current.now > 8_640_000_000_000_000 - 8 * DAY) throw new Error('The demo clock has reached its limit.');
          return { ...current, now: current.now + DAY };
        }
        const order = getView(current.ledger, current.now).orders.find(entry => entry.id === id);
        if (!order || order.status !== 'holding') throw new Error('This hold is already closed or unavailable.');
        return { ...current, now: Math.max(current.now, order.unlockAt) };
      });
      render();
      announce(action === 'advance' ? 'Demo clock advanced by one day.' : 'Waiting period complete. You can now decide.');
      document.querySelector(action === 'advance' ? '[data-action="advance"]' : '[data-action="complete"]')?.focus({ preventScroll: true });
    } else {
      const requestId = uniqueId('req_');
      await updateState(current => ({ ...current, ledger: applyAction(current.ledger, { type: action, requestId, orderId: id, at: current.now }) }));
      render();
      announce(action === 'cancel' ? 'Hold canceled. Principal returned to its original source.' : 'Purchase completed. Principal paid to the demo merchant.');
      const detail = document.querySelector('#order-detail');
      if (detail) { detail.tabIndex = -1; detail.focus({ preventScroll: true }); }
    }
  } catch (error) { showError(error); }
  finally { busy = false; }
}
function showError(error) {
  announce(error?.name === 'QuotaExceededError' ? 'The browser has no room to save this change.' : (error?.message || 'The change could not be saved.'));
}
main.addEventListener('click', event => {
  const select = event.target.closest('[data-select]');
  if (select) { location.hash = '#customer/' + select.dataset.select; return; }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled || busy) return;
  const action = button.dataset.action;
  if (['reset','cancel','complete'].includes(action)) ask(action);
  else if (['advance','unlock'].includes(action)) perform(action, document.querySelector('#order-detail')?.dataset.order);
});
main.addEventListener('change', event => {
  if (event.target.id === 'rail-filter') {
    railFilter = event.target.value;
    document.querySelector('#ledger-rows').innerHTML = ledgerRows(getView(state.ledger, state.now));
    return;
  }
  if (!event.target.closest('#checkout-form')) return;
  if (event.target.name === 'rail') checkout.rail = event.target.value;
  if (event.target.name === 'days') checkout.days = Number(event.target.value);
  document.querySelector('#rail-help').textContent = checkoutTerms();
  const amount = money(checkout.rail, rails[checkout.rail].amount);
  document.querySelector('#checkout-total').textContent = amount;
  document.querySelector('.product-caption small').textContent = amount;
  document.querySelector('#checkout-unlock').textContent = showDate(state.now + checkout.days * DAY) + ' SGT';
});
main.addEventListener('submit', async event => {
  if (event.target.id !== 'checkout-form') return;
  event.preventDefault();
  if (busy) return;
  busy = true;
  const submit = event.target.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const orderId = uniqueId('ord_');
    const requestId = uniqueId('req_');
    const { rail, days } = checkout;
    await updateState(current => ({
      ...current, ledger: applyAction(current.ledger, {
        type: 'hold', requestId, orderId, item: 'Arc table lamp', rail, amount: rails[rail].amount,
        source: rails[rail].source, at: current.now, holdMs: days * DAY
      })
    }));
    location.hash = '#customer/' + orderId;
    announce('Demo item reserved. Your hold is open.');
  } catch (error) {
    submit.disabled = false;
    showError(error);
  } finally { busy = false; }
});
dialog.addEventListener('click', event => {
  if (event.target.closest('[data-dismiss]')) dialog.close();
  if (event.target.closest('[data-confirm]') && pending) {
    const {action, id} = pending;
    dialog.close();
    perform(action, id);
  }
});
dialog.addEventListener('close', () => { pending = null; });
menuButton.addEventListener('click', () => {
  const open = menu.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
});
menu.addEventListener('click', closeMenu);
document.querySelector('.skip').addEventListener('click', event => {
  event.preventDefault();
  main.focus({ preventScroll: true });
  main.scrollIntoView({ block: 'start' });
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.classList.contains('open')) { closeMenu(); menuButton.focus(); } });
window.addEventListener('hashchange', onRouteChange);
window.addEventListener('storage', event => {
  if (!shared || (event.key !== STORE_KEY && event.key !== null)) return;
  try { state = readState() ?? initialState(); loadError = false; }
  catch { loadError = true; }
  if (dialog.open) dialog.close();
  render();
});
async function boot() {
  findStorage();
  try { await locked(() => { const current = readState(); if (current) state = current; else saveState(initialState()); }); }
  catch { loadError = true; }
  render();
  if (route().page === 'how') document.querySelector('#how')?.scrollIntoView();
}
boot();
