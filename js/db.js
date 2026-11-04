/* IndexedDB storage for scanned pages.
   Pages survive if the app is closed mid-scan. */
const DB = (() => {
  const NAME = 'doc-scanner';
  const VERSION = 1;
  const STORE = 'pages';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
      const r = fn(store);
      if (r && typeof r.onsuccess !== 'undefined') {
        r.onsuccess = () => { result = r.result; };
      }
    }));
  }

  return {
    async getAll() {
      const pages = await tx('readonly', (s) => s.getAll());
      return (pages || []).sort((a, b) => a.order - b.order);
    },
    put(page) { return tx('readwrite', (s) => s.put(page)); },
    putMany(pages) {
      return tx('readwrite', (s) => { pages.forEach((p) => s.put(p)); });
    },
    remove(id) { return tx('readwrite', (s) => s.delete(id)); },
    clear() { return tx('readwrite', (s) => s.clear()); },
  };
})();
