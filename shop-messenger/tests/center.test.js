const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCenter } = require('../desktop/lib/center');

function rig() {
  const children = [];
  const timers = [];
  const states = [];
  const center = createCenter({
    command: 'node.exe', args: ['server/main.js'], env: { PORT: '4800' },
    spawn: (cmd, args, opts) => {
      const c = new EventEmitter();
      Object.assign(c, { cmd, args, opts, killed: false, kill() { c.killed = true; c.emit('exit', null); } });
      children.push(c);
      return c;
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: id => { timers[id - 1].fn = () => {}; },
    onState: s => states.push(s),
  });
  return { center, children, timers, states };
}

test('start launches the bundled center once, hidden, with its settings', () => {
  const r = rig();
  r.center.start(); r.center.start();
  assert.equal(r.children.length, 1);
  assert.equal(r.children[0].cmd, 'node.exe');
  assert.deepEqual(r.children[0].args, ['server/main.js']);
  assert.equal(r.children[0].opts.env.PORT, '4800');
  assert.equal(r.children[0].opts.windowsHide, true);
  assert.equal(r.center.running(), true);
});

test('a center that dies is restarted, waiting longer each time up to 30 s', () => {
  const r = rig();
  r.center.start();
  for (const expected of [2000, 4000, 8000, 16000, 30000, 30000]) {
    r.children.at(-1).emit('exit', 1);
    assert.equal(r.center.running(), false);
    assert.equal(r.timers.at(-1).ms, expected);
    r.timers.at(-1).fn();
    assert.equal(r.center.running(), true);
  }
  assert.equal(r.children.length, 7);
});

test('a spawn error counts as a crash, not an exception', () => {
  const r = rig();
  r.center.start();
  r.children[0].emit('error', new Error('ENOENT'));
  assert.equal(r.timers.length, 1);
});

test('stop kills the center and cancels any pending restart', () => {
  const r = rig();
  r.center.start();
  r.children[0].emit('exit', 1);
  r.center.stop();
  r.timers[0].fn();
  assert.equal(r.children.length, 1);
  r.center.start();
  r.center.stop();
  assert.equal(r.children[1].killed, true);
  assert.equal(r.timers.length, 1);            // الإيقاف المقصود لا يعيد التشغيل
  assert.deepEqual(r.states.at(-1), 'stopped');
});
