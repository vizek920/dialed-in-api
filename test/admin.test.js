import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/server.js';
import { MemoryHostStore } from '../src/auth/hostStore.js';

async function boot() {
  const hostStore = new MemoryHostStore([
    { username: 'host1', password: 'host-pass-1', role: 'host' },
    { username: 'host2', password: 'host-pass-2', role: 'host' },
    { username: 'mod1', password: 'mod-pass-123', role: 'moderator' },
    { username: 'boss', password: 'boss-pass-123', role: 'admin' },
  ]);
  const ctx = createApp({ hostStore });
  await new Promise((r) => ctx.server.listen(0, r));
  const url = `http://localhost:${ctx.server.address().port}`;
  const sockets = [];

  const call = async (token, method, path, body) => {
    const res = await fetch(`${url}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  const login = async (username, password) => (await call(null, 'POST', '/host/login', { username, password })).token;
  const tokens = {
    host1: await login('host1', 'host-pass-1'),
    host2: await login('host2', 'host-pass-2'),
    mod: await login('mod1', 'mod-pass-123'),
    boss: await login('boss', 'boss-pass-123'),
  };
  const socket = async () => {
    const s = connect(url, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r) => s.once('connect', r));
    return s;
  };
  const emit = (s, event, payload = {}) => new Promise((r) => s.emit(event, payload, r));
  const close = async () => {
    sockets.forEach((s) => s.close());
    ctx.manager.shutdown();
    await new Promise((r) => ctx.io.close(r));
  };
  return { ...ctx, url, call, tokens, socket, emit, close };
}

const q = (over = {}) => ({ item: 'سؤال اختبار', left: 'قليل', right: 'كثير', target: 50, ...over });

test('الصلاحيات: بلا رمز 401، المضيف لا يدخل الإدارة، المشرف لا يدير الحسابات', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call(null, 'GET', '/admin/rooms')).status, 401);
    assert.equal((await s.call(null, 'GET', '/bank/categories')).status, 401);
    assert.equal((await s.call(s.tokens.host1, 'GET', '/admin/rooms')).status, 403);
    assert.equal((await s.call(s.tokens.host1, 'GET', '/admin/hosts')).status, 403);
    assert.equal((await s.call(s.tokens.mod, 'GET', '/admin/rooms')).status, 200);
    assert.equal((await s.call(s.tokens.mod, 'GET', '/admin/hosts')).status, 403);
    assert.equal((await s.call(s.tokens.mod, 'POST', '/admin/bank', q())).status, 403);
    assert.equal((await s.call(s.tokens.boss, 'GET', '/admin/hosts')).status, 200);
    assert.equal((await s.call('a.b.c', 'GET', '/admin/rooms')).status, 401);
  } finally {
    await s.close();
  }
});

test('رحلة الاقتراح: قائمتي → اقتراح → رفض بسبب → تعديل وإعادة اقتراح → اعتماد → يظهر في البنك', async () => {
  const s = await boot();
  try {
    const cats = (await s.call(s.tokens.host1, 'GET', '/bank/categories')).categories;
    assert.equal(cats.length, 5);
    assert.ok(cats.every((c) => c.count > 0));
    const bank0 = (await s.call(s.tokens.host1, 'GET', '/bank/questions')).questions;
    assert.equal(bank0.length, 12);
    assert.equal('ownerId' in bank0[0], false);
    const filtered = (await s.call(s.tokens.host1, 'GET', `/bank/questions?categoryId=${cats[0].id}`)).questions;
    assert.ok(filtered.length > 0 && filtered.length < 12);
    assert.equal((await s.call(s.tokens.host1, 'GET', '/bank/questions?q=الكبسة')).questions.length, 1);

    // سؤال غير صالح يُرفض
    assert.equal((await s.call(s.tokens.host1, 'POST', '/bank/mine', q({ target: 3 }))).error, 'bad_target');

    const mine = (await s.call(s.tokens.host1, 'POST', '/bank/mine', q())).question;
    assert.equal(mine.status, 'private');
    // لا يراه غيره
    assert.equal((await s.call(s.tokens.host2, 'GET', '/bank/mine')).questions.length, 0);
    assert.equal((await s.call(s.tokens.host2, 'PATCH', `/bank/mine/${mine.id}`, { item: 'x' })).error, 'not_found');
    assert.equal((await s.call(s.tokens.host2, 'POST', `/bank/mine/${mine.id}/suggest`, { categoryId: cats[0].id })).error, 'not_found');

    // اقتراح بتصنيف غير موجود يفشل، وبتصنيف صحيح ينجح
    assert.equal((await s.call(s.tokens.host1, 'POST', `/bank/mine/${mine.id}/suggest`, { categoryId: 'zzz' })).error, 'bad_category');
    const sug = await s.call(s.tokens.host1, 'POST', `/bank/mine/${mine.id}/suggest`, { categoryId: cats[0].id });
    assert.equal(sug.question.status, 'pending');
    // المعلّق مقفل للتعديل، ولا يُقترح مرتين
    assert.equal((await s.call(s.tokens.host1, 'PATCH', `/bank/mine/${mine.id}`, { item: 'جديد' })).error, 'question_locked');
    assert.equal((await s.call(s.tokens.host1, 'POST', `/bank/mine/${mine.id}/suggest`, { categoryId: cats[0].id })).error, 'question_locked');

    // المشرف يرى المقترح ويرفضه
    const pend = (await s.call(s.tokens.mod, 'GET', '/admin/suggestions')).questions;
    assert.equal(pend.length, 1);
    assert.equal(pend[0].ownerName, 'host1');
    assert.equal(pend[0].categoryName, cats[0].name);
    assert.equal((await s.call(s.tokens.host1, 'POST', `/admin/questions/${mine.id}/reject`, {})).status, 403);
    const rej = await s.call(s.tokens.mod, 'POST', `/admin/questions/${mine.id}/reject`, { reason: 'مكرر' });
    assert.equal(rej.question.status, 'rejected');
    assert.equal((await s.call(s.tokens.mod, 'POST', `/admin/questions/${mine.id}/reject`, {})).error, 'bad_status');

    // صاحبه يرى السبب ويعدّل ويعيد الاقتراح
    const mineList = (await s.call(s.tokens.host1, 'GET', '/bank/mine')).questions;
    assert.equal(mineList[0].status, 'rejected');
    assert.equal(mineList[0].rejectReason, 'مكرر');
    const edited = await s.call(s.tokens.host1, 'PATCH', `/bank/mine/${mine.id}`, { item: 'سؤال معدّل' });
    assert.equal(edited.question.status, 'private');
    await s.call(s.tokens.host1, 'POST', `/bank/mine/${mine.id}/suggest`, { categoryId: cats[1].id });

    // المشرف يعتمده مع تغيير التصنيف
    const ok = await s.call(s.tokens.mod, 'POST', `/admin/questions/${mine.id}/approve`, { categoryId: cats[2].id });
    assert.equal(ok.question.status, 'approved');
    assert.equal(ok.question.categoryId, cats[2].id);
    const bank1 = (await s.call(s.tokens.host2, 'GET', '/bank/questions')).questions;
    assert.equal(bank1.length, 13);
    // المعتمد لا يُحذف من صاحبه
    assert.equal((await s.call(s.tokens.host1, 'DELETE', `/bank/mine/${mine.id}`)).error, 'question_locked');
  } finally {
    await s.close();
  }
});

test('المدير: التصنيفات وبنك الأسئلة', async () => {
  const s = await boot();
  try {
    const b = s.tokens.boss;
    assert.equal((await s.call(b, 'POST', '/admin/categories', { name: 'x' })).error, 'bad_category_name');
    assert.equal((await s.call(b, 'POST', '/admin/categories', { name: 'حيوانات' })).error, 'category_exists');
    const cat = (await s.call(b, 'POST', '/admin/categories', { name: 'رياضة' })).category;
    assert.equal((await s.call(b, 'PATCH', `/admin/categories/${cat.id}`, { name: 'رياضة وألعاب' })).category.name, 'رياضة وألعاب');

    const made = (await s.call(b, 'POST', '/admin/bank', q({ categoryId: cat.id }))).question;
    assert.equal(made.status, 'approved');
    assert.equal((await s.call(b, 'POST', '/admin/bank', q({ categoryId: 'nope' }))).error, 'bad_category');
    assert.equal((await s.call(b, 'PATCH', `/admin/bank/${made.id}`, { target: 10, zoneWidth: 8 })).error, 'bad_target');
    assert.equal((await s.call(b, 'PATCH', `/admin/bank/${made.id}`, { item: 'معدّل', timeSec: 60 })).question.timeSec, 60);

    // تصنيف معطّل لا يظهر للمضيفين
    await s.call(b, 'PATCH', `/admin/categories/${cat.id}`, { isActive: false });
    const visible = (await s.call(s.tokens.host1, 'GET', '/bank/categories')).categories.map((c) => c.id);
    assert.equal(visible.includes(cat.id), false);

    // حذف التصنيف يُبقي أسئلته بلا تصنيف
    assert.equal((await s.call(b, 'DELETE', `/admin/categories/${cat.id}`)).ok, true);
    const orphans = (await s.call(b, 'GET', '/admin/bank?categoryId=none')).questions;
    assert.equal(orphans.length, 1);
    assert.equal((await s.call(b, 'DELETE', `/admin/bank/${made.id}`)).ok, true);
    assert.equal((await s.call(b, 'DELETE', `/admin/bank/${made.id}`)).error, 'not_found');
  } finally {
    await s.close();
  }
});

test('المدير: إدارة الحسابات وإيقاف مضيف يغلق غرفه فورًا', async () => {
  const s = await boot();
  try {
    const b = s.tokens.boss;
    assert.equal((await s.call(b, 'POST', '/admin/hosts', { username: 'A', password: '12345678' })).error, 'bad_username');
    assert.equal((await s.call(b, 'POST', '/admin/hosts', { username: 'newhost', password: 'short' })).error, 'bad_password');
    assert.equal((await s.call(b, 'POST', '/admin/hosts', { username: 'host1', password: '12345678' })).error, 'username_taken');
    assert.equal((await s.call(b, 'POST', '/admin/hosts', { username: 'newhost', password: '12345678', role: 'king' })).error, 'bad_role');
    const created = (await s.call(b, 'POST', '/admin/hosts', { username: 'newhost', password: 'new-pass-123', displayName: 'المضيف الجديد' })).host;
    assert.equal(created.role, 'host');
    assert.equal('passwordHash' in created, false);
    const t = (await s.call(null, 'POST', '/host/login', { username: 'newhost', password: 'new-pass-123' })).token;
    assert.ok(t);

    // يملك غرفة حية
    const sock = await s.socket();
    const room = await s.emit(sock, 'room:create', { auth: t, name: 'غرفة', teamSize: 1, totalRounds: 1, questions: [q()] });
    assert.equal(room.ok, true);

    // لا يستطيع المدير إيقاف نفسه أو تغيير دوره
    const me = (await s.call(b, 'GET', '/admin/hosts')).hosts.find((h) => h.username === 'boss');
    assert.equal((await s.call(b, 'PATCH', `/admin/hosts/${me.id}`, { isBanned: true })).error, 'cannot_change_self');
    assert.equal((await s.call(b, 'PATCH', `/admin/hosts/${me.id}`, { role: 'host' })).error, 'cannot_change_self');

    // الإيقاف: الغرفة تُغلق، والرمز القديم يتوقف، ولا دخول جديد
    const banned = await s.call(b, 'PATCH', `/admin/hosts/${created.id}`, { isBanned: true });
    assert.equal(banned.host.isBanned, true);
    assert.equal(s.manager.get(room.code), null);
    assert.equal((await s.call(t, 'GET', '/bank/mine')).status, 401);
    assert.equal((await s.call(null, 'POST', '/host/login', { username: 'newhost', password: 'new-pass-123' })).status, 401);
    const sock2 = await s.socket();
    assert.equal((await s.emit(sock2, 'room:create', { auth: t, name: 'غرفة', teamSize: 1, totalRounds: 1, questions: [q()] })).error, 'unauthorized');

    // رفع الإيقاف وتغيير كلمة المرور
    await s.call(b, 'PATCH', `/admin/hosts/${created.id}`, { isBanned: false, password: 'another-pass-1' });
    assert.ok((await s.call(null, 'POST', '/host/login', { username: 'newhost', password: 'another-pass-1' })).token);
    assert.equal((await s.call(null, 'POST', '/host/login', { username: 'newhost', password: 'new-pass-123' })).status, 401);
  } finally {
    await s.close();
  }
});

test('الإدارة الحية للغرف: عرض، كتم، طرد مع حظر، قفل، إغلاق', async () => {
  const s = await boot();
  try {
    const host = await s.socket();
    const created = await s.emit(host, 'room:create', { auth: s.tokens.host1, name: 'غرفة حية', isPublic: false, teamSize: 2, totalRounds: 1, questions: [q()] });
    const code = created.code;
    const p = await s.socket();
    const j = await s.emit(p, 'room:join', { code, name: 'أحمد', avatar: 'owl', team: 'red' });

    const list = (await s.call(s.tokens.mod, 'GET', '/admin/rooms')).rooms;
    assert.equal(list.length, 1);
    assert.equal(list[0].ownerName, 'host1');
    assert.equal(list[0].isPublic, false);
    assert.equal(list[0].players[0].name, 'أحمد');
    const ov = await s.call(s.tokens.mod, 'GET', '/admin/overview');
    assert.equal(ov.rooms, 1);
    assert.equal(ov.players, 1);

    assert.equal((await s.call(s.tokens.mod, 'POST', `/admin/rooms/${code}/players/${j.playerId}/mute`, { muted: true })).ok, true);
    assert.equal((await s.emit(p, 'chat:send', { channel: 'room', text: 'مرحبا' })).error, 'muted');
    assert.equal((await s.call(s.tokens.mod, 'POST', `/admin/rooms/${code}/players/nope/mute`, { muted: true })).error, 'no_player');

    assert.equal((await s.call(s.tokens.mod, 'POST', `/admin/rooms/${code}/lock`, { locked: true })).ok, true);
    const late = await s.socket();
    assert.equal((await s.emit(late, 'room:join', { code, name: 'متأخر', avatar: 'fox', team: 'blue' })).error, 'room_locked');

    const kicked = new Promise((r) => p.once('room:kicked', r));
    assert.equal((await s.call(s.tokens.mod, 'POST', `/admin/rooms/${code}/players/${j.playerId}/kick`, { ban: true })).ok, true);
    assert.deepEqual(await kicked, { ban: true });

    const closed = new Promise((r) => host.once('room:closed', r));
    assert.equal((await s.call(s.tokens.mod, 'POST', `/admin/rooms/${code}/close`)).ok, true);
    assert.equal((await closed).reason, 'admin_closed');
    assert.equal((await s.call(s.tokens.mod, 'POST', `/admin/rooms/${code}/close`)).error, 'no_room');
    assert.equal((await s.call(s.tokens.mod, 'GET', '/admin/rooms')).rooms.length, 0);
  } finally {
    await s.close();
  }
});
