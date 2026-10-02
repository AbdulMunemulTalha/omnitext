import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

test('upgrades a database created before delivery charges existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omnitext-'));
  try {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT ''); INSERT INTO workspaces (name) VALUES ('Old shop');");
    old.close();

    const db = openDb(path);
    assert.deepEqual(
      { ...db.prepare('SELECT delivery_inside_dhaka, delivery_outside_dhaka FROM workspaces').get() },
      { delivery_inside_dhaka: 70, delivery_outside_dhaka: 130 },
    );
    db.close();
    openDb(path).close(); // running it again is a no-op
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
