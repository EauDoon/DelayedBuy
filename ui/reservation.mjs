import { readReservation, changeReservation, restartReservation, archivedReservations, subscribeReservation, reservationStorageMode } from './reservation-store.mjs';
import { icon } from './icons.js';

const sgt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Singapore', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
const labels = {
  pending: 'Awaiting review', active: 'Reserved', withdrawn: 'Request withdrawn', declined: 'Request declined',
  cancelled: 'Reservation cancelled', released: 'Merchant released unit', returned: 'Shopper returned', expired: 'Expired'
};
const metricLabels = {
  requests: 'Requests', accepted: 'Accepted', declined: 'Declined', withdrawn: 'Withdrawn',
  returns: 'Shopper returns', cancellations: 'Cancellations', releases: 'Merchant releases', expiries: 'Expiries',
  timeHeldMs: 'Unit-time held'
};
const money = cents => 'S$' + (cents / 100).toFixed(2);

function timeTag(at, attribute = '') {
  return '<time ' + attribute + ' datetime="' + new Date(at).toISOString() + '">' + sgt.format(at) + ' SGT</time>';
}
function duration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (ms > 0 && seconds === 0) return 'Under 1 sec';
  if (seconds < 60) return seconds + ' sec';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' min ' + seconds % 60 + ' sec';
  return Math.floor(minutes / 60) + ' hr ' + minutes % 60 + ' min';
}
function decisionButton(type, label, request, disabled = false) {
  return '<button type="button" class="btn ' + (type === 'accept' ? 'orange' : 'outline') + '" id="res-' + type + '-' + request.id +
    '" data-res-action="' + type + '" data-request-id="' + request.id + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
}
function badge(request) {
  return '<span class="res-badge res-' + request.status + '">' + labels[request.status] + '</span>';
}
function requestFacts(request) {
  return '<p class="res-facts">Arc table lamp · 1 unit · ' + (request.acceptedAt === null ? 'Requested price ' : 'Fixed price ') +
    '<strong>' + money(request.priceCents) + '</strong></p>' +
    '<p class="res-date">Requested ' + timeTag(request.requestedAt) + '.</p>' +
    (request.acceptedAt === null ? '' : '<p class="res-date">Accepted ' + timeTag(request.acceptedAt) +
      '. ' + (request.status === 'active' ? 'Expires ' : 'Original expiry ') + timeTag(request.expiresAt, 'data-res-expiry') + '.</p>') +
    (request.closedAt === null ? '' : '<p class="res-date">' + labels[request.status] + ' ' + timeTag(request.closedAt) + '.</p>');
}
function shopperCard(shopper, view) {
  const request = view.requests.findLast(r => r.shopper === shopper);
  const open = request && (request.status === 'pending' || request.status === 'active');
  let actions;
  if (request?.status === 'pending') {
    actions = (request.priceCents === view.priceCents ? '<p>Waiting for the merchant. This request holds no stock.</p>' :
      '<p>The current offer is ' + money(view.priceCents) + '. Withdraw this request to request the new price.</p>') +
      decisionButton('withdraw', 'Withdraw request', request);
  } else if (request?.status === 'active') {
    actions = '<p>One unit is held at your fixed price. Recording a return visit releases the unit. No sale is recorded.</p>' +
      '<div class="action-row">' + decisionButton('return', 'Record shopper return', request) + decisionButton('cancel', 'Cancel reservation', request) + '</div>';
  } else {
    actions = '<button type="button" class="btn outline" id="res-request-' + shopper + '" data-res-action="request" data-shopper="' +
      shopper + '" data-price="' + view.priceCents + '"' + (view.history.canRequest ? '' : ' disabled') + '>Request as Shopper ' + shopper + '</button>';
  }
  return '<article class="res-card"' + (request ? ' data-request-id="' + request.id + '" data-status="' + request.status + '"' : '') +
    '><div class="res-card-head"><h3 tabindex="-1" id="res-shopper-' + shopper + '">Shopper ' + shopper + '</h3>' + (request ? badge(request) : '') + '</div>' +
    (request ? requestFacts(request) : '') + (request && !open && request.status === 'returned' ? '<p>The return visit released the unit. No sale was recorded.</p>' : '') + actions + '</article>';
}
function reviewCard(request, view) {
  let controls;
  if (request.status === 'active') {
    controls = decisionButton('release', 'Release unit', request);
  } else {
    const repriced = request.priceCents !== view.priceCents;
    const reason = repriced ? 'The requested price is ' + money(request.priceCents) + '. The current offer is ' + money(view.priceCents) +
      '. Decline this request or have the shopper withdraw and request the new price.' :
      view.available === 0 ? 'The only unit is already reserved. You can review this request when it becomes available.' : '';
    controls = (reason ? '<p class="res-reason">' + reason + '</p>' : '') +
      '<div class="action-row">' + decisionButton('accept', 'Accept request', request, repriced || view.available === 0) +
      decisionButton('decline', 'Decline request', request) + '</div>';
  }
  return '<article class="res-card" data-request-id="' + request.id + '" data-status="' + request.status +
    '"><div class="res-card-head"><h3 tabindex="-1" id="res-review-' + request.id + '">Shopper ' + request.shopper + '</h3>' + badge(request) +
    '</div>' + requestFacts(request) + controls + '</article>';
}
function evidence(view) {
  const cells = Object.entries(metricLabels).map(([key, label]) =>
    '<div><dt>' + label + '</dt><dd data-res-metric="' + key + '" data-value="' + view.metrics[key] + '">' +
    (key === 'timeHeldMs' ? duration(view.metrics[key]) : view.metrics[key]) + '</dd></div>').join('');
  const rows = [...view.requests].reverse().map(r =>
    '<tr data-request-id="' + r.id + '" data-status="' + r.status + '"><th scope="row">Shopper ' + r.shopper + '</th><td>' + timeTag(r.requestedAt) +
    '</td><td>' + money(r.priceCents) + '</td><td>' + labels[r.status] + '</td><td>' +
    (r.acceptedAt === null ? '—' : duration((r.closedAt ?? view.now) - r.acceptedAt)) + '</td></tr>').join('');
  return '<section class="res-evidence panel" aria-labelledby="res-evidence-title"><h2 id="res-evidence-title">Rehearsal results</h2>' +
    '<p>Counts cover the two fictional shoppers in this browser. Unit-time runs from acceptance until the unit is released or expires. A return counts a visit. No payments or sales are recorded.</p>' +
    '<p><strong>' + view.metrics.returns + ' of ' + view.metrics.accepted + ' accepted reservations</strong> ended with a shopper return. ' +
    view.requests.filter(r => r.status === 'pending').length + ' pending · ' + (1 - view.available) + ' active.</p>' +
    '<dl class="res-metrics">' + cells + '</dl>' + (rows ? '<details id="res-history"><summary id="res-history-toggle">Request history</summary>' +
    '<div class="res-table-wrap" role="region" aria-label="Request history table" tabindex="0" id="res-history-table"><table><thead><tr><th scope="col">Shopper</th>' +
    '<th scope="col">Requested · SGT</th><th scope="col">Requested price</th><th scope="col">Outcome</th><th scope="col">Unit-time</th></tr></thead><tbody>' +
    rows + '</tbody></table></div></details>' : '') + '</section>';
}
function historyControls(view, persistence) {
  if (view.history.canRequest && !view.archiveCount) return '';
  const unavailable = view.history.canRequest ? '' :
    '<p>No room for another request in this rehearsal (' + view.history.used + ' of ' + view.history.limit +
    ' events recorded; space is also reserved to close open requests).</p>' +
    (view.history.canRestart ? '<p>Start again with a fresh offer and clock. Your prior reservation history stays in an archive' +
      (persistence === 'memory' ? ' until you reload or close this page' : '') + '.</p>' +
      '<button type="button" class="btn outline" id="res-restart" data-res-action="restart">Start a new rehearsal</button>' :
      '<p>Finish the open requests or reservations before you can start again.</p>');
  return '<section class="panel res-evidence" aria-labelledby="res-history-title"><h2 id="res-history-title" tabindex="-1">Rehearsal history</h2>' +
    unavailable + (view.archiveCount ? '<p>Archived rehearsals: ' + view.archiveCount + '.</p>' +
      '<button type="button" class="btn outline" id="res-export" data-res-action="archive">Download archived histories (JSON)</button>' : '') + '</section>';
}

async function downloadArchives() {
  const archives = await archivedReservations();
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, archives }, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'delayedbuy-reservation-archives.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function workspace(view) {
  const open = view.requests.filter(request => request.status === 'pending' || request.status === 'active');
  const persistence = reservationStorageMode();
  return '<a href="#home" class="backlink">' + icon('back', 15) + ' Back to home</a>' +
    '<div class="dash-heading"><div><div class="kicker">Simulation / Merchant reservation</div><h1>Request a reservation.</h1>' +
    '<p class="intro">Play the demo merchant and two shoppers reserving one fictional lamp. This rehearsal creates no real merchant agreement.</p></div>' +
    '<section class="clock-panel res-clock" aria-label="Reservation clock"><div class="clock-label">' + icon('clock', 20) +
    '<div><strong>Reservation clock</strong>' + timeTag(view.now, 'data-res-clock') + '</div></div><div class="res-clock-buttons">' +
    [1, 24].map(hours => '<button type="button" id="res-advance-' + hours + '" data-res-action="advance" data-hours="' +
      hours + '"' + (view.history.advanceHours.includes(hours) ? '' : ' disabled') + '>+' + hours +
      (hours === 1 ? ' hour' : ' hours') + '</button>').join('') + '</div></section></div>' +
    historyControls(view, persistence) +
    '<section class="res-offer" aria-labelledby="res-offer-title"><img alt="Vermilion Arc table lamp" src="./ui/assets/arc-lamp.webp" width="1254" height="1254">' +
    '<div><h2 id="res-offer-title">Arc table lamp</h2><div class="res-offer-line"><strong data-res-offer>' + money(view.priceCents) +
    '</strong><span data-res-available>' + view.available + ' of 1 available</span></div>' +
    '<p>A request sets aside no stock. Merchant acceptance reserves one lamp and fixes its price until the reservation ends. ' +
    'It expires automatically 24 hours from acceptance. A shopper cancellation, a recorded return visit or a merchant release can end it sooner. ' +
    'No payment is taken and no sale is recorded.</p></div></section>' +
    '<div class="res-columns"><section id="reservation-shopper" class="panel" aria-labelledby="res-shopper-title">' +
    '<h2 id="res-shopper-title" tabindex="-1">Shopper requests</h2><p>Choose a shopper to submit a request at the current offer. You can withdraw it before acceptance.</p>' +
    shopperCard('A', view) + shopperCard('B', view) + '</section>' +
    '<section id="reservation-merchant" class="panel" aria-labelledby="res-merchant-title"><h2 id="res-merchant-title" tabindex="-1">Merchant review</h2>' +
    '<label class="res-price-control" for="res-price">Price for new requests<select id="res-price" data-res-action="price"' +
    (view.history.canReprice ? '' : ' disabled') + '>' +
    [18000, 20000].map(price => '<option value="' + price + '"' + (view.priceCents === price ? ' selected' : '') + '>' + money(price) + '</option>').join('') +
    '</select></label><p>Accept or decline each pending request. Changing the offer preserves the fixed price of an accepted reservation.</p>' +
    (open.length ? [...open].reverse().map(request => reviewCard(request, view)).join('') : '<p class="res-empty">No requests to review.</p>') +
    '</section></div>' + evidence(view) +
    (persistence === 'shared' ? '' : '<p class="help">' + (persistence === 'memory' ? 'This rehearsal uses memory. Reloading clears it.' : 'This rehearsal is saved in this tab only.') + '</p>');
}
const messages = {
  request: 'Request sent for merchant review. No unit is held yet.', accept: 'Reservation accepted. One unit is held for 24 hours.',
  decline: 'Request declined.', withdraw: 'Request withdrawn.', cancel: 'Reservation cancelled. The unit is available.',
  release: 'The merchant released the unit.', return: 'Shopper return recorded. The unit is available. No sale was recorded.',
  advance: 'Reservation clock advanced.', price: 'Offer price updated for new requests.',
  restart: 'New reservation rehearsal started. The previous history was archived.'
};

export function mountReservation(main, announce) {
  const root = document.createElement('div');
  root.className = 'frame workspace reservation-page';
  main.replaceChildren(root);
  root.innerHTML = '<h1>Request a reservation.</h1><p role="status">Opening the reservation rehearsal…</p>';
  let attached = true, writing = false, needsRefresh = false, sequence = 0, timer, signature, displayed;
  const current = () => attached && root.isConnected && location.hash.slice(1).split('/')[0] === 'reservation';

  function show(view) {
    displayed = view;
    const nextSignature = JSON.stringify([view.priceCents, view.available, view.requests, view.history, view.archiveCount]);
    if (nextSignature !== signature) {
      const focus = root.contains(document.activeElement) ? document.activeElement : null;
      const fallback = focus?.closest('.res-card')?.querySelector('h3')?.id ?? focus?.closest('section')?.querySelector('h2')?.id;
      const focusId = focus?.id;
      const historyOpen = root.querySelector('#res-history')?.open;
      root.innerHTML = workspace(view);
      signature = nextSignature;
      const history = root.querySelector('#res-history');
      if (history && historyOpen) history.open = true;
      if (focusId) {
        const same = document.getElementById(focusId);
        const target = same && !same.disabled ? same : document.getElementById(fallback) ?? root.querySelector('#res-merchant-title');
        target?.focus({ preventScroll: true });
      }
    } else {
      const clock = root.querySelector('[data-res-clock]');
      clock.dateTime = new Date(view.now).toISOString();
      clock.textContent = sgt.format(view.now) + ' SGT';
      const held = root.querySelector('[data-res-metric="timeHeldMs"]');
      held.dataset.value = view.metrics.timeHeldMs;
      held.textContent = duration(view.metrics.timeHeldMs);
      const active = view.requests.find(r => r.status === 'active');
      const logTime = root.querySelector('#res-history tr[data-status="active"] td:last-child');
      if (logTime && active) logTime.textContent = duration(view.now - active.acceptedAt);
    }
    clearTimeout(timer);
    const active = view.requests.find(r => r.status === 'active');
    const nextTick = 60_000 - view.now % 60_000;
    timer = setTimeout(refresh, active ? Math.min(nextTick, Math.max(1, active.expiresAt - view.now)) : nextTick);
  }
  function unavailable() {
    clearTimeout(timer);
    signature = undefined;
    root.innerHTML = '<h1>Reservation unavailable.</h1><p>The saved reservation rehearsal could not be read.</p>' +
      '<button class="btn outline" type="button" data-res-action="retry">Try again</button>';
  }
  async function refresh() {
    if (!current()) return;
    if (writing) { needsRefresh = true; return; }
    const ticket = ++sequence;
    try {
      const view = await readReservation();
      if (current() && ticket === sequence) show(view);
    } catch {
      if (current() && ticket === sequence) unavailable();
    }
  }
  async function decide(event) {
    const control = event.target.closest('[data-res-action]');
    if (!control || control.disabled || !current() || writing) return;
    const type = control.dataset.resAction;
    if ((type === 'price') !== (event.type === 'change')) return;
    if (type === 'retry') { refresh(); return; }
    if (type === 'archive') {
      try { await downloadArchives(); }
      catch { if (current()) announce('The archived reservation histories could not be downloaded.'); }
      return;
    }
    if (type === 'restart' && (!displayed?.history.canRestart ||
        !window.confirm('Archive this reservation history and start a new rehearsal? The funded checkout will not change.'))) return;
    let action;
    if (type === 'request') {
      const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('');
      action = { type, id, shopper: control.dataset.shopper, priceCents: Number(control.dataset.price) };
    } else if (type === 'price') action = { type, priceCents: Number(control.value) };
    else if (type === 'advance') action = { type, hours: Number(control.dataset.hours) };
    else if (type !== 'restart') action = { type, id: control.dataset.requestId };
    writing = true;
    root.setAttribute('aria-busy', 'true');
    sequence++;
    try {
      const view = type === 'restart' ? await restartReservation({ used: displayed.history.used, archiveCount: displayed.archiveCount }) :
        await changeReservation(action);
      if (current()) { show(view); announce(messages[type]); }
    } catch (error) {
      if (current()) {
        // Re-render even when the model stayed the same, to restore a rejected price selection.
        signature = undefined;
        needsRefresh = true;
        announce(error.name === 'QuotaExceededError' && type === 'restart' ? 'There is not enough browser storage to archive this rehearsal. Your current history was kept.' :
          error.message || 'The reservation could not be updated.');
      }
    } finally {
      writing = false;
      root.removeAttribute('aria-busy');
      if (current() && needsRefresh) { needsRefresh = false; refresh(); }
    }
  }
  root.addEventListener('click', decide);
  root.addEventListener('change', decide);
  const unsubscribe = subscribeReservation(refresh);
  refresh();
  return () => {
    attached = false;
    clearTimeout(timer);
    unsubscribe();
    root.removeEventListener('click', decide);
    root.removeEventListener('change', decide);
  };
}
