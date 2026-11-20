import { createReservationState, reservationView, observeReservationExpiry, applyReservationAction } from '../core/reservation.mjs';

const KEY = 'delayedbuy.reservation.v1';
const STORE = 'rehearsal';
const RECORD = 'state';
let opening;
let database;
let session;
let memory;
let channel;

function notificationChannel() {
  if (channel === undefined) {
    try { channel = new BroadcastChannel(KEY); } catch { channel = null; }
  }
  return channel;
}

function signalCommit() {
  // Notifications are hints. Every decision reads the committed record again.
  try {
    const target = notificationChannel();
    if (target) target.postMessage(null);
    else window.localStorage.setItem(KEY + '.changed', crypto.randomUUID());
  } catch { /* A blocked notification does not undo the commit. */ }
}

async function openStore() {
  try {
    session = window.sessionStorage;
    if (session.getItem(KEY) !== null) return; // Resume this tab's isolated rehearsal.
  } catch { session = null; }
  try {
    if (window.indexedDB) {
      database = await new Promise((resolve, reject) => {
        const request = window.indexedDB.open(KEY, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      return;
    }
  } catch (error) {
    if (!['SecurityError', 'NotAllowedError', 'InvalidStateError'].includes(error.name)) throw error;
  }
  // Some browsers expose sessionStorage but deny writes. Use memory in that case.
  if (session) {
    try {
      session.setItem(KEY + '.probe', '1');
      session.removeItem(KEY + '.probe');
    } catch { session = null; }
  }
}

function inspect(state, action) {
  const now = Date.now();
  const observed = observeReservationExpiry(state, now);
  let next = observed;
  if (action !== undefined) {
    try { next = applyReservationAction(observed, action, now); }
    catch (error) {
      if (observed === state) throw error;
      // The action lost the deadline race. Save the expiry even though the action failed.
      return { next: observed, error };
    }
  }
  return { next, view: reservationView(next, now) };
}

async function access(action) {
  if (!opening) {
    opening = openStore().catch(error => {
      opening = undefined;
      throw error;
    });
  }
  await opening;
  if (!database) {
    const raw = session?.getItem(KEY);
    // The model accepts at most 1,000 short events with IDs of up to 80 ASCII characters.
    if (raw && raw.length > 240_000) throw new Error('The saved reservation study is too large.');
    const state = raw == null ? memory ?? createReservationState() : JSON.parse(raw);
    const { next, view, error } = inspect(state, action);
    if (next !== state) {
      if (session) session.setItem(KEY, JSON.stringify(next));
      else memory = next;
    }
    if (error) throw error;
    return view;
  }
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const read = store.openCursor(RECORD);
    let result, changed, failure;
    read.onsuccess = () => {
      try {
        // Compute time and availability here, after any other tab's writer has finished.
        const state = read.result ? read.result.value : createReservationState();
        result = inspect(state, action);
        changed = result.next !== state;
        if (changed) store.put(result.next, RECORD);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.onabort = () => reject(failure ?? transaction.error);
    transaction.oncomplete = () => {
      if (changed) signalCommit();
      if (result.error) reject(result.error);
      else resolve(result.view);
    };
  });
}

export function readReservation() { return access(); }
export function changeReservation(action) { return access(action); }
export function reservationStorageMode() { return database ? 'shared' : session ? 'session' : 'memory'; }

export function subscribeReservation(refresh) {
  const target = notificationChannel();
  const peerChange = () => { if (database) refresh(); };
  const storageChange = event => { if (event.key === KEY + '.changed') peerChange(); };
  const visible = () => { if (!document.hidden) refresh(); };
  target?.addEventListener('message', peerChange);
  window.addEventListener('storage', storageChange);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', visible);
  return () => {
    target?.removeEventListener('message', peerChange);
    window.removeEventListener('storage', storageChange);
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', visible);
  };
}
