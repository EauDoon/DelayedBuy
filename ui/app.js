import { applyAction, demoLedger, getView, validateLedger } from '../core/ledger.mjs';
import { reportPage, reportResults } from './report.mjs';
import { mountReservation } from './reservation.mjs';
import { icon } from './icons.js';
import { mountLampStudio } from './lamp-studio.mjs';

const DAY = 86_400_000;
const LAMP_PHOTO = './ui/assets/arc-lamp.webp';
const STORE_KEY = 'delayedbuy.sandbox.v1';
const rails = {
  card: { label: 'Demo card', currency: 'SGD', source: 'card_demo', amount: 18_000 },
  usdc: { label: 'Demo wallet', currency: 'USDC', source: 'wallet_demo', amount: 135_000_000 }
};
const accountNames = { card_demo: 'Demo card', wallet_demo: 'Demo wallet', hold_demo: 'Order hold', merchant_demo: 'Demo merchant' };
const eventNames = { held: 'Hold funded', completed: 'Purchase completed', refunded: 'Principal returned' };
const reportChoice = { basket:100, days:7, apr:4 };
let navigationEpoch = 0;
const pageNames = { reservation: '24-hour reservation', report:'The price of a pause', home: 'Sleep on it.', how: 'How it works', checkout: 'Start a demo hold', customer: 'Customer view', merchant: 'Merchant view' };
const main = document.querySelector('#main');
const feedback = document.querySelector('#feedback');
const dialog = document.querySelector('#confirm-dialog');
const menu = document.querySelector('#primary-nav');
const menuButton = document.querySelector('.menu-button');
const stamp = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Singapore'
});
let database;
let storageOpenError;
let legacyStorage;
let tabStorage;
let notifications;
let state;
let loadError = false;
let busy = false;
let railFilter = 'all';
const waitingPeriods = [1, 2, 7];
let checkout = { rail: 'card', days: 2 };
let pending = null;
let feedbackTimer;
let fundedBoot;
let fundedReady = false;
let stopReservation;
let stopLampStudio;

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
  // Sample order URLs survive a reset, but each new opening gets its own receipt.
  return { version: 1, now, ledger: demoLedger(now, () => uniqueId('req_')) };
}
function availableStorage(name) {
  try {
    const target = window[name];
    const saved = target.getItem(STORE_KEY);
    if (name === 'sessionStorage' && saved == null) {
      const probe = STORE_KEY + '.probe';
      target.setItem(probe, '1');
      target.removeItem(probe);
    }
    return target;
  } catch { return null; }
}
async function openDatabase() {
  try {
    if (!window.indexedDB) return null;
    return await new Promise((resolve, reject) => {
      const request = window.indexedDB.open(STORE_KEY, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('simulation');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  } catch (error) {
    if (['SecurityError', 'InvalidStateError', 'NotAllowedError'].includes(error.name)) return null;
    throw error;
  }
}
function parseState(raw) {
  if (typeof raw !== 'string' || raw.length > 1_650_000) throw new Error('The saved demo data is invalid or too large.');
  const saved = JSON.parse(raw);
  if (saved?.version !== 1 || !Number.isSafeInteger(saved.now) || saved.now < 0 || saved.now > 8_640_000_000_000_000)
    throw new Error('The saved simulation clock is invalid.');
  validateLedger(saved.ledger);
  if (saved.ledger.actions.some(entry => entry.at > saved.now)) throw new Error('The saved clock precedes a recorded event.');
  return saved;
}
function snapshot(raw, change, reset) {
  const current = reset || raw === undefined ? initialState() : parseState(raw);
  const next = change ? change(current) : current;
  return { next, raw: !reset && raw !== undefined && next === current ? raw : JSON.stringify(next) };
}
function legacySnapshot() {
  return legacyStorage?.getItem(STORE_KEY) ?? undefined;
}
function transactState(change, reset) {
  // A Web Lock can order tabs while their localStorage caches still disagree.
  // Read the current receipt and write its successor in one IndexedDB transaction.
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('simulation', 'readwrite');
    const store = transaction.objectStore('simulation');
    const read = store.get('state');
    let result, changed, failed;
    read.onsuccess = () => {
      try {
        const previous = read.result;
        result = snapshot(previous === undefined && !reset ? legacySnapshot() : previous, change, reset);
        changed = result.raw !== previous;
        if (changed) store.put(result.raw, 'state');
      } catch (error) {
        failed = error;
        transaction.abort();
      }
    };
    transaction.onabort = () => reject(failed ?? transaction.error);
    transaction.oncomplete = () => {
      state = result.next;
      if (changed) {
        try {
          if (notifications) notifications.postMessage(null);
          else legacyStorage?.setItem(STORE_KEY + '.changed', uniqueId('req_'));
        } catch { /* An unavailable notification channel does not undo the commit. */ }
      }
      resolve();
    };
  });
}
function updateState(change, reset = false) {
  const update = () => {
    if (storageOpenError) throw storageOpenError;
    if (database) return transactState(change, reset);
    // Restricted browsers keep mutations tab-local. A v1.1 save can still be opened.
    const previous = tabStorage ? tabStorage.getItem(STORE_KEY) : state && JSON.stringify(state);
    const result = snapshot(previous ?? (reset ? undefined : legacySnapshot()), change, reset);
    if (result.raw !== previous) tabStorage?.setItem(STORE_KEY, result.raw);
    state = result.next;
  };
  return navigator.locks ? navigator.locks.request(STORE_KEY, update) : update();
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
    '<img class="product-shot" src="' + LAMP_PHOTO + '" width="1254" height="1254" alt="A vermilion mushroom-shaped table lamp on a lilac studio floor" fetchpriority="high">' +
    '<span class="photo-label">' + icon('box', 12) + ' Demo item</span>' +
    '<div class="product-caption"><strong>Arc table lamp</strong><span class="caption-right"><small>' +
    money(rail, rails[rail].amount) + '</small>' + end + '</span></div></' + tag + '>';
}
function homePage() {
  const options = waitingPeriods.map(days => '<option value="' + days + '"' + (checkout.days === days ? ' selected' : '') + '>' +
    days + (days === 1 ? ' day' : ' days') + '</option>').join('');
  return `<div class="pause-home">
    <section class="frame hero pause-hero" aria-labelledby="pause-title">
      <div class="pause-intro">
        <p class="pause-eyeline"><span class="pause-mark" aria-hidden="true"></span>The pause study <span>/</span> No. 01</p>
        <h1 id="pause-title">Sleep <br><em>on it.</em></h1>
        <p class="pause-deck">Like the lamp? Ask for a day to decide. If the simulated merchant accepts, they hold the lamp at the agreed price for up to 24 hours.</p>
        <a class="pause-cta" href="#reservation">Try the 24-hour reservation ${icon('arrow',19)}</a>
        <p class="pause-small">S$0 due. No purchase. Fictional item.</p>
      </div>
      <figure class="studio-figure">
        <div class="studio-stage">
          <img class="product-shot" src="${LAMP_PHOTO}" width="1254" height="1254" alt="The fictional Arc table lamp, with a glossy orange dome and flared base, in a lilac studio." fetchpriority="high">
          <canvas class="studio-canvas" aria-hidden="true" hidden></canvas>
          <span class="studio-folio" aria-hidden="true">FIG. 01&nbsp; / &nbsp;OBJECT STUDY</span>
          <button type="button" class="studio-turn" hidden>${icon('refund',15)} Rotate view</button>
        </div>
        <figcaption><div><span class="pause-meta">The object</span><strong>Arc table lamp</strong></div>
        <div><span class="pause-meta">Starting offer</span><strong>S$180</strong></div></figcaption>
      </figure>
    </section>
    <section class="pause-how" id="how" tabindex="-1" aria-labelledby="pause-how-title"><div class="frame">
      <div class="pause-section-top"><span class="pause-eyeline">01 <span>/</span> The reservation</span><span class="pause-meta">One lamp. No deposit.</span></div>
      <h2 id="pause-how-title">When does the clock start?</h2>
      <ol class="pause-steps">
        <li><span class="step-symbol" aria-hidden="true">${icon('lamp',24)}</span><h3>Request the lamp.</h3><p>A request costs nothing. It doesn’t set the lamp aside yet.</p></li>
        <li><span class="step-symbol" aria-hidden="true">${icon('clock',24)}</span><h3>Wait for a yes.</h3><p>Only the merchant’s acceptance holds the unit, fixes the price and starts the 24-hour clock.</p></li>
        <li><span class="step-symbol" aria-hidden="true">${icon('refund',24)}</span><h3>Decide in your time.</h3><p>Return, cancel or let the hold expire. Each releases the lamp. Returning records a decision, not a sale.</p></li>
      </ol>
    </div></section>
    <section class="pause-lab"><div class="frame">
      <div class="pause-section-top"><span class="pause-eyeline">02 <span>/</span> The comparison</span><span class="pause-meta">Separate simulation</span></div>
      <div class="pause-lab-grid"><div><h2>What if you paid first?</h2>
        <p>The earlier checkout sets aside demo funds, not stock. After the wait you can confirm a purchase. Cancel before buying and the full amount returns to the original demo card or wallet.</p>
        <div class="pause-links"><a href="#report">Explore the illustrated report ${icon('diagonal',15)}</a><a href="#merchant">Open merchant view ${icon('diagonal',15)}</a></div>
      </div><div class="pause-slip"><div class="slip-head"><span class="pause-meta">Demo-funded checkout</span>${icon('card',20)}</div>
        <a class="slip-product" href="#checkout" aria-label="Try checkout with the Arc table lamp">Arc table lamp ${icon('diagonal',15)}</a>
        <div class="hero-setup"><label for="preview-days">Waiting period</label><div class="hero-buttons">
        <select id="preview-days">${options}</select><a class="btn black" href="#checkout">Set up my hold ${icon('arrow',16)}</a></div></div>
      </div></div>
    </div></section></div>`;
}
function backLink() { return '<a href="#home" class="backlink">' + icon('back', 15) + ' Back to home</a>'; }
function checkoutTerms() {
  if (checkout.rail === 'usdc') return 'A fictitious wallet supplies demo USDC. Canceling returns the same units to that wallet. No blockchain transaction occurs.';
  return 'A simulated card payment funds this hold in SGD. Canceling returns the full principal to the original demo card.';
}
function checkoutPage() {
  const selected = checkout.rail;
  const unlockAt = state.now + checkout.days * DAY;
  const option = (rail, symbol, title) => '<label class="choice"><input type="radio" name="rail" value="' + rail + '"' + (rail === selected ? ' checked' : '') +
    '><span>' + icon(symbol, 17) + title + '<i class="pick"></i></span></label>';
  const days = waitingPeriods.map(n => '<label class="choice"><input type="radio" name="days" value="' + n + '"' +
    (n === checkout.days ? ' checked' : '') + '><span>' + (n === 1 ? '1 day' : n + ' days') + '</span></label>').join('');
  return '<div class="frame workspace">' + backLink() + '<div class="kicker">Demo-funded checkout</div><h1>Start a demo hold.</h1>' +
    '<p class="intro">Choose how to fund the demo hold and when the option to buy opens.</p>' +
    '<div class="checkout-grid" id="checkout-grid">' + productFigure(false, selected) +
    '<form class="checkout-form" id="checkout-form"><fieldset aria-describedby="rail-help"><legend>Payment method</legend><div class="choices">' +
    option('card', 'card', 'SGD card') + option('usdc', 'coin', 'USDC wallet') + '</div>' +
    '<p class="help" id="rail-help">' + checkoutTerms() + '</p></fieldset>' +
    '<fieldset><legend>Waiting period</legend><div class="choices durations">' + days + '</div></fieldset>' +
    '<div class="summary-lines" id="checkout-terms">' +
    '<div class="summary-line"><div><b>Is one set aside for me?</b><p>This demo reserves no stock.</p></div></div>' +
    '<div class="summary-line"><div><b>Can my price change?</b><p>Your demo price stays <strong id="checkout-total">' + money(selected, rails[selected].amount) + '</strong> until you buy or cancel.</p></div></div>' +
    '<div class="summary-line"><div><b>When does the hold expire?</b><p>No automatic expiry. You can buy from <time id="checkout-unlock" datetime="' + new Date(unlockAt).toISOString() + '">' + showDate(unlockAt) + ' SGT</time> or cancel any time before buying.</p></div></div>' +
    '<div class="summary-line"><div><b>When do I commit?</b><p>Creating the hold sets aside demo funds. After the wait, choose <strong>Complete purchase</strong>, then <strong>Confirm purchase</strong> to buy.</p></div></div></div>' +
    '<button type="submit" class="btn orange full" aria-describedby="checkout-terms">Create demo hold ' + icon('arrow', 17) + '</button>' +
    '<p class="payment-note">' + icon('lock', 14) + ' Card and wallet use separate demo prices. This hold earns no interest.</p></form></div></div>';
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
    const unlock = order.eligible ? '' : '<button data-action="unlock" class="plain-button">Skip the remaining demo wait</button>';
    const daysLeft = Math.max(0, Math.ceil((order.unlockAt - state.now) / DAY));
    const help = order.eligible ? 'Your waiting period has ended.' : daysLeft + (daysLeft === 1 ? ' day' : ' days') + ' left on the demo clock.';
    actions = '<p class="action-help">This demo reserves no stock. Your demo price stays fixed until you buy or cancel. No automatic expiry.</p>' +
      '<p class="action-help">' + help + ' After the wait, choose <strong>Complete purchase</strong>, then <strong>Confirm purchase</strong> to buy. You can cancel any time before buying.</p>' +
      unlock + '<div class="action-row"><button class="btn orange" data-action="complete"' +
      (order.eligible ? '' : ' disabled') + '>Complete purchase ' + icon('check', 16) + '</button><button class="btn outline" data-action="cancel">Cancel hold ' + icon('refund', 15) + '</button></div>';
  } else {
    actions = '<p class="action-help">' + (order.status === 'completed' ? 'The demo merchant received the principal for this purchase.' :
      'The full principal returned to the original ' + rails[order.rail].label.toLowerCase() + '.') + '</p>';
  }
  return '<section class="panel detail-panel" id="order-detail" data-order="' + escapeHtml(order.id) + '" aria-label="Selected order">' +
    statusBadge(order) + '<h2 class="detail-title">' + escapeHtml(order.item) + '</h2><p class="detail-sub">Order ' + escapeHtml(order.id) + '</p>' +
    '<dl class="details-grid"><div><dt>Fixed demo price</dt><dd class="money">' + money(order.rail, order.amount) +
    '</dd></div><div><dt>Original source</dt><dd>' + rails[order.rail].label +
    '</dd></div><div><dt>Hold opened · SGT</dt><dd>' + showDate(order.createdAt) +
    '</dd></div><div><dt>Earliest purchase · SGT</dt><dd><time datetime="' + new Date(order.unlockAt).toISOString() + '">' + showDate(order.unlockAt) + '</time></dd></div></dl>' +
    actions + '<div class="timeline"><h3>Order history</h3><ol>' +
    order.events.map(event => '<li><span>' + eventNames[event.type] + '</span><time datetime="' + new Date(event.at).toISOString() + '">' + showDate(event.at) + ' SGT</time></li>').join('') +
    '</ol></div></section>';
}
function customerPage(orders, selected, missing) {
  return '<div class="frame workspace">' + backLink() + '<div class="dash-heading"><div><div class="kicker">Demo-funded checkout / Customer</div><h1>Your holds.</h1>' +
    '<p class="intro">Check your waiting period and decide what happens to each order.</p></div>' + clockPanel() +
    '</div><div class="customer-grid">' + orderList(orders, selected) + orderDetails(selected, missing) + '</div>' + resetRow() + '</div>';
}
function balanceCard(rail, totals) {
  const amount = number => money(rail, number);
  const funded = totals.held + totals.completed + totals.refunded;
  return '<section class="balance-card ' + rail + '" data-totals="' + rail + '"><h2>' + icon(rail === 'card' ? 'card' : 'coin', 19) +
    (rail === 'card' ? 'SGD card ledger' : 'USDC wallet ledger') + '</h2><div class="big">' + amount(totals.held) + '</div><p class="money-label held-key">Currently held for customers</p>' +
    '<div class="balance-track" aria-hidden="true"><span class="held" style="flex-grow:' + totals.held + '"></span>' +
    '<span class="paid" style="flex-grow:' + totals.completed + '"></span><span class="returned" style="flex-grow:' + totals.refunded + '"></span></div>' +
    '<div class="balance-mini"><div>Gross funded<b>' + amount(funded) + '</b></div><div class="paid-key">Paid to merchant<b>' +
    amount(totals.completed) + '</b></div><div class="returned-key">Returned to source<b>' + amount(totals.refunded) + '</b></div></div></section>';
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
  return '<div class="frame workspace">' + backLink() + '<div class="dash-heading"><div><div class="kicker">Demo-funded checkout / Merchant</div><h1>Merchant ledger.</h1>' +
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
  stopLampStudio?.();
  stopLampStudio = undefined;
  document.title = 'delayedbuy · ' + pageNames[page];
  for (const link of menu.querySelectorAll('a')) {
    if (link.hash === '#' + page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (page === 'reservation') {
    if (!stopReservation) stopReservation = mountReservation(main, announce);
    return;
  }
  leaveReservation();
  if (page === 'report') { main.innerHTML = reportPage(reportChoice.basket, reportChoice.days, reportChoice.apr); return; }
  if (loadError) {
    main.innerHTML = '<div class="frame workspace"><section class="panel error-panel"><div class="kicker">Simulation</div><h1>Saved demo unavailable.</h1><p>The browser could not read the saved simulation. Reset the sample data to start again.</p>' + resetRow() + '</section></div>';
    return;
  }
  if (page === 'home' || page === 'how') {
    main.innerHTML = homePage();
    stopLampStudio = mountLampStudio(main);
  }
  else if (page === 'checkout') main.innerHTML = checkoutPage();
  else {
    const view = getView(state.ledger, state.now);
    const selected = id ? view.orders.find(o => o.id === id) : view.orders[0];
    main.innerHTML = page === 'customer' ? customerPage(view.orders, selected, Boolean(id && !selected)) : merchantPage(view);
  }
}
function leaveReservation() {
  if (stopReservation) {
    stopReservation();
    stopReservation = undefined;
  }
}
function closeMenu() {
  menu.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Open menu');
}
function focusOrder() {
  const detail = document.querySelector('#order-detail');
  if (!detail) return;
  detail.tabIndex = -1;
  detail.focus({ preventScroll: true });
  if (window.matchMedia('(max-width: 640px)').matches) detail.scrollIntoView({ block: 'start' });
}
function onRouteChange() {
  navigationEpoch++;
  pending = null;
  if (dialog.open) dialog.close();
  closeMenu();
  displayRoute(false);
}
async function displayRoute(initial) {
  const epoch = navigationEpoch;
  if (route().page !== 'reservation') {
    if (stopReservation) {
      leaveReservation();
      main.replaceChildren();
    }
    if (!fundedReady) {
      fundedBoot ??= loadFundedState();
      await fundedBoot;
      if (epoch !== navigationEpoch) return;
    }
  }
  render();
  if (initial) {
    if (route().page === 'how') document.querySelector('#how')?.scrollIntoView();
    if (route().page === 'customer' && route().id) focusOrder();
  } else if (route().page === 'how' && !loadError) {
    document.querySelector('#how').focus({ preventScroll: true });
    document.querySelector('#how').scrollIntoView();
  } else if (route().page === 'customer' && route().id && document.querySelector('#order-detail')) {
    focusOrder();
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
  pending = { action, id, opening: order?.events[0] };
  dialog.innerHTML = '<div class="dialog-box"><div class="kicker">Simulation</div><h2 id="dialog-title">' + config[0] + '</h2><p id="dialog-description">' + escapeHtml(config[1]) +
    '</p><div class="action-row"><button type="button" class="btn outline" data-dismiss autofocus>Go back</button><button type="button" class="btn orange" data-confirm>' + config[2] + '</button></div></div>';
  dialog.showModal();
}
async function perform(action, id, opening) {
  if (busy) return;
  busy = true;
  try {
    if (action === 'reset') {
      await updateState(null, true);
      loadError = false;
      railFilter = 'all';
      checkout = { rail: 'card', days: 2 };
      if (route().page === 'customer' && route().id) location.hash = '#customer';
      render();
      main.focus({ preventScroll:true });
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
      await updateState(current => {
        const hold = current.ledger.actions.find(entry => entry.type === 'hold' && entry.orderId === id);
        if (!hold || hold.requestId !== opening.requestId || hold.at !== opening.at) {
          state = current;
          render();
          throw new Error('This hold changed. Review the current order before confirming again.');
        }
        return { ...current, ledger: applyAction(current.ledger, { type: action, requestId, orderId: id, at: current.now }) };
      });
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
  if (event.target.closest('[data-explore-report]')) {
    document.querySelector('#r-basket').focus();
    return;
  }
  const select = event.target.closest('[data-select]');
  if (select) { location.hash = '#customer/' + select.dataset.select; return; }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled || busy) return;
  const action = button.dataset.action;
  if (['reset','cancel','complete'].includes(action)) ask(action);
  else if (['advance','unlock'].includes(action)) perform(action, document.querySelector('#order-detail')?.dataset.order);
});
main.addEventListener('change', event => {
  if (event.target.id === 'preview-days') {
    const days = Number(event.target.value);
    if (waitingPeriods.includes(days)) checkout.days = days;
    return;
  }
  if (event.target.matches('select[data-report]')) {
    const values = {basket:[25,100,250,1000], days:[1,7,14,30], apr:[0,2,4,8]};
    const key = event.target.dataset.report, value = Number(event.target.value);
    if (Object.hasOwn(values,key) && values[key].includes(value)) {
      reportChoice[key] = value;
      document.querySelector('#r-results').innerHTML = reportResults(reportChoice.basket, reportChoice.days, reportChoice.apr);
    }
    return;
  }
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
  const unlockAt = state.now + checkout.days * DAY;
  const unlock = document.querySelector('#checkout-unlock');
  unlock.dateTime = new Date(unlockAt).toISOString();
  unlock.textContent = showDate(unlockAt) + ' SGT';
});
main.addEventListener('submit', async event => {
  if (event.target.id !== 'checkout-form') return;
  event.preventDefault();
  if (busy) return;
  busy = true;
  const submittedAt = navigationEpoch;
  const submit = event.target.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const orderId = uniqueId('ord_');
    const requestId = uniqueId('req_');
    const { rail, days } = checkout;
    const reviewedAt = state.now;
    await updateState(current => {
      if (current.now !== reviewedAt) {
        state = current;
        render();
        if (submittedAt === navigationEpoch && route().page === 'checkout') {
          document.querySelector('#checkout-form [type="submit"]').focus();
        }
        throw new Error('The demo clock changed. Review the new purchase time before creating your hold.');
      }
      return {
        ...current, ledger: applyAction(current.ledger, {
          type: 'hold', requestId, orderId, item: 'Arc table lamp', rail, amount: rails[rail].amount,
          source: rails[rail].source, at: current.now, holdMs: days * DAY
        })
      };
    });
    if (submittedAt === navigationEpoch && route().page === 'checkout') location.hash = '#customer/' + orderId;
    else if (['merchant','customer'].includes(route().page)) render();
    announce('Demo hold created. Your price is fixed and your demo funds are held.');
  } catch (error) {
    submit.disabled = false;
    showError(error);
  } finally { busy = false; }
});
dialog.addEventListener('click', event => {
  if (event.target.closest('[data-dismiss]')) { pending = null; dialog.close(); return; }
  if (event.target.closest('[data-confirm]') && pending) {
    const {action, id, opening} = pending;
    pending = null;
    dialog.close();
    perform(action, id, opening);
  }
});
dialog.addEventListener('close', () => { if (!dialog.open) pending = null; });
menuButton.addEventListener('click', () => {
  const open = menu.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
});
menu.addEventListener('click', event => {
  closeMenu();
  if (event.target.closest('a')?.hash === location.hash) main.focus({ preventScroll: true });
});
document.querySelector('.site-header').addEventListener('focusout', event => {
  if (!event.currentTarget.contains(event.relatedTarget)) closeMenu();
});
document.querySelector('.skip').addEventListener('click', event => {
  event.preventDefault();
  main.focus({ preventScroll: true });
  main.scrollIntoView({ block: 'start' });
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.classList.contains('open')) { closeMenu(); menuButton.focus(); } });
async function refreshSharedState() {
  let changed = loadError;
  try {
    await updateState(current => {
      changed = changed || JSON.stringify(current) !== JSON.stringify(state);
      return current;
    });
    if (!changed) return;
    loadError = false;
  }
  catch { loadError = true; }
  const wasReviewing = dialog.open;
  if (wasReviewing) dialog.close();
  render();
  if (wasReviewing) {
    const detail = document.querySelector('#order-detail');
    if (detail) focusOrder();
    else main.focus({ preventScroll: true });
  }
}
async function loadFundedState() {
  legacyStorage = availableStorage('localStorage');
  tabStorage = availableStorage('sessionStorage');
  // A sessionStorage save belongs to this tab, including an existing v1.1 order.
  try { if (tabStorage?.getItem(STORE_KEY) == null) database = await openDatabase(); }
  catch (error) { storageOpenError = error; }
  if (database) {
    try { notifications = new BroadcastChannel(STORE_KEY); } catch { /* Use storage events where available. */ }
    if (notifications) notifications.onmessage = refreshSharedState;
    else {
      window.addEventListener('storage', event => {
        if (event.key === STORE_KEY + '.changed') refreshSharedState();
      });
      window.addEventListener('focus', refreshSharedState);
    }
  }
  try { await updateState(); }
  catch { loadError = true; }
  fundedReady = true;
}
window.addEventListener('hashchange', onRouteChange);
displayRoute(true);
