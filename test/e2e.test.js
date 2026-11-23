import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/server.js';

const emit = (sock, event, payload = {}) =>
  new Promise((resolve) => sock.emit(event, payload, resolve));
const once = (sock, event) => new Promise((resolve) => sock.once(event, resolve));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const ctx = createApp();
  await new Promise((r) => ctx.server.listen(0, r));
  const url = `http://localhost:${ctx.server.address().port}`;
  const clients = [];
  const client = async () => {
    const s = connect(url, { transports: ['websocket'], forceNew: true });
    clients.push(s);
    await once(s, 'connect');
    return s;
  };
  const close = async () => {
    clients.forEach((c) => c.close());
    ctx.manager.shutdown();
    await new Promise((r) => ctx.io.close(r));
  };
  return { ...ctx, url, client, close };
}

const questions = [
  { item: 'ساعة أوميغا', left: 'نادر', right: 'منتشر', target: 40 },
  { item: 'الكبسة', left: 'مكروه', right: 'محبوب', target: 80, timeSec: 10 },
];

test('لعبة كاملة عبر Socket.IO: مضيف ولاعبان ودردشة وكشف ونهاية', async () => {
  const s = await boot();
  try {
    const host = await s.client();
    const created = await emit(host, 'room:create', {
      name: 'غرفة الاختبار', isPublic: true, teamSize: 1, totalRounds: 2, questions,
    });
    assert.equal(created.ok, true);
    const { code } = created;

    // الغرفة العامة تظهر في القائمة، والهدف لا يُرسل للاعبين
    const list = await (await fetch(`${s.url}/api/rooms/public`)).json();
    assert.equal(list.rooms[0].code, code);
    assert.equal(list.rooms[0].status, 'waiting');

    const p1 = await s.client();
    const p2 = await s.client();
    const j1 = await emit(p1, 'room:join', { code, name: 'أحمد', avatar: 'penguin', team: 'red' });
    const j2 = await emit(p2, 'room:join', { code: code.toLowerCase(), name: 'سارة', avatar: 'fox', team: 'blue' });
    assert.equal(j1.ok && j2.ok, true);
    assert.equal(
      (await emit(p2, 'room:join', { code, name: 'x', avatar: 'fox', team: 'blue' })).error,
      'already_in_room'
    );

    // لاعب ليس مضيفًا لا يستطيع بدء اللعبة
    assert.equal((await emit(p1, 'host:start')).error, 'not_host');

    const states = [];
    p1.on('room:state', (st) => states.push(st));
    const moves = [];
    p2.on('round:marker', (m) => moves.push(m));

    assert.equal((await emit(host, 'host:start')).ok, true);
    await wait(50);
    const live = states.at(-1);
    assert.equal(live.phase, 'playing');
    assert.equal(JSON.stringify(live).includes('"target"'), false, 'الهدف مسرّب قبل الكشف');

    // الجميع يرى مؤشرات الآخرين مباشرة
    assert.equal((await emit(p1, 'player:move', { pos: 41 })).ok, true);
    await wait(50);
    assert.deepEqual(moves.at(-1), { playerId: j1.playerId, pos: 41 });
    assert.equal((await emit(p1, 'player:lock', { pos: 41 })).ok, true);
    assert.equal((await emit(p2, 'player:move', { pos: 60 })).ok, true);
    assert.equal((await emit(p2, 'player:lock')).ok, true);
    await wait(50);
    const reveal = states.at(-1);
    assert.equal(reveal.phase, 'reveal');
    assert.equal(reveal.round.question.target, 40);
    assert.equal(reveal.teams.red.score, 5); // 4 + بونص الأقرب
    assert.equal(reveal.teams.blue.score, 0);

    // دردشة: الفريق لا يصل للفريق الآخر
    const got1 = [];
    const got2 = [];
    p1.on('chat:message', (m) => got1.push(m));
    p2.on('chat:message', (m) => got2.push(m));
    assert.equal((await emit(p1, 'chat:send', { channel: 'team', text: 'سرّ الفريق' })).ok, true);
    assert.equal((await emit(host, 'chat:send', { channel: 'room', text: 'أهلًا بالجميع' })).ok, true);
    await wait(50);
    assert.deepEqual(got1.map((m) => m.text), ['سرّ الفريق', 'أهلًا بالجميع']);
    assert.deepEqual(got2.map((m) => m.text), ['أهلًا بالجميع']);

    // الجولة الثانية ثم النهاية
    assert.equal((await emit(host, 'host:nextRound')).ok, true);
    await emit(p1, 'player:move', { pos: 10 });
    await emit(p1, 'player:lock');
    await emit(p2, 'player:move', { pos: 80 });
    await emit(p2, 'player:lock');
    assert.equal((await emit(host, 'host:nextRound')).ok, true);
    await wait(50);
    const end = states.at(-1);
    assert.equal(end.phase, 'finished');
    assert.equal(end.winner, 'tie'); // 5 مقابل 5

    // جولة فاصلة: المضيف يضيف سؤالًا ثم يبدأها
    assert.equal((await emit(host, 'host:tiebreaker')).error, 'no_question');
    assert.equal(
      (await emit(host, 'host:addQuestion', { question: { item: 'القهوة', left: 'مرّة', right: 'حلوة', target: 30 } })).ok,
      true
    );
    assert.equal((await emit(host, 'host:tiebreaker')).ok, true);
    await emit(p1, 'player:move', { pos: 90 });
    await emit(p1, 'player:lock');
    await emit(p2, 'player:move', { pos: 31 });
    await emit(p2, 'player:lock');
    assert.equal((await emit(host, 'host:nextRound')).ok, true);
    await wait(50);
    assert.equal(states.at(-1).winner, 'blue');
  } finally {
    await s.close();
  }
});

test('العودة بعد الانقطاع، الطرد مع الحظر، وقفل الغرفة', async () => {
  const s = await boot();
  try {
    const host = await s.client();
    const { code, hostToken } = await emit(host, 'room:create', {
      name: 'غرفة', isPublic: false, teamSize: 2, totalRounds: 2, questions,
    });
    const p1 = await s.client();
    const j1 = await emit(p1, 'room:join', { code, name: 'أحمد', avatar: 'bear', team: 'red' });

    // انقطاع ثم عودة بالرمز
    p1.close();
    await wait(80);
    const p1b = await s.client();
    const back = await emit(p1b, 'room:rejoin', { code, token: j1.token });
    assert.equal(back.ok, true);
    assert.equal(back.playerId, j1.playerId);
    assert.equal(back.state.players[0].connected, true);
    assert.equal((await emit(await s.client(), 'room:rejoin', { code, token: 'bad' })).error, 'bad_token');

    // المضيف يعود برمزه
    host.close();
    await wait(80);
    const host2 = await s.client();
    assert.equal((await emit(host2, 'host:rejoin', { code, hostToken: 'bad' })).error, 'bad_token');
    assert.equal((await emit(host2, 'host:rejoin', { code, hostToken })).ok, true);

    // قفل الغرفة يمنع الدخول
    await emit(host2, 'host:lockRoom', { locked: true });
    const late = await s.client();
    assert.equal((await emit(late, 'room:join', { code, name: 'متأخر', avatar: 'owl', team: 'blue' })).error, 'room_locked');
    await emit(host2, 'host:lockRoom', { locked: false });

    // طرد مع حظر: يصله الإشعار ولا يستطيع الدخول ثانية
    const kickedMsg = once(p1b, 'room:kicked');
    assert.equal((await emit(host2, 'host:kick', { playerId: j1.playerId, ban: true })).ok, true);
    assert.deepEqual(await kickedMsg, { ban: true });
    const again = await s.client();
    assert.equal((await emit(again, 'room:join', { code, name: 'أحمد2', avatar: 'bear', team: 'red' })).error, 'banned');

    // رسائل غير صالحة لا تُسقط الخادم
    assert.equal((await emit(again, 'room:join', { code, name: '', avatar: 'bear', team: 'red' })).ok, false);
    assert.equal((await emit(again, 'room:join', 'نص بدل كائن')).ok, false);
    assert.equal((await emit(again, 'host:addQuestion', { question: { item: 1 } })).ok, false);

    // الإغلاق من المضيف
    const closed = once(again, 'room:closed');
    await emit(again, 'room:join', { code, name: 'ثالث', avatar: 'seal', team: 'blue' }).catch(() => {});
    assert.equal((await emit(host2, 'host:close')).ok, true);
    assert.equal(s.manager.get(code), null);
    void closed;
  } finally {
    await s.close();
  }
});
