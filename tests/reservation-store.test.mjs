import assert from 'node:assert/strict';
import test from 'node:test';

const key = 'delayedbuy.reservation.v1';
const fundedKey = 'delayedbuy.sandbox.v1';
const capped = { version: 1, offsetMs: 0,
  events: Array.from({ length: 1_000 }, () => ({ type: 'price', priceCents: 20_000, at: 1 })) };
const cappedRaw = JSON.stringify(capped);
const funded = 'synthetic fixture for the separate funded checkout';

test('session restart is compare-and-set, atomic under quota failure, and retains archives across reopening', async () => {
  const local = new Map([[key, cappedRaw], [fundedKey, funded]]);
  let quota = false;
  globalThis.window = { sessionStorage: {
    getItem: name => local.get(name) ?? null,
    setItem(name, value) {
      if (quota) throw new DOMException('No space', 'QuotaExceededError');
      local.set(name, value);
    },
  } };
  try {
    const { readReservation, restartReservation, archivedReservations, changeReservation } =
      await import('../ui/reservation-store.mjs?test-full');
    const before = await readReservation();
    assert.equal(before.history.canRestart, true);
    await assert.rejects(restartReservation({ used: 999, archiveCount: 0 }), /rehearsal changed/);
    assert.equal(local.get(key), cappedRaw);

    quota = true;
    await assert.rejects(restartReservation({ used: 1000, archiveCount: 0 }), { name: 'QuotaExceededError' });
    assert.equal(local.get(key), cappedRaw);
    assert.deepEqual(await archivedReservations(), []);
    quota = false;

    const fresh = await restartReservation({ used: 1000, archiveCount: 0 });
    assert.equal(fresh.history.canRequest, true);
    assert.equal(fresh.priceCents, 18_000);
    assert.equal(fresh.archiveCount, 1);
    await assert.rejects(restartReservation({ used: 1000, archiveCount: 0 }), /rehearsal changed/);
    await changeReservation({ type: 'request', id: 'new', shopper: 'A', priceCents: 18_000 });
    const reopened = await import('../ui/reservation-store.mjs?test-reopen');
    assert.equal((await reopened.readReservation()).history.used, 1);
    assert.deepEqual((await reopened.archivedReservations()).map(archive => archive.state), [capped]);
    assert.equal(local.get(fundedKey), funded);
  } finally {
    delete globalThis.window;
  }
});
