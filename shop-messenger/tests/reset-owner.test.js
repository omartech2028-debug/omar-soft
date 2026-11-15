const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');

const script = path.join(__dirname, '..', 'server', 'reset-owner.js');
const run = (dir, ...args) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args],
  { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('the recovery tool sets a new owner secret from the shop computer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'));
  const db = openDb(dir);
  createAuth(db).setup('عمر', 'forgotten1');
  db.close();
  const out = run(dir, 'brandnew99');
  assert.match(out, /عمر/);
  const auth = createAuth(openDb(dir));
  assert.ok(auth.login('عمر', 'brandnew99').token);
  assert.throws(() => auth.login('عمر', 'forgotten1'), /bad_login/);
});

test('the recovery tool refuses a short secret and an empty database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-'));
  assert.throws(() => run(dir, 'brandnew99'), /status 1|Command failed/);
  const db = openDb(dir);
  createAuth(db).setup('عمر', 'forgotten1');
  db.close();
  assert.throws(() => run(dir, 'short'), /Command failed/);
  assert.ok(createAuth(openDb(dir)).login('عمر', 'forgotten1').token);
});
