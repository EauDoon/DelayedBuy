import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, createLedger, demoLedger, getView, importLedger, validateLedger } from '../core/ledger.mjs';

const at = 1_700_000_000_000;
const holdMs = 60_000;
const hold = {
  type: 'hold', requestId: 'req_open', orderId: 'ord_sample', item: 'Arc table lamp',
  rail: 'card', amount: 18_000, source: 'card_demo', at, holdMs,
};
const pay = { type: 'complete', requestId: 'req_pay', orderId: hold.orderId, at: at + holdMs };
const cancel = { type: 'cancel', requestId: 'req_refund', orderId: hold.orderId, at };
const empty = () => createLedger();
const opened = () => applyAction(empty(), hold);

test('passage of time never closes or moves a hold', () => {
  const ledger = opened();
  const stored = JSON.stringify(ledger);
  for (const [time, eligible] of [[at, false], [at + holdMs - 1, false], [at + holdMs, true], [at + holdMs * 10, true]]) {
    const { orders: [order], totals } = getView(ledger, time);
    assert.equal(order.eligible, eligible);
    assert.equal(order.status, 'holding');
    assert.equal(order.closedAt, null);
    assert.equal(order.events.length, 1);
    assert.deepEqual(totals.card, { held: 18_000, completed: 0, refunded: 0 });
  }
  assert.equal(JSON.stringify(ledger), stored);
});

test('completion requires a decision at or after the exact boundary and pays once', () => {
  const ledger = opened();
  assert.throws(() => applyAction(ledger, { ...pay, at: pay.at - 1 }), /period is still running/);
  const closed = applyAction(ledger, pay);
  assert.deepEqual(getView(closed, pay.at).totals.card, { held: 0, completed: 18_000, refunded: 0 });
  assert.deepEqual(getView(closed, pay.at).orders[0].events[1], {
    type: 'completed', at: pay.at, requestId: 'req_pay', paymentId: 'pay_sample',
    rail: 'card', amount: 18_000, from: 'hold_demo', to: 'merchant_demo',
  });
  assert.throws(() => applyAction(closed, { ...pay, requestId: 'req_pay2' }), /already closed/);
  assert.throws(() => applyAction(closed, { ...cancel, at: pay.at }), /already closed/);
  assert.equal(getView(ledger, pay.at).orders[0].status, 'holding');
});

test('both rails return the entire original amount to the original source before, at, or after expiry', () => {
  for (const [rail, source, amount] of [['card', 'card_demo', 1], ['usdc', 'wallet_demo', 1_000_001]]) {
    for (const delta of [0, holdMs - 1, holdMs, holdMs + 1]) {
      const ledger = applyAction(empty(), { ...hold, rail, source, amount });
      const refunded = applyAction(ledger, { ...cancel, at: at + delta });
      const { orders: [order], totals } = getView(refunded, at + delta);
      assert.equal(order.status, 'refunded');
      assert.equal(order.eligible, false);
      assert.deepEqual(totals[rail], { held: 0, completed: 0, refunded: amount });
      const [credit, debit] = order.events;
      assert.equal(credit.from, source);
      assert.equal(debit.to, source);
      assert.equal(debit.from, credit.to);
      assert.equal(credit.paymentId, debit.paymentId);
      assert.equal(debit.rail, credit.rail);
      assert.equal(debit.amount, credit.amount);
      assert.throws(() => applyAction(refunded, { ...cancel, requestId: 'req_again' }), /already closed/);
      assert.throws(() => applyAction(refunded, pay), /already closed/);
    }
  }
});

test('identical retries, including reordered JSON fields and a retry after close, have no effect', () => {
  const refund = applyAction(opened(), cancel);
  const retry = Object.fromEntries(Object.entries(hold).reverse());
  assert.equal(applyAction(refund, retry), refund);
  assert.equal(applyAction(refund, cancel), refund);
  assert.throws(() => applyAction(refund, { ...hold, amount: 1 }), /different details/);
  assert.throws(() => applyAction(refund, { ...cancel, orderId: 'ord_other' }), /different details/);
  assert.throws(() => applyAction(opened(), { ...hold, requestId: 'req_again' }), /Order ID already exists/);
});

test('unknown orders, pre-hold movements, and user-directed refund destinations are rejected', () => {
  assert.throws(() => applyAction(empty(), cancel), /Unknown order/);
  assert.throws(() => applyAction(opened(), { ...cancel, at: at - 1 }), /precedes/);
  for (const fields of [{ to: 'wallet_demo' }, { source: 'wallet_demo' }, { rail: 'usdc' }, { amount: 99 }]) {
    assert.throws(() => applyAction(opened(), { ...cancel, ...fields }), /action fields/);
  }
});

test('invalid amounts, times, sources, labels, IDs, and rail names cannot enter history', () => {
  const invalid = [
    { amount: 0 }, { amount: -1 }, { amount: 0.01 }, { amount: Number.MAX_SAFE_INTEGER },
    { amount: '18000' }, { amount: Infinity }, { holdMs: 0 }, { holdMs: -1 },
    { holdMs: 366 * 86_400_000 }, { at: -1 }, { at: Number.NaN }, { at: 8_640_000_000_000_000 },
    { source: 'wallet_demo' }, { source: 'real_card' }, { rail: 'usdc' }, { rail: '__proto__' },
    { item: '<lamp>' }, { item: 'lamp\n' }, { item: '❌'.repeat(81) }, { item: ' lamp' },
    { requestId: 'x'.repeat(65) }, { orderId: '__proto__' }, { type: 'charge' },
  ];
  for (const fields of invalid) assert.throws(() => applyAction(empty(), { ...hold, ...fields }));
});

test('imports replay transitions and reject corrupt or unrecognized historical state', () => {
  const ledger = applyAction(opened(), pay);
  assert.deepEqual(importLedger(JSON.stringify(ledger)), ledger);
  const corrupt = [
    null, [], {}, { version: 0, actions: [] }, { ...ledger, extra: 'data' },
    { version: 1, actions: {} }, { version: 1, actions: [hold, hold] },
    { version: 1, actions: [pay, hold] }, { version: 1, actions: [hold, { ...pay, at }] },
    { version: 1, actions: [hold, cancel, pay] }, { version: 1, actions: [null] },
    { version: 1, actions: [{ ...hold, amount: '18000' }] },
  ];
  for (const value of corrupt) assert.throws(() => importLedger(JSON.stringify(value)));
  assert.throws(() => importLedger(' '.repeat(1_500_001)), /oversized/);
  assert.throws(() => importLedger('{'));
  assert.throws(() => validateLedger({ version: 1, actions: Array(2_001) }), /Invalid ledger history/);
});

test('exactly one exit remains available for every hold when the opening limit is reached', () => {
  const actions = Array.from({ length: 1_000 }, (_, i) => ({
    ...hold, requestId: 'req_open_' + i, orderId: 'ord_' + i, amount: 1_000_000_000_000,
  }));
  const atLimit = { version: 1, actions };
  assert.throws(() => applyAction(atLimit, hold), /order limit/);
  assert.equal(getView(atLimit, at).totals.card.held, 1_000_000_000_000_000);
  const refunds = actions.map((action, i) => ({ ...cancel, orderId: action.orderId, requestId: 'req_cancel_' + i }));
  const allButLast = { version: 1, actions: [...actions, ...refunds.slice(0, -1)] };
  const closed = applyAction(allButLast, refunds.at(-1));
  assert.deepEqual(getView(closed, at).totals.card, { held: 0, completed: 0, refunded: 1_000_000_000_000_000 });
  assert.deepEqual(importLedger(JSON.stringify(closed)), closed);
});

test('fictional seeds are deterministic, reorder newest first and reconcile separate units', () => {
  const ledger = demoLedger(at);
  assert.deepEqual(ledger, demoLedger(at));
  const { orders, totals } = getView(ledger, at);
  assert.deepEqual(orders.map(order => [order.id, order.status, order.eligible]), [
    ['ord_arc', 'holding', false], ['ord_studio', 'holding', true], ['ord_daypack', 'completed', false],
  ]);
  assert.deepEqual(totals, {
    card: { held: 18_000, completed: 8_500, refunded: 0 },
    usdc: { held: 120_000_000, completed: 0, refunded: 0 },
  });
  assert.equal(new Set(orders.map(order => order.paymentId)).size, orders.length);
  orders[0].events[0].amount = 0;
  assert.equal(getView(ledger, at).orders[0].events[0].amount, 18_000);
});
