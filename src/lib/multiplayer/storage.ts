import type { Journal, JournalStore } from './protocol';

const STORE = 'matches';

export interface IndexedMatchStore extends JournalStore {
  list: () => Promise<Journal[]>;
}

export function createIndexedMatchStore(name: string): IndexedMatchStore {
  let connection: Promise<IDBDatabase> | undefined;

  function open(): Promise<IDBDatabase> {
    connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'matchId' });
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          connection = undefined;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('对局存储正在由其他标签页升级。'));
    }).catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
    return connection;
  }

  async function read<T>(query: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE);
      const request = query(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  return {
    get: (matchId) => read<Journal | undefined>((store) => store.get(matchId)),
    list: () => read<Journal[]>((store) => store.getAll()),
    save: async (previous, next) => {
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' });
        const store = transaction.objectStore(STORE);
        const readCurrent = store.get(next.matchId);
        let conflict = false;
        readCurrent.onsuccess = () => {
          const current: Journal | undefined = readCurrent.result;
          if (!sameRevision(previous, current)) {
            conflict = true;
            transaction.abort();
            return;
          }
          store.put(next);
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(
          conflict ? new Error('另一标签页已更新这场对局。请返回大厅后重新连接。')
            : transaction.error ?? new Error('无法保存对局。'),
        );
      });
    },
  };
}

function sameRevision(left: Journal | undefined, right: Journal | undefined): boolean {
  if (!left || !right) return left === right;
  return left.player === right.player && left.secret === right.secret
    && left.genesis === right.genesis && left.entries.length === right.entries.length
    && left.entries.at(-1)?.digest === right.entries.at(-1)?.digest
    && left.pending?.id === right.pending?.id;
}
