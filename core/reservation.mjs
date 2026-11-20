// One synthetic SGD offer and one unit. Persist only accepted decisions and demo clock changes.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LAST_DATE = 8_640_000_000_000_000;
const EVENT_LIMIT = 1_000;
const TARGET_FIELDS = ['type', 'id'];
const ACTION_FIELDS = {
  request: ['type', 'id', 'shopper', 'priceCents'], price: ['type', 'priceCents'],
  advance: ['type', 'hours'], accept: TARGET_FIELDS, decline: TARGET_FIELDS,
  withdraw: TARGET_FIELDS, cancel: TARGET_FIELDS, release: TARGET_FIELDS, return: TARGET_FIELDS,
};
const TERMINAL = {
  decline: 'declined', withdraw: 'withdrawn', cancel: 'cancelled',
  release: 'released', return: 'returned',
};

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

function exactFields(record, fields) {
  return record !== null && typeof record === 'object' && !Array.isArray(record) &&
    Object.keys(record).length === fields.length && fields.every(key => Object.hasOwn(record, key));
}

function checkTime(ms) {
  requireValid(Number.isSafeInteger(ms) && ms >= 0 && ms <= LAST_DATE, 'Invalid reservation study clock.');
}

function validateCommand(action) {
  requireValid(action && typeof action.type === 'string' && Object.hasOwn(ACTION_FIELDS, action.type),
    'Unknown reservation study action.');
  requireValid(exactFields(action, ACTION_FIELDS[action.type]), 'Unexpected reservation action fields.');
  if (Object.hasOwn(action, 'id')) {
    requireValid(typeof action.id === 'string' && action.id.length > 0 && action.id.length <= 80 &&
      !/[^A-Za-z0-9_-]/.test(action.id), 'Invalid reservation request ID.');
  }
  if (Object.hasOwn(action, 'priceCents')) {
    requireValid(Number.isSafeInteger(action.priceCents) && action.priceCents > 0 && action.priceCents <= 100_000_000,
      'Use a positive demo price of up to S$1,000,000 in whole cents.');
  }
  if (action.type === 'request') {
    requireValid(action.shopper === 'A' || action.shopper === 'B', 'Choose Shopper A or Shopper B.');
  }
  if (action.type === 'advance') {
    requireValid(action.hours === 1 || action.hours === 24, 'Advance the study clock by 1 or 24 hours.');
  }
}

function closeRequest(study, request, status, at) {
  request.status = status;
  request.closedAt = at;
  study.outstanding.delete(request.shopper);
  if (study.active === request) study.active = null;
}

function moveClock(study, at) {
  checkTime(at);
  requireValid(at >= study.now, 'Reservation study history runs backwards.');
  if (study.active && at >= study.active.expiresAt) {
    closeRequest(study, study.active, 'expired', study.active.expiresAt);
  }
  study.now = at;
}

function applyCommand(study, action) {
  validateCommand(action);
  if (action.type === 'advance') {
    const delta = HOUR * action.hours;
    moveClock(study, study.now + delta);
    study.offsetMs += delta;
    return;
  }
  if (action.type === 'price') {
    study.priceCents = action.priceCents;
    return;
  }
  if (action.type === 'request') {
    requireValid(!study.requests.has(action.id), 'This request ID has already been used.');
    requireValid(!study.outstanding.has(action.shopper), 'This shopper already has an open request or reservation.');
    requireValid(action.priceCents === study.priceCents, 'The listed price changed. Review it before requesting.');
    const request = { id: action.id, shopper: action.shopper, priceCents: action.priceCents, status: 'pending',
      requestedAt: study.now, acceptedAt: null, expiresAt: null, closedAt: null };
    study.requests.set(request.id, request);
    study.outstanding.set(request.shopper, request);
    return;
  }

  const request = study.requests.get(action.id);
  requireValid(request, 'This reservation request could not be found.');
  if (['accept', 'decline', 'withdraw'].includes(action.type)) {
    requireValid(request.status === 'pending', 'This request is no longer pending.');
  } else {
    requireValid(request.status === 'active', 'This reservation is no longer active.');
  }
  if (action.type === 'accept') {
    requireValid(request.priceCents === study.priceCents, 'The requested price changed. A new request is needed.');
    requireValid(!study.active, 'The only unit is already reserved.');
    checkTime(study.now + DAY);
    request.status = 'active';
    request.acceptedAt = study.now;
    request.expiresAt = study.now + DAY;
    study.active = request;
    return;
  }
  closeRequest(study, request, TERMINAL[action.type], study.now);
}

// Keep enough space for all pending requests to be accepted and for each allocation to close.
function checkCapacity(study, count) {
  let remaining = 0;
  for (const request of study.outstanding.values()) remaining += request.status === 'pending' ? 2 : 1;
  requireValid(count + remaining <= EVENT_LIMIT, 'Reservation study history is full.');
}

function replay(state) {
  requireValid(exactFields(state, ['version', 'offsetMs', 'events']) && state.version === 1 &&
    Array.isArray(state.events) && state.events.length <= EVENT_LIMIT, 'Invalid reservation study history.');
  const study = { now: 0, offsetMs: 0, priceCents: 18_000, requests: new Map(), outstanding: new Map(), active: null };
  for (const [index, event] of state.events.entries()) {
    requireValid(event && Object.hasOwn(event, 'at'), 'Missing reservation event time.');
    const { at, ...action } = event;
    if (action.type === 'expiry') {
      requireValid(exactFields(action, TARGET_FIELDS) && study.active?.id === action.id &&
        study.active?.expiresAt === at, 'Invalid reservation expiry record.');
      moveClock(study, at);
    } else {
      moveClock(study, at);
      applyCommand(study, action);
    }
    checkCapacity(study, index + 1);
  }
  requireValid(state.offsetMs === study.offsetMs, 'Invalid saved reservation clock offset.');
  return study;
}

function effectiveNow(study, wallNow) {
  checkTime(wallNow);
  const now = Math.max(study.now, wallNow + study.offsetMs);
  checkTime(now);
  return now;
}

export function createReservationState() {
  return { version: 1, offsetMs: 0, events: [] };
}

// Persist once on first observing a natural expiry. A later backwards wall clock cannot reopen it.
export function observeReservationExpiry(state, wallNow = Date.now()) {
  const study = replay(state);
  const now = effectiveNow(study, wallNow);
  if (!study.active || now < study.active.expiresAt) return state;
  const event = { type: 'expiry', id: study.active.id, at: study.active.expiresAt };
  return { ...state, events: [...state.events, event] };
}

export function applyReservationAction(state, action, wallNow = Date.now()) {
  const study = replay(state);
  const at = effectiveNow(study, wallNow);
  moveClock(study, at);
  applyCommand(study, action);
  checkCapacity(study, state.events.length + 1);
  return { version: 1, offsetMs: study.offsetMs, events: [...state.events, { ...action, at }] };
}

export function reservationView(state, wallNow = Date.now()) {
  const study = replay(state);
  moveClock(study, effectiveNow(study, wallNow));
  const requests = [...study.requests.values()];
  const metrics = { requests: requests.length, accepted: 0, declined: 0, withdrawn: 0, returns: 0,
    cancellations: 0, releases: 0, expiries: 0, timeHeldMs: 0 };
  const terminalCounts = { declined: 'declined', withdrawn: 'withdrawn', returned: 'returns', cancelled: 'cancellations',
    released: 'releases', expired: 'expiries' };
  for (const request of requests) {
    if (request.acceptedAt !== null) {
      metrics.accepted++;
      metrics.timeHeldMs += (request.closedAt ?? study.now) - request.acceptedAt;
    }
    if (Object.hasOwn(terminalCounts, request.status)) metrics[terminalCounts[request.status]]++;
  }
  return { now: study.now, priceCents: study.priceCents, available: study.active ? 0 : 1, requests, metrics };
}
