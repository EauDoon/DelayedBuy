// Offline simulator. The only stored state is a versioned log of accepted commands.
// Amounts are integer SGD cents on card and integer USDC micro-units on the wallet.
const DAY = 86_400_000;
const LAST_DATE = 8_640_000_000_000_000;
const ORDER_LIMIT = 1_000;
const MAX_AMOUNT = 1_000_000_000_000;
const ORIGIN = Object.freeze({ card: 'card_demo', usdc: 'wallet_demo' });
const HOLD_KEYS = ['type', 'requestId', 'orderId', 'item', 'rail', 'amount', 'source', 'at', 'holdMs'];
const CLOSE_KEYS = ['type', 'requestId', 'orderId', 'at'];
const ITEM_LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .,'&()+:/_-]{0,79}$/u;

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function integerIn(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function checkClock(at) {
  requireThat(integerIn(at, 0, LAST_DATE), 'Invalid simulation time.');
}

function validateAction(action) {
  const kind = action?.type;
  requireThat(kind === 'hold' || kind === 'complete' || kind === 'cancel', 'Unknown ledger action.');
  const keys = kind === 'hold' ? HOLD_KEYS : CLOSE_KEYS;
  requireThat(exactRecord(action, keys), 'Unexpected or missing action fields.');
  requireThat(typeof action.requestId === 'string' && /^req_[A-Za-z0-9_-]{1,64}$/.test(action.requestId), 'Invalid request ID.');
  requireThat(typeof action.orderId === 'string' && /^ord_[A-Za-z0-9_-]{1,64}$/.test(action.orderId), 'Invalid order ID.');
  checkClock(action.at);

  if (kind === 'hold') {
    requireThat(typeof action.item === 'string' && action.item === action.item.trim() && ITEM_LABEL.test(action.item), 'Invalid item label.');
    requireThat(action.rail === 'card' || action.rail === 'usdc', 'Unknown simulation rail.');
    requireThat(action.source === ORIGIN[action.rail], 'The source must be the demo source for this rail.');
    requireThat(integerIn(action.amount, 1, MAX_AMOUNT), 'Invalid amount in the rail’s smallest unit.');
    requireThat(integerIn(action.holdMs, 1, 365 * DAY), 'Invalid hold duration.');
    checkClock(action.at + action.holdMs);
  }

  // Canonical field order also makes fingerprints independent of JSON key ordering.
  return Object.fromEntries(keys.map(key => [key, action[key]]));
}

function event(order, action, type, from, to) {
  return {
    type, at: action.at, requestId: action.requestId, paymentId: order.paymentId,
    rail: order.rail, amount: order.amount, from, to,
  };
}

function accept(state, action) {
  const fingerprint = JSON.stringify(action);
  if (state.requests.has(action.requestId)) {
    requireThat(state.requests.get(action.requestId) === fingerprint, 'Request ID already used with different details.');
    return false;
  }

  if (action.type === 'hold') {
    requireThat(!state.orders.has(action.orderId), 'Order ID already exists.');
    // Limit openings, so every existing order always has room for its exit command.
    requireThat(state.orders.size < ORDER_LIMIT, 'The demo order limit has been reached.');
    const order = {
      id: action.orderId, paymentId: 'pay_' + action.orderId.slice(4),
      item: action.item, rail: action.rail, amount: action.amount, source: action.source,
      createdAt: action.at, unlockAt: action.at + action.holdMs, closedAt: null,
      status: 'holding', events: [],
    };
    order.events.push(event(order, action, 'held', order.source, 'hold_demo'));
    state.orders.set(order.id, order);
  } else {
    const order = state.orders.get(action.orderId);
    requireThat(order, 'Unknown order ID.');
    requireThat(order.status === 'holding', 'This order is already closed.');
    requireThat(action.at >= order.createdAt, 'The action precedes the original hold.');
    const complete = action.type === 'complete';
    requireThat(!complete || action.at >= order.unlockAt, 'The hold period is still running.');
    order.status = complete ? 'completed' : 'refunded';
    order.closedAt = action.at;
    order.events.push(event(order, action, order.status, 'hold_demo', complete ? 'merchant_demo' : order.source));
  }
  state.requests.set(action.requestId, fingerprint);
  return true;
}

function replay(ledger) {
  requireThat(exactRecord(ledger, ['version', 'actions']) && ledger.version === 1, 'Unsupported ledger format.');
  requireThat(Array.isArray(ledger.actions) && ledger.actions.length <= 2 * ORDER_LIMIT, 'Invalid ledger history.');
  const state = { orders: new Map(), requests: new Map() };
  for (const rawAction of ledger.actions) {
    requireThat(accept(state, validateAction(rawAction)), 'Ledger contains a duplicate request.');
  }
  return state;
}

export function createLedger() {
  return { version: 1, actions: [] };
}

export function validateLedger(ledger) {
  replay(ledger);
  return ledger;
}

export function importLedger(jsonText) {
  requireThat(typeof jsonText === 'string' && jsonText.length <= 1_500_000, 'Invalid or oversized ledger file.');
  return validateLedger(JSON.parse(jsonText));
}

export function applyAction(ledger, action) {
  const state = replay(ledger);
  const checked = validateAction(action);
  if (!accept(state, checked)) return ledger;
  return { version: 1, actions: [...ledger.actions, checked] };
}

export function getView(ledger, nowMs = Date.now()) {
  checkClock(nowMs);
  const state = replay(ledger);
  const totals = {
    card: { held: 0, completed: 0, refunded: 0 },
    usdc: { held: 0, completed: 0, refunded: 0 },
  };
  const orders = Array.from(state.orders.values()).reverse();
  orders.sort((a, b) => b.createdAt - a.createdAt);
  for (const order of orders) {
    order.eligible = order.status === 'holding' && nowMs >= order.unlockAt;
    const bucket = order.status === 'holding' ? 'held' : order.status;
    // At most ORDER_LIMIT * MAX_AMOUNT (10^15) per bucket, below MAX_SAFE_INTEGER.
    totals[order.rail][bucket] += order.amount;
  }
  return { orders, totals };
}

export function demoLedger(nowMs = Date.now(), requestIdFor = label => 'req_' + label) {
  checkClock(nowMs);
  requireThat(nowMs >= 4 * DAY && nowMs <= LAST_DATE - 2 * DAY, 'Demo time is out of range.');
  const actions = [
    { type: 'hold', requestId: requestIdFor('daypack_hold'), orderId: 'ord_daypack', item: 'Canvas daypack',
      rail: 'card', amount: 8_500, source: 'card_demo', at: nowMs - 4 * DAY, holdMs: 2 * DAY },
    { type: 'hold', requestId: requestIdFor('studio_hold'), orderId: 'ord_studio', item: 'Studio headphones',
      rail: 'usdc', amount: 120_000_000, source: 'wallet_demo', at: nowMs - 3 * DAY, holdMs: 2 * DAY },
    { type: 'complete', requestId: requestIdFor('daypack_complete'), orderId: 'ord_daypack', at: nowMs - DAY },
    { type: 'hold', requestId: requestIdFor('arc_hold'), orderId: 'ord_arc', item: 'Arc table lamp',
      rail: 'card', amount: 18_000, source: 'card_demo', at: nowMs - DAY, holdMs: 3 * DAY },
  ];
  return validateLedger({ version: 1, actions });
}
