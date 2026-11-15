const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlertState } = require('../desktop/lib/alert-state');

function rig() {
  const log = [];
  const timers = new Map();
  let nextId = 1;
  const state = createAlertState({
    onShow: v => log.push(['show', v.count, v.from]),
    onHide: () => log.push(['hide']),
    onSound: () => log.push(['sound']),
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
  });
  const tick = () => { for (const t of [...timers.values()]) t.fn(); };
  return { state, log, timers, tick };
}

test('first unread shows the bubble and sounds at once', () => {
  const r = rig();
  r.state.update({ count: 1, from: 'عمر' });
  assert.deepEqual(r.log, [['show', 1, 'عمر'], ['sound']]);
});

test('sound repeats every 30000 ms with a single timer', () => {
  const r = rig();
  r.state.update({ count: 1, from: 'عمر' });
  assert.equal(r.timers.size, 1);
  assert.equal([...r.timers.values()][0].ms, 30000);
  r.tick(); r.tick();
  assert.equal(r.log.filter(e => e[0] === 'sound').length, 3);
});

test('a higher count updates the bubble and sounds again without a second timer', () => {
  const r = rig();
  r.state.update({ count: 1, from: 'عمر' });
  r.state.update({ count: 2, from: 'سمير' });
  assert.deepEqual(r.log.slice(2), [['show', 2, 'سمير'], ['sound']]);
  assert.equal(r.timers.size, 1);
});

test('a lower but non-zero count updates the bubble silently', () => {
  const r = rig();
  r.state.update({ count: 3, from: 'عمر' });
  r.state.update({ count: 1, from: 'عمر' });
  assert.deepEqual(r.log.slice(2), [['show', 1, 'عمر']]);
});

test('the same count again does nothing', () => {
  const r = rig();
  r.state.update({ count: 1, from: 'عمر' });
  r.state.update({ count: 1, from: 'عمر' });
  assert.equal(r.log.length, 2);
});

test('zero hides once and stops the timer', () => {
  const r = rig();
  r.state.update({ count: 2, from: 'عمر' });
  r.state.update({ count: 0, from: null });
  r.state.update({ count: 0, from: null });
  assert.deepEqual(r.log.slice(2), [['hide']]);
  assert.equal(r.timers.size, 0);
});

test('zero at the very start does not hide anything', () => {
  const r = rig();
  r.state.update({ count: 0, from: null });
  assert.deepEqual(r.log, []);
});

test('garbage input is treated as zero', () => {
  const r = rig();
  r.state.update({ count: 'x' });
  r.state.update(null);
  assert.deepEqual(r.log, []);
});
