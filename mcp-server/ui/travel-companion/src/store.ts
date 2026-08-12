/**
 * A key/value store on IndexedDB.
 *
 * IndexedDB rather than localStorage for two reasons: it survives iOS's seven-day eviction of
 * unused sites once the app is installed to the Home Screen, and it is not readable by a
 * synchronous script on the page. The whole trip lives here in plaintext, which is the honest
 * trade for an app you can read while walking — {@link forgetDevice} is the way out.
 */

const DB_NAME = "travel-brain-companion";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable."));
  });
  return dbPromise;
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

export const readValue = <T>(key: string) => transact<T | undefined>("readonly", (store) => store.get(key));
export const writeValue = (key: string, value: unknown) =>
  transact<void>("readwrite", (store) => store.put(value, key));
export const deleteValue = (key: string) => transact<void>("readwrite", (store) => store.delete(key));

export const KEY = {
  snapshot: "snapshot",
  syncedAt: "snapshot:synced_at",
  tripId: "trip:selected",
  trips: "trips",
  tokens: "oauth:tokens",
  clientInformation: "oauth:client",
  discovery: "oauth:discovery",
  // Whether the traveller has agreed to fetch basemap tiles from OpenFreeMap. Kept here rather than
  // in `sessionStorage` so the answer survives closing the app, and cleared by `forgetDevice` with
  // everything else — a device that has forgotten the trip should have forgotten this too.
  mapsEnabled: "maps:enabled",
} as const;

/**
 * Sign out and leave nothing behind. Clearing the cache matters as much as dropping the token:
 * the journal is the sensitive part, and a revoked token does not un-write it from the phone.
 */
export async function forgetDevice(): Promise<void> {
  await transact<void>("readwrite", (store) => store.clear());
  sessionStorage.clear();
  if ("caches" in self) {
    for (const key of await caches.keys()) await caches.delete(key);
  }
}
