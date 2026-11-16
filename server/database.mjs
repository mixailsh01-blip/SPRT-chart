import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const names = ['schedules', 'telephony', 'lunches', 'mango_users', 'roster', 'notifications', 'schedule_updates'];
  for (const name of names) {
    db.exec('CREATE TABLE IF NOT EXISTS ' + name + ' (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  }

  const tables = Object.fromEntries(names.map(name => {
    const all = db.prepare('SELECT data FROM ' + name);
    const get = db.prepare('SELECT data FROM ' + name + ' WHERE id = ?');
    const upsert = db.prepare('INSERT INTO ' + name + ' VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data');
    const clear = db.prepare('DELETE FROM ' + name);
    const remove = db.prepare('DELETE FROM ' + name + ' WHERE id = ?');
    return [name, {
      all: () => all.all().map(row => JSON.parse(row.data)),
      has: id => Boolean(get.get(String(id))),
      put: (id, row) => upsert.run(String(id), JSON.stringify(row)),
      clear: () => clear.run(),
      remove: id => remove.run(String(id)),
    }];
  }));

  const read = db.prepare('SELECT value FROM state WHERE key = ?');
  const write = db.prepare('INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  return {
    ...tables,
    read: key => JSON.parse(read.get(key)?.value ?? 'null'),
    write: (key, value) => write.run(key, JSON.stringify(value)),
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        work();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
