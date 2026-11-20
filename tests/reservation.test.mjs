import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyReservationAction, createReservationState, observeReservationExpiry, reservationView,
} from '../core/reservation.mjs';

const start = Date.UTC(2026, 0, 12, 2);
const hour = 3_600_000;
const day = 24 * hour;
const empty = createReservationState;
const request = (id, shopper = 'A', priceCents = 18_000) => ({ type: 'request', id, shopper, priceCents });
const apply = (state, action, at = start) => applyReservationAction(state, action, at);
const view = (state, at = start) => reservationView(state, at);
const pending = () => apply(empty(), request('a1'));

test('pending requests allocate nothing; explicit acceptance reserves the last unit for exactly 24 hours', () => {
  let state = apply(pending(), request('b1', 'B'));
  assert.equal(view(state).available, 1);
  assert.equal(view(state, start + 2 * day).metrics.timeHeldMs, 0);
  assert.throws(() => apply(state, request('a2')), /already has an open/);
  state = apply(state, { type: 'accept', id: 'a1' }, start + hour);
  const accepted = view(state, start + hour);
  assert.equal(accepted.available, 0);
  assert.deepEqual(accepted.requests[0], { id: 'a1', shopper: 'A', priceCents: 18_000, status: 'active',
    requestedAt: start, acceptedAt: start + hour, expiresAt: start + hour + day, closedAt: null });
  assert.throws(() => apply(state, { type: 'accept', id: 'b1' }, start + hour), /already reserved/);
  assert.throws(() => apply(state, { type: 'withdraw', id: 'a1' }, start + hour), /no longer pending/);
  assert.equal(accepted.requests[1].status, 'pending');
  assert.equal(accepted.metrics.accepted, 1);
  const cutoff = start + hour + day;
  assert.equal(view(state, cutoff - 1).available, 0);
  for (const now of [cutoff, cutoff + 1, cutoff + day * 20]) {
    const shown = view(state, now);
    assert.equal(shown.available, 1);
    assert.equal(shown.requests[0].closedAt, cutoff);
    assert.equal(shown.requests[0].status, 'expired');
    assert.equal(shown.metrics.expiries, 1);
    assert.equal(shown.metrics.timeHeldMs, day);
    assert.throws(() => apply(state, { type: 'return', id: 'a1' }, now), /no longer active/);
  }
  const takeover = apply(state, { type: 'accept', id: 'b1' }, cutoff);
  assert.deepEqual(view(takeover, cutoff).requests.map(r => r.status), ['expired', 'active']);
});

test('price changes require a fresh quote before acceptance and never reprice an accepted reservation', () => {
  let state = apply(pending(), { type: 'price', priceCents: 20_000 });
  const before = JSON.stringify(state);
  assert.throws(() => apply(state, request('b1', 'B')), /listed price changed/);
  assert.throws(() => apply(state, { type: 'accept', id: 'a1' }), /requested price changed/);
  assert.equal(JSON.stringify(state), before);
  assert.equal(view(state).available, 1);
  assert.equal(view(state).requests[0].priceCents, 18_000);
  state = apply(state, { type: 'withdraw', id: 'a1' });
  state = apply(state, request('a2', 'A', 20_000));
  state = apply(state, { type: 'accept', id: 'a2' });
  state = apply(state, { type: 'price', priceCents: 22_000 });
  state = apply(state, request('b1', 'B', 22_000));
  assert.equal(view(state).priceCents, 22_000);
  assert.equal(view(state).requests[1].priceCents, 20_000);
  assert.equal(view(state).requests[2].status, 'pending');
  assert.throws(() => apply(state, { type: 'accept', id: 'b1' }), /already reserved/);
});

test('withdrawal and decline close only pending requests and cannot be replayed on another request', () => {
  for (const [type, status] of [['withdraw', 'withdrawn'], ['decline', 'declined']]) {
    let state = apply(pending(), { type, id: 'a1' }, start + hour);
    assert.equal(view(state).requests[0].status, status);
    assert.equal(view(state).metrics[status], 1);
    assert.equal(view(state).metrics.timeHeldMs, 0);
    state = apply(state, request('a2'));
    for (const invalid of ['accept', type, 'return']) {
      assert.throws(() => apply(state, { type: invalid, id: 'a1' }));
    }
    assert.throws(() => apply(state, request('a1')), /already been used/);
    assert.equal(view(state).requests[1].status, 'pending');
    assert.equal(view(state).available, 1);
  }
});

test('release, shopper cancellation and explicit return each free the unit exactly once', () => {
  for (const [type, status, metric] of [
    ['release', 'released', 'releases'], ['cancel', 'cancelled', 'cancellations'], ['return', 'returned', 'returns'],
  ]) {
    let state = apply(pending(), { type: 'accept', id: 'a1' });
    state = apply(state, { type, id: 'a1' }, start + hour);
    assert.equal(view(state).available, 1);
    assert.equal(view(state).requests[0].status, status);
    assert.equal(view(state, start + day * 2).metrics.timeHeldMs, hour);
    state = apply(apply(state, request('a2')), { type: 'accept', id: 'a2' });
    const before = JSON.stringify(state);
    for (const stale of ['return', 'release', 'cancel']) {
      assert.throws(() => apply(state, { type: stale, id: 'a1' }), /no longer active/);
    }
    assert.equal(JSON.stringify(state), before);
    const result = view(state);
    assert.deepEqual(result.requests.map(r => r.status), [status, 'active']);
    assert.equal(result.available, 0);
    assert.equal(result.metrics[metric], 1);
    assert.equal(result.metrics.accepted, 2);
    assert.equal(result.metrics.expiries, 0);
  }
});

test('automatic expiry checkpoints its deadline once, including after late observation and clock rollback', () => {
  const active = apply(pending(), { type: 'accept', id: 'a1' });
  assert.equal(observeReservationExpiry(active, start + day - 1), active);
  const state = observeReservationExpiry(active, start + 3 * day);
  assert.deepEqual(state.events.at(-1), { type: 'expiry', id: 'a1', at: start + day });
  for (const now of [start, start + day, start + day * 3]) {
    assert.equal(observeReservationExpiry(state, now), state);
    const shown = view(JSON.parse(JSON.stringify(state)), now);
    assert.equal(shown.metrics.expiries, 1);
    assert.equal(shown.metrics.timeHeldMs, day);
    assert.equal(shown.available, 1);
  }
  const second = apply(apply(state, request('a2'), start), { type: 'accept', id: 'a2' }, start);
  assert.equal(view(second).requests[1].acceptedAt, start + day);
});

test('clock advances and elapsed wall time combine across saved sessions', () => {
  let state = apply(pending(), { type: 'accept', id: 'a1' });
  state = apply(state, { type: 'advance', hours: 1 });
  assert.equal(view(state, start + hour).metrics.timeHeldMs, 2 * hour);
  assert.equal(view(state, start - hour).now, start + hour);
  state = apply(state, { type: 'advance', hours: 24 }, start + hour);
  const replayed = view(JSON.parse(JSON.stringify(state)), start + hour);
  assert.equal(replayed.now, start + 26 * hour);
  assert.equal(replayed.requests[0].closedAt, start + day);
  assert.equal(replayed.metrics.timeHeldMs, day);
  assert.equal(replayed.available, 1);
  assert.equal(observeReservationExpiry(state, replayed.now), state);
});

test('corrupt records and invalid inputs fail without changing history or leaking mutable state', () => {
  const state = pending();
  const before = JSON.stringify(state);
  const invalid = [
    { type: 'purchase', id: 'a1' }, { type: 'expiry', id: 'a1' }, { type: 'accept', id: 'absent' },
    { type: '__proto__' }, { type: 'advance', hours: -1 }, request('a\n', 'A'), request('b', 'C'),
    request('b', 'B', '18000'), { type: 'price', priceCents: 0 }, { type: 'price', priceCents: 12.5 },
    { type: 'cancel', id: 'a1', email: 'unused' }, { ...request('b', 'B'), at: start + day },
  ];
  for (const action of invalid) assert.throws(() => apply(state, action));
  for (const corrupt of [
    null, { ...state, version: 3 }, { ...state, offsetMs: day }, { ...state, extra: [] },
    { ...state, events: [null] }, { ...state, events: Array(1_001) },
    { ...state, events: [...state.events, { type: 'accept', id: 'a1', at: start - 1 }] },
    { ...state, events: [...state.events, { type: 'expiry', id: 'a1', at: start + day }] },
  ]) assert.throws(() => view(corrupt));
  for (const now of [-1, NaN, Infinity, 1.5]) assert.throws(() => view(state, now));
  view(state).requests[0].priceCents = 9;
  assert.equal(view(state).requests[0].priceCents, 18_000);
  assert.equal(JSON.stringify(state), before);
});

test('a full study preserves room to accept and close each pending request', () => {
  const state = { ...empty(), events: Array.from({ length: 997 }, () => ({ type: 'price', priceCents: 18_000, at: start })) };
  let full = apply(state, request('last'));
  assert.throws(() => apply(full, { type: 'price', priceCents: 22_000 }), /history is full/);
  assert.throws(() => apply(full, request('too-many', 'B')), /history is full/);
  full = apply(full, { type: 'accept', id: 'last' });
  assert.throws(() => apply(full, { type: 'advance', hours: 1 }), /history is full/);
  assert.equal(view(observeReservationExpiry(full, start + day), start + day).available, 1);
  full = apply(full, { type: 'release', id: 'last' });
  assert.equal(full.events.length, 1_000);
  assert.equal(view(full).available, 1);
});
