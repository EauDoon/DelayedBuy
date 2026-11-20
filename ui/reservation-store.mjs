import { createReservationState, reservationView, observeReservationExpiry, applyReservationAction } from '../core/reservation.mjs';

const KEY = 'delayedbuy.reservation.v1';
const STORE = 'rehearsal';
const RECORD = 'state';
let opening;
let database;
let session;
let memory;
let memoryArchives = [];
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

function archiveRange() {
  return IDBKeyRange.bound('archive:', 'archive:\uffff');
}

function sessionRecord(raw) {
  const saved = raw == null ? null : JSON.parse(raw);
  if (saved?.version === 2 && Array.isArray(saved.archives)) {
    if (JSON.stringify(saved.state)?.length > 240_000) throw new Error('The saved reservation study is too large.');
    return saved;
  }
  if (raw?.length > 240_000) throw new Error('The saved reservation study is too large.');
  return { state: raw == null ? memory ?? createReservationState() : saved, archives: memoryArchives };
}

function inspect(state, action, archiveCount, restart) {
  const now = Date.now();
  const observed = observeReservationExpiry(state, now);
  if (restart) {
    const current = reservationView(observed, now).history;
    if (!current.canRestart || restart.used !== current.used || restart.archiveCount !== archiveCount) {
      throw new Error('The reservation rehearsal changed. Review it before starting again.');
    }
    const next = createReservationState();
    return { next, archive: { archivedAt: now, state: observed },
      view: { ...reservationView(next, now), archiveCount: archiveCount + 1 } };
  }
  let next = observed;
  if (action !== undefined) {
    try { next = applyReservationAction(observed, action, now); }
    catch (error) {
      if (observed === state) throw error;
      // The action lost the deadline race. Save the expiry even though the action failed.
      return { next: observed, error };
    }
  }
  return { next, view: { ...reservationView(next, now), archiveCount } };
}

async function openReservationStorage() {
  if (!opening) {
    opening = openStore().catch(error => {
      opening = undefined;
      throw error;
    });
  }
  await opening;
}

async function access(action, restart) {
  await openReservationStorage();
  if (!database) {
    const { state, archives } = sessionRecord(session?.getItem(KEY));
    const { next, view, error, archive } = inspect(state, action, archives.length, restart);
    if (next !== state) {
      const savedArchives = archive ? [...archives, archive] : archives;
      if (session) {
        // Store both in one write: a quota error leaves the original study intact.
        session.setItem(KEY, JSON.stringify(savedArchives.length ? { version: 2, state: next, archives: savedArchives } : next));
      } else {
        memory = next;
        memoryArchives = savedArchives;
      }
    }
    if (error) throw error;
    return view;
  }
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const count = store.count(archiveRange());
    const read = store.openCursor(RECORD);
    let result, changed, failure;
    read.onsuccess = () => {
      try {
        // Compute time and availability here, after any other tab's writer has finished.
        const state = read.result ? read.result.value : createReservationState();
        result = inspect(state, action, count.result, restart);
        changed = result.next !== state;
        // An archive and its replacement must commit together, including across tabs.
        if (result.archive) store.add(result.archive, 'archive:' + String(count.result + 1).padStart(10, '0'));
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
export function restartReservation(expected) { return access(undefined, expected); }

export async function archivedReservations() {
  await openReservationStorage();
  if (!database) return sessionRecord(session?.getItem(KEY)).archives;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readonly');
    const read = transaction.objectStore(STORE).getAll(archiveRange());
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => resolve(read.result);
  });
}
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
