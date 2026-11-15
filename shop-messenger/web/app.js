// واجهة مراسلة المحل — بدون أي مكتبة خارجية
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const TOKEN_KEY = 'messenger.token';
  const ERRORS = {
    bad_login: 'الاسم أو كلمة السر غير صحيحة',
    locked: 'محاولات كثيرة خاطئة. انتظر قليلًا ثم أعد المحاولة',
    bad_pin: 'كلمة السر قصيرة: 8 على الأقل لصاحب المحل، 6 للأشخاص، 4 للحواسيب',
    bad_old: 'كلمة السر الحالية غير صحيحة',
    bad_user: 'هذا الحساب غير موجود',
    lan_only: 'هذا الحساب يُفتح من داخل المحل فقط',
    weak_secret: 'كلمة سرك قصيرة للدخول من خارج المحل. غيّرها من داخل المحل أولًا',
    bad_name: 'الاسم غير صالح',
    name_taken: 'هذا الاسم مستعمل',
    forbidden: 'هذه العملية لصاحب المحل فقط',
    too_long: 'الرسالة طويلة جدًا',
    too_many: 'طلبات كثيرة بانتظار الموافقة. اطلب من صاحب المحل قبولها أولًا',
    not_ready: 'المركز لم يُجهَّز بعد. أنشئ حساب صاحب المحل على الحاسوب الرئيسي أولًا',
    empty: 'الرسالة فارغة',
    already_setup: 'تم إعداد البرنامج من قبل. أعد تحميل الصفحة',
    network: 'تعذّر الاتصال بالمركز',
  };
  const errText = code => ERRORS[code] || 'حدث خطأ غير متوقع';

  const store = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {} },
  };

  const state = {
    token: null, me: null, users: [], convs: [],
    current: null,          // رقم المحادثة المفتوحة
    messages: [], reads: [],
    source: null,
  };

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error('network'); }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && state.me) { logout(); }
      throw new Error((json && json.error) || 'server_error');
    }
    return json;
  }

  function show(view) {
    for (const v of ['view-setup', 'view-login', 'view-join', 'view-main']) $(v).hidden = v !== view;
  }

  // ---------- الدخول ----------
  async function init() {
    let needsSetup;
    try { const st = await api('GET', '/api/state'); needsSetup = st.needsSetup; state.remote = st.remote; }
    catch { show('view-login'); $('login-error').textContent = errText('network'); return; }
    if (needsSetup) return show('view-setup');
    state.token = store.get();
    if (state.token) {
      try { state.me = await api('GET', '/api/me'); return enter(); }
      catch (e) { if (e.message === 'network') { $('login-error').textContent = errText('network'); } state.token = null; }
    }
    showGate();
  }

  // ---------- انضمام حاسوب عمل باسمه فقط ----------
  const JOIN_KEY = 'messenger.join';
  const joinStore = {
    get() { try { return localStorage.getItem(JOIN_KEY); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(JOIN_KEY, v) : localStorage.removeItem(JOIN_KEY); } catch {} },
  };
  const isDesktop = () => !!(window.desktop && window.desktop.getComputerName);
  let joinTimer = null;

  // داخل برنامج الحاسوب نعرض الانضمام بالاسم؛ في المتصفح والهاتف نعرض الدخول العادي
  function showGate() {
    clearTimeout(joinTimer);
    $('login-to-join').hidden = !isDesktop();
    if (!isDesktop() || state.remote) return show('view-login');
    show('view-join');
    const waiting = joinStore.get();
    if (waiting) return pollJoin(waiting);
    setJoinWaiting(false);
    if (!$('join-name').value) window.desktop.getComputerName().then(n => { if (!$('join-name').value) $('join-name').value = n || ''; }).catch(() => {});
  }

  function setJoinWaiting(on, text) {
    $('join-name').disabled = on;
    $('join-submit').hidden = on;
    $('join-msg').classList.toggle('ok', on);
    $('join-msg').textContent = text || (on ? 'بانتظار موافقة صاحب المحل…' : '');
  }

  async function pollJoin(pollToken) {
    setJoinWaiting(true);
    let r;
    try { r = await api('GET', `/api/join/status?token=${encodeURIComponent(pollToken)}`); }
    catch { joinTimer = setTimeout(() => pollJoin(pollToken), 3000); return; }
    if ($('view-join').hidden) return;
    if (r.status === 'approved') {
      joinStore.set(null);
      state.token = r.token; state.me = r.user; store.set(r.token);
      reportUnread.last = null;
      setJoinWaiting(false);
      return enter();
    }
    if (r.status === 'pending') { joinTimer = setTimeout(() => pollJoin(pollToken), 2000); return; }
    joinStore.set(null);
    setJoinWaiting(false, r.status === 'rejected' ? 'رُفض الطلب. تحدّث مع صاحب المحل ثم أعد المحاولة.' : 'انتهت مهلة الطلب. اضغط «انضمام» من جديد.');
  }

  $('join-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      const { pollToken } = await api('POST', '/api/join', { name: $('join-name').value });
      joinStore.set(pollToken);
      pollJoin(pollToken);
    } catch (e) { setJoinWaiting(false, errText(e.message)); }
  });
  $('join-to-login').addEventListener('click', () => { clearTimeout(joinTimer); show('view-login'); });
  $('login-to-join').addEventListener('click', showGate);

  // طلبات الانضمام عند صاحب المحل
  async function refreshJoinRequests() {
    const box = $('join-banner');
    if (!state.me || !state.me.isAdmin) { box.hidden = true; return; }
    let list = [];
    try { list = await api('GET', '/api/join/requests'); } catch { return; }
    box.textContent = '';
    for (const r of list) {
      const el = document.createElement('div');
      el.className = 'join-req';
      const t = document.createElement('div');
      t.textContent = `🖥 «${r.name}» يطلب الانضمام`;
      const row = document.createElement('div');
      row.className = 'row';
      for (const [cls, label, approve] of [['accept', 'قبول', true], ['reject', 'رفض', false]]) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = cls; b.textContent = label;
        b.addEventListener('click', async () => {
          try { await api('POST', '/api/join/decide', { id: r.id, approve }); } catch {}
          refreshJoinRequests();
        });
        row.append(b);
      }
      el.append(t, row);
      box.append(el);
    }
    box.hidden = !list.length;
  }

  function gateForm(formId, url, nameId, pinId, errId) {
    $(formId).addEventListener('submit', async ev => {
      ev.preventDefault();
      $(errId).textContent = '';
      try {
        const r = await api('POST', url, { name: $(nameId).value, pin: $(pinId).value });
        state.token = r.token; state.me = r.user; store.set(r.token);
        reportUnread.last = null;
        $(pinId).value = '';
        enter();
      } catch (e) { $(errId).textContent = errText(e.message); }
    });
  }
  gateForm('setup-form', '/api/setup', 'setup-name', 'setup-pin', 'setup-error');
  gateForm('login-form', '/api/login', 'login-name', 'login-pin', 'login-error');

  function logout() {
    const token = state.token;
    if (token) {
      // إنهاء الجلسة على المركز وإيقاف إشعارات هذا الجهاز
      (async () => {
        let endpoint;
        try {
          const sub = await currentSubscription();
          if (sub) { endpoint = sub.endpoint; sub.unsubscribe().catch(() => {}); }
        } catch {}
        try {
          await fetch('/api/logout', {
            method: 'POST', keepalive: true,
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ endpoint }),
          });
        } catch {}
      })();
    }
    saveTokenForWorker(null);
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    if (state.source) state.source.close();
    Object.assign(state, { token: null, me: null, users: [], convs: [], current: null, messages: [], reads: [], source: null });
    store.set(null);
    reportUnread();
    showGate();
  }
  $('logout-btn').addEventListener('click', logout);

  async function enter() {
    show('view-main');
    $('me-name').textContent = state.me.name;
    $('add-user-btn').hidden = !state.me.isAdmin;
    closeChat();
    await refreshLists();
    refreshJoinRequests();
    connect();
    openFromHash();
    setupWorker();
  }

  // ---------- الاتصال الفوري ----------
  function connect() {
    if (state.source) state.source.close();
    const src = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
    state.source = src;
    const setStatus = on => {
      $('status').textContent = on ? 'متصل' : 'جاري إعادة الاتصال…';
      $('status').classList.toggle('off', !on);
    };
    src.addEventListener('open', () => {
      setStatus(true);
      // بعد كل اتصال (أو إعادة اتصال) نجلب ما فاتنا
      refreshLists().catch(() => {});
      refreshJoinRequests();
      if (state.current) loadMessages().catch(() => {});
    });
    src.addEventListener('error', () => {
      setStatus(false);
      // إن رُفض الاتصال نهائيًا (حُذف الحساب أو تغيّرت كلمة سره) نتحقق؛ 401 يعيدنا لشاشة الدخول
      if (src.readyState === EventSource.CLOSED && state.source === src) {
        api('GET', '/api/me').then(() => setTimeout(() => { if (state.source === src) connect(); }, 3000)).catch(() => {});
      }
    });
    src.addEventListener('message', ev => onMessage(JSON.parse(ev.data)));
    src.addEventListener('read', ev => onRead(JSON.parse(ev.data)));
    src.addEventListener('users', () => refreshLists().catch(() => {}));
    src.addEventListener('join', () => refreshJoinRequests());
  }

  function onMessage(m) {
    if (m.convId === state.current) {
      addMessages([m]);
      maybeMarkRead();
    }
    if (m.senderId !== state.me.id && !window.desktop) beep();
    refreshLists().catch(() => {});
  }

  function onRead(r) {
    if (r.convId === state.current) {
      const row = state.reads.find(x => x.userId === r.userId);
      if (row) row.lastReadId = Math.max(row.lastReadId, r.upToId);
      else state.reads.push({ userId: r.userId, lastReadId: r.upToId });
      renderReadMark();
    }
    if (r.userId === state.me.id) refreshLists().catch(() => {});
  }

  // ---------- القائمة ----------
  async function refreshLists() {
    const [users, convs] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/conversations')]);
    state.users = users; state.convs = convs;
    renderList();
    reportUnread();
  }

  function avatar(kind, name) {
    const el = document.createElement('div');
    el.className = `avatar ${kind}`;
    el.textContent = kind === 'group' ? '🏪' : kind === 'computer' ? '🖥' : [...name.trim()][0] || '؟';
    return el;
  }

  function entries() {
    // المحل أولًا، ثم كل الحسابات الأخرى (حتى التي لم تبدأ محادثتها بعد)
    const group = state.convs.find(c => c.kind === 'group');
    const list = [];
    if (group) list.push({ key: `c${group.id}`, kind: 'group', name: group.title, conv: group });
    for (const u of state.users) {
      if (u.id === state.me.id) continue;
      const conv = state.convs.find(c => c.kind === 'direct' && c.otherId === u.id) || null;
      list.push({ key: `u${u.id}`, kind: u.kind, name: u.name, user: u, conv });
    }
    // غير المقروء في الأعلى، مع بقاء «المحل» أولًا
    const rest = list.slice(1).sort((a, b) =>
      ((b.conv && b.conv.unread) ? 1 : 0) - ((a.conv && a.conv.unread) ? 1 : 0) ||
      ((b.conv && b.conv.last && b.conv.last.id) || 0) - ((a.conv && a.conv.last && a.conv.last.id) || 0));
    return list.slice(0, 1).concat(rest);
  }

  function renderList() {
    const ul = $('conv-list');
    ul.textContent = '';
    for (const e of entries()) {
      const li = document.createElement('li');
      li.className = 'conv';
      li.tabIndex = 0;
      if (e.conv) li.dataset.id = e.conv.id;
      if (e.conv && e.conv.id === state.current) li.classList.add('active');
      li.append(avatar(e.kind, e.name));
      const text = document.createElement('div');
      text.className = 'conv-text';
      const name = document.createElement('div');
      name.className = 'conv-name';
      name.textContent = e.name;
      const last = document.createElement('div');
      last.className = 'conv-last';
      const lm = e.conv && e.conv.last;
      last.textContent = lm ? (lm.senderId === state.me.id ? 'أنت: ' : e.kind === 'group' ? `${lm.senderName}: ` : '') + lm.body : 'لا رسائل بعد';
      text.append(name, last);
      li.append(text);
      if (e.conv && e.conv.unread) {
        li.classList.add('has-unread');
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = e.conv.unread;
        li.append(b);
      }
      const open = async () => {
        try {
          const id = e.conv ? e.conv.id : (await api('POST', '/api/direct', { userId: e.user.id })).convId;
          await openConv(id, e.name, e.kind);
        } catch {}
      };
      li.addEventListener('click', open);
      li.addEventListener('keydown', ev => { if (ev.key === 'Enter') open(); });
      ul.append(li);
    }
  }

  function reportUnread() {
    const unread = state.convs.filter(c => c.unread > 0);
    const count = unread.reduce((n, c) => n + c.unread, 0);
    const newest = unread.sort((a, b) => b.last.id - a.last.id)[0];
    const from = newest ? (newest.kind === 'group' ? `${newest.last.senderName} (المحل)` : newest.last.senderName) : null;
    const conv = newest ? newest.id : null;
    document.title = count ? `(${count}) مراسلة المحل` : 'مراسلة المحل';
    const key = `${count}|${from}|${conv}`;
    if (key === reportUnread.last) return;
    reportUnread.last = key;
    try { if (window.desktop && window.desktop.setUnread) window.desktop.setUnread({ count, from, conv }); } catch {}
  }

  // ---------- المحادثة ----------
  async function openConv(id, name, kind) {
    state.current = id;
    state.messages = []; state.reads = [];
    if (!name) {
      const c = state.convs.find(x => x.id === id);
      if (!c) { state.current = null; return; }
      name = c.title;
      kind = c.kind === 'group' ? 'group' : (state.users.find(u => u.id === c.otherId) || {}).kind || 'person';
    }
    $('chat-title').textContent = name;
    $('chat-avatar').replaceWith(Object.assign(avatar(kind, name), { id: 'chat-avatar' }));
    $('messages').textContent = '';
    $('chat-empty').hidden = true;
    $('chat-open').hidden = false;
    $('view-main').classList.add('in-chat');
    renderList();
    await loadMessages();
    if (matchMedia('(min-width: 701px)').matches) $('text').focus();
  }

  function closeChat() {
    state.current = null;
    $('chat-empty').hidden = false;
    $('chat-open').hidden = true;
    $('view-main').classList.remove('in-chat');
  }
  $('back-btn').addEventListener('click', () => { closeChat(); renderList(); });

  async function loadMessages() {
    const conv = state.current;
    const after = state.messages.length ? state.messages[state.messages.length - 1].id : 0;
    const r = await api('GET', `/api/messages?conv=${conv}&after=${after}`);
    if (conv !== state.current) return;
    state.reads = r.reads;
    addMessages(r.messages, after === 0);
    renderReadMark();
    maybeMarkRead();
  }

  const fmtTime = ms => new Date(ms).toLocaleTimeString('ar-DZ', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = ms => new Date(ms).toLocaleDateString('ar-DZ', { weekday: 'long', day: 'numeric', month: 'long' });

  function addMessages(list, initial) {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const isGroup = (state.convs.find(c => c.id === state.current) || {}).kind === 'group';
    let added = false;
    for (const m of list) {
      if (state.messages.some(x => x.id === m.id)) continue; // منع التكرار
      const prev = state.messages[state.messages.length - 1];
      if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
        const d = document.createElement('div');
        d.className = 'day';
        d.textContent = fmtDay(m.createdAt);
        box.append(d);
      }
      state.messages.push(m);
      const mine = m.senderId === state.me.id;
      const el = document.createElement('div');
      el.className = `msg${mine ? ' mine' : ''}${initial ? '' : ' fresh'}`;
      el.dataset.id = m.id;
      if (isGroup && !mine) {
        const s = document.createElement('div');
        s.className = 'sender';
        s.textContent = m.senderName;
        el.append(s);
      }
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = m.body;            // نص فقط، لا HTML أبدًا
      const time = document.createElement('div');
      time.className = 'time';
      time.textContent = fmtTime(m.createdAt);
      el.append(body, time);
      box.append(el);
      added = true;
    }
    if (added) {
      renderReadMark();
      if (initial || nearBottom || list[list.length - 1].senderId === state.me.id) box.scrollTop = box.scrollHeight;
    }
  }

  function renderReadMark() {
    const box = $('messages');
    const old = box.querySelector('.read-mark');
    if (old) old.remove();
    const mine = [...state.messages].reverse().find(m => m.senderId === state.me.id);
    if (!mine) return;
    const others = state.reads.filter(r => r.userId !== state.me.id);
    const seen = others.filter(r => r.lastReadId >= mine.id).length;
    const isGroup = (state.convs.find(c => c.id === state.current) || {}).kind === 'group';
    const mark = document.createElement('div');
    mark.className = `read-mark${seen ? ' seen' : ''}`;
    mark.textContent = isGroup
      ? (seen ? `قرأها ${seen} من ${others.length} ✓✓` : 'أُرسلت ✓')
      : (seen ? 'قُرئت ✓✓' : 'أُرسلت ✓');
    const el = box.querySelector(`.msg[data-id="${mine.id}"]`);
    if (el) el.after(mark);
  }

  function maybeMarkRead() {
    if (!state.current || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const last = state.messages[state.messages.length - 1];
    if (!last) return;
    const c = state.convs.find(x => x.id === state.current);
    const mineRead = (state.reads.find(r => r.userId === state.me.id) || {}).lastReadId || 0;
    if (mineRead >= last.id && !(c && c.unread)) return;
    api('POST', '/api/read', { conv: state.current, upTo: last.id }).catch(() => {});
  }
  document.addEventListener('visibilitychange', maybeMarkRead);
  window.addEventListener('focus', maybeMarkRead);

  // ---------- الإرسال ----------
  async function sendText(body) {
    if (!state.current || !body.trim()) return false;
    try {
      const m = await api('POST', '/api/messages', { conv: state.current, body });
      if (m.convId === state.current) addMessages([m]);
      return true;
    } catch (e) {
      $('text').placeholder = errText(e.message);
      setTimeout(() => { $('text').placeholder = 'اكتب رسالة…'; }, 3000);
      return false;
    }
  }

  const text = $('text');
  const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 140)}px`; };
  text.addEventListener('input', grow);
  text.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('composer').requestSubmit(); }
  });
  $('composer').addEventListener('submit', async ev => {
    ev.preventDefault();
    const body = text.value;
    if (!body.trim()) return;
    text.value = ''; grow();
    if (!(await sendText(body))) { text.value = body; grow(); }
  });
  for (const b of document.querySelectorAll('.quick button')) {
    b.addEventListener('click', () => sendText(b.textContent.trim()));
  }

  // ---------- إضافة حساب (للمدير) ----------
  const pinLabel = () => {
    $('add-pin-label').textContent = $('add-kind').value === 'computer'
      ? 'الرمز (4 أرقام أو أحرف على الأقل)' : 'كلمة السر (6 أحرف أو أرقام على الأقل)';
  };
  $('add-kind').addEventListener('change', pinLabel);
  $('add-user-btn').addEventListener('click', () => { $('add-error').textContent = ''; $('add-form').reset(); pinLabel(); $('add-dialog').showModal(); });
  $('add-cancel').addEventListener('click', () => $('add-dialog').close());
  $('add-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      await api('POST', '/api/users', { name: $('add-name').value, pin: $('add-pin').value, kind: $('add-kind').value });
      $('add-dialog').close();
      await refreshLists();
    } catch (e) { $('add-error').textContent = errText(e.message); }
  });

  // ---------- الإعدادات ----------
  const say = (id, text, ok) => { $(id).textContent = text; $(id).classList.toggle('ok', !!ok); };

  $('settings-btn').addEventListener('click', () => {
    say('mypin-msg', ''); say('accounts-msg', '');
    $('mypin-form').reset();
    $('accounts-section').hidden = !state.me.isAdmin;
    $('where').textContent = state.remote ? 'أنت متصل الآن عبر الإنترنت.' : 'أنت متصل الآن من داخل شبكة المحل.';
    renderAccounts();
    refreshNotifyUi();
    $('settings-dialog').showModal();
  });
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());

  $('mypin-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    try {
      await api('POST', '/api/me/pin', { old: $('mypin-old').value, pin: $('mypin-new').value });
      $('mypin-form').reset();
      say('mypin-msg', 'تم تغيير كلمة السر', true);
    } catch (e) { say('mypin-msg', errText(e.message)); }
  });

  function renderAccounts() {
    const ul = $('accounts');
    ul.textContent = '';
    if (!state.me || !state.me.isAdmin) return;
    for (const u of state.users) {
      const li = document.createElement('li');
      li.className = 'account';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = u.name + ' ';
      const kind = document.createElement('small');
      kind.textContent = u.isAdmin ? 'صاحب المحل' : u.kind === 'computer' ? 'حاسوب' : 'شخص';
      who.append(kind);
      li.append(who);
      if (u.id !== state.me.id) {
        const reset = document.createElement('button');
        reset.type = 'button'; reset.className = 'reset'; reset.textContent = 'كلمة سر جديدة';
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'delete'; del.textContent = 'حذف';
        reset.addEventListener('click', () => {
          if (li.querySelector('.edit')) return;
          const edit = document.createElement('div');
          edit.className = 'edit';
          const input = document.createElement('input');
          input.maxLength = 64;
          input.placeholder = u.kind === 'computer' ? '4 على الأقل' : '6 على الأقل';
          const save = document.createElement('button');
          save.type = 'button'; save.className = 'save'; save.textContent = 'حفظ';
          save.addEventListener('click', async () => {
            try {
              await api('POST', '/api/users/pin', { userId: u.id, pin: input.value });
              edit.remove();
              say('accounts-msg', `تم تغيير كلمة سر «${u.name}»`, true);
            } catch (e) { say('accounts-msg', errText(e.message)); }
          });
          edit.append(input, save);
          li.append(edit);
          input.focus();
        });
        del.addEventListener('click', async () => {
          if (!del.classList.contains('armed')) {          // نقرتان: الأولى تطلب التأكيد
            del.classList.add('armed');
            del.textContent = 'تأكيد الحذف؟';
            setTimeout(() => { del.classList.remove('armed'); del.textContent = 'حذف'; }, 4000);
            return;
          }
          try {
            await api('POST', '/api/users/delete', { userId: u.id });
            await refreshLists();
            renderAccounts();
            say('accounts-msg', `تم حذف «${u.name}»`, true);
          } catch (e) { say('accounts-msg', errText(e.message)); }
        });
        li.append(reset, del);
      }
      ul.append(li);
    }
  }

  // ---------- إشعارات الهاتف ----------
  const pushSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function saveTokenForWorker(token) {
    try {
      if (!('caches' in window)) return;
      const cache = await caches.open('messenger-auth');
      if (token) await cache.put('/__token', new Response(token)); else await cache.delete('/__token');
    } catch {}
  }

  async function currentSubscription() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
  }

  async function setupWorker() {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('sw.js');
      await saveTokenForWorker(state.token);
      // إن كان هذا الجهاز مشتركًا من قبل، نربطه بالحساب الحالي
      const sub = await currentSubscription();
      if (sub && Notification.permission === 'granted') await api('POST', '/api/push/subscribe', { endpoint: sub.endpoint });
    } catch {}
  }

  async function refreshNotifyUi() {
    const section = $('notify-section');
    if (window.desktop) { section.hidden = true; return; }       // برنامج الحاسوب له الدائرة العائمة
    section.hidden = false;
    const btn = $('notify-btn'), msg = $('notify-msg');
    btn.hidden = true;
    if (!pushSupported()) {
      msg.textContent = window.isSecureContext
        ? 'هذا المتصفح لا يدعم الإشعارات. على آيفون: أضف التطبيق إلى الشاشة الرئيسية أولًا ثم افتحه من هناك.'
        : 'الإشعارات تعمل فقط عند فتح التطبيق من رابط الإنترنت الآمن (https) وليس من عنوان الشبكة المحلية.';
      return;
    }
    if (Notification.permission === 'denied') {
      msg.textContent = 'الإشعارات محظورة لهذا الموقع من إعدادات المتصفح. اسمح بها من هناك ثم أعد المحاولة.';
      return;
    }
    const sub = await currentSubscription().catch(() => null);
    if (sub && Notification.permission === 'granted') { msg.textContent = 'الإشعارات مفعّلة على هذا الجهاز ✓'; return; }
    msg.textContent = 'فعّل الإشعارات لتصلك الرسائل والتطبيق مغلق.';
    btn.hidden = false;
  }

  $('notify-btn').addEventListener('click', async () => {
    const msg = $('notify-msg');
    try {
      if ((await Notification.requestPermission()) !== 'granted') return refreshNotifyUi();
      const reg = await navigator.serviceWorker.ready;
      const { key } = await api('GET', '/api/push/key');
      const pad = '='.repeat((4 - (key.length % 4)) % 4);
      const raw = Uint8Array.from(atob((key + pad).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
      await api('POST', '/api/push/subscribe', { endpoint: sub.endpoint });
      refreshNotifyUi();
    } catch (e) {
      msg.textContent = 'تعذّر تفعيل الإشعارات على هذا الجهاز.';
    }
  });

  // ---------- فتح محادثة من الرابط (#conv=رقم) ----------
  function openFromHash() {
    const m = /^#conv=(\d+)$/.exec(location.hash);
    if (!m || !state.me) return;
    history.replaceState(null, '', location.pathname);
    const id = Number(m[1]);
    if (state.convs.some(c => c.id === id)) openConv(id).catch(() => {});
  }
  window.addEventListener('hashchange', openFromHash);

  // ---------- صوت بسيط للمتصفح والهاتف ----------
  let audio;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35);
      o.connect(g).connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.35);
    } catch {}
  }

  init();
})();
