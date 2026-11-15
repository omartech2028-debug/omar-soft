// منطق التنبيه: متى تظهر الدائرة ومتى يُسمع الصوت. لا يعتمد على Electron ليسهل اختباره.
function createAlertState({
  repeatMs = 30000,
  onShow, onHide, onSound,
  setTimer = setInterval, clearTimer = clearInterval,
}) {
  let count = 0;
  let from = null;
  let timer = null;

  function update(next) {
    const n = Math.max(0, Math.floor(Number(next && next.count)) || 0);
    const who = (next && next.from) || null;
    if (n === 0) {
      if (count === 0) return;
      count = 0; from = null;
      if (timer !== null) { clearTimer(timer); timer = null; }
      onHide();
      return;
    }
    if (n === count && who === from) return;
    const louder = n > count;
    count = n; from = who;
    onShow({ count, from });
    if (louder) onSound();
    if (timer === null) timer = setTimer(onSound, repeatMs);
  }

  return { update };
}

module.exports = { createAlertState };
