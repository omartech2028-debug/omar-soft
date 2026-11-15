// تشغيل المركز المضمَّن داخل برنامج الحاسوب الرئيسي وإبقاؤه حيًّا
function createCenter({
  spawn, command, args = [], env = {}, onState = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const FIRST_MS = 2000, MAX_MS = 30000;
  let child = null;
  let wanted = false;
  let delay = FIRST_MS;
  let timer = null;

  function launch() {
    timer = null;
    if (!wanted || child) return;
    const c = spawn(command, args, { env, windowsHide: true, stdio: 'ignore' });
    child = c;
    onState('running');
    let ended = false;
    const gone = () => {
      if (ended) return;
      ended = true;
      if (child === c) child = null;
      if (!wanted) return onState('stopped');
      onState('restarting');
      timer = setTimer(launch, delay);
      delay = Math.min(delay * 2, MAX_MS);
    };
    c.on('exit', gone);
    c.on('error', gone);
  }

  return {
    start() { if (wanted) return; wanted = true; delay = FIRST_MS; launch(); },
    stop() {
      wanted = false;
      if (timer !== null) { clearTimer(timer); timer = null; }
      if (child) { const c = child; child = null; c.kill(); } else onState('stopped');
    },
    running: () => !!child,
  };
}

module.exports = { createCenter };
