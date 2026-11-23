import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/game/Room.js';
import { RoomManager } from '../src/game/roomManager.js';
import { validateQuestion, validateRoomSettings } from '../src/game/validate.js';
import { GameError } from '../src/game/errors.js';

const Q = (over = {}) => ({ item: 'ساعة أوميغا', left: 'نادر', right: 'منتشر', target: 40, ...over });
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof GameError, String(e));
    return e.code;
  }
  return null;
};

function makeRoom(over = {}) {
  const raw = over.questions || [Q(), Q({ target: 60 }), Q({ target: 30 }), Q({ target: 70 })];
  const room = new Room({
    code: 'TEST1',
    name: 'غرفة',
    isPublic: false,
    teamSize: 2,
    totalRounds: 4,
    ...over,
    questions: raw.map(validateQuestion),
  });
  room.attachHost('hostsock');
  return room;
}
const join = (room, name, team) =>
  room.addPlayer({ name, avatar: 'penguin', team, socketId: 's-' + name });

test('التحقق من السؤال والإعدادات', () => {
  assert.equal(validateQuestion(Q()).timeSec, 40);
  assert.equal(code(() => validateQuestion(Q({ target: 5 }))), 'bad_target');
  assert.equal(code(() => validateQuestion(Q({ left: '' }))), 'bad_question');
  assert.equal(code(() => validateQuestion(Q({ points: [1, 2, 3] }))), 'bad_question');
  assert.equal(code(() => validateQuestion(Q({ timeSec: 5 }))), 'bad_question');
  assert.equal(code(() => validateRoomSettings({ name: 'x', teamSize: 2, totalRounds: 3 })), 'bad_room_name');
  assert.equal(code(() => validateRoomSettings({ name: 'غرفة', teamSize: 0, totalRounds: 3 })), 'bad_team_size');
});

test('انضمام اللاعبين: تكرار الاسم وامتلاء الفريق والقفل', () => {
  const room = makeRoom();
  join(room, 'أحمد', 'red');
  assert.equal(code(() => join(room, 'أحمد', 'blue')), 'name_taken');
  join(room, 'سارة', 'red');
  assert.equal(code(() => join(room, 'نورة', 'red')), 'team_full');
  assert.equal(code(() => room.addPlayer({ name: 'خالد', avatar: 'x', team: 'blue' })), 'bad_avatar');
  room.setLocked(true);
  assert.equal(code(() => join(room, 'خالد', 'blue')), 'room_locked');
});

test('الهدف المخفي لا يظهر قبل الكشف ويظهر بعده', () => {
  const room = makeRoom();
  join(room, 'أحمد', 'red');
  join(room, 'سارة', 'blue');
  room.startGame();
  assert.equal('target' in room.toState().round.question, false);
  assert.equal(JSON.stringify(room.toState()).includes('"target"'), false);
  const [a, b] = room.playerList();
  room.move(a.id, 40);
  room.lock(a.id);
  assert.equal(room.phase, 'playing');
  room.move(b.id, 55);
  room.lock(b.id);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.toState().round.question.target, 40);
});

test('جولة كاملة: النقاط والبونص ومجموع الفريق', () => {
  const room = makeRoom();
  const a = join(room, 'أحمد', 'red');
  const b = join(room, 'سارة', 'blue');
  room.startGame();
  room.move(a.id, 40); // في الوسط = 4 + 1 بونص
  room.move(b.id, 46); // النطاق المجاور = 3
  room.lock(a.id);
  room.lock(b.id);
  assert.equal(a.score, 5);
  assert.equal(b.score, 3);
  assert.deepEqual(room.toState().teams, { red: { score: 5 }, blue: { score: 3 } });
});

test('لا يحرّك المؤشر إلا لاعب الدور، ولا قبل التحريك التثبيت', () => {
  const room = makeRoom();
  const a1 = join(room, 'أحمد', 'red');
  const a2 = join(room, 'سارة', 'red');
  const b1 = join(room, 'نورة', 'blue');
  room.startGame();
  assert.equal(code(() => room.move(a2.id, 50)), 'not_your_turn');
  assert.equal(code(() => room.lock(a1.id)), 'move_first');
  assert.equal(code(() => room.move(a1.id, NaN)), 'bad_position');
  room.move(b1.id, 500); // يُقص إلى 100
  assert.equal(room.round.markers[b1.id].pos, 100);
});

test('تناوب الأدوار بعدالة داخل الفريق', () => {
  const room = makeRoom({ totalRounds: 4 });
  const a1 = join(room, 'أحمد', 'red');
  const a2 = join(room, 'سارة', 'red');
  const b1 = join(room, 'نورة', 'blue');
  const seen = [];
  room.startGame();
  for (let i = 0; i < 4; i += 1) {
    seen.push(room.round.players.red);
    room.move(room.round.players.red, 40);
    room.lock(room.round.players.red);
    room.move(b1.id, 40);
    room.lock(b1.id);
    room.nextRound();
  }
  assert.deepEqual(seen, [a1.id, a2.id, a1.id, a2.id]);
});

test('انتهاء الوقت يثبّت تلقائيًا: من لم يحرّك يأخذ صفرًا', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    const room = makeRoom();
    const a = join(room, 'أحمد', 'red');
    const b = join(room, 'سارة', 'blue');
    room.startGame();
    room.move(b.id, 40);
    mock.timers.tick(39_000);
    assert.equal(room.phase, 'playing');
    mock.timers.tick(1_000);
    assert.equal(room.phase, 'reveal');
    assert.equal(a.score, 0);
    assert.equal(b.score, 5);
    assert.equal(room.round.markers[b.id].locked, true);
    assert.equal(code(() => room.move(b.id, 10)), 'not_your_turn');
  } finally {
    mock.timers.reset();
  }
});

test('اللاعب المتأخر يدخل الدورة من الجولة التالية فقط', () => {
  const room = makeRoom({ teamSize: 3 });
  const a1 = join(room, 'أحمد', 'red');
  const b1 = join(room, 'نورة', 'blue');
  room.startGame();
  const late = join(room, 'متأخر', 'red');
  assert.equal(room.round.players.red, a1.id);
  assert.equal(code(() => room.move(late.id, 40)), 'not_your_turn');
  room.move(a1.id, 40); room.lock(a1.id);
  room.move(b1.id, 40); room.lock(b1.id);
  room.nextRound();
  assert.equal(room.round.players.red, late.id); // دوره الآن لأنه لم يلعب بعد
});

test('الطرد: تبقى نقاطه للفريق، وطرد صاحب الدور يُنهي أو يكمل الجولة', () => {
  const room = makeRoom();
  const a = join(room, 'أحمد', 'red');
  const b = join(room, 'سارة', 'blue');
  room.startGame();
  room.move(a.id, 40); room.lock(a.id);
  room.move(b.id, 40); room.lock(b.id);
  const kicked = [];
  room.on('kicked', (k) => kicked.push(k));
  room.kick(a.id, true);
  assert.equal(room.players.has(a.id), false);
  assert.equal(room.teamScore('red'), 5);
  assert.equal(kicked[0].ban, true);

  const room2 = makeRoom();
  const a2 = join(room2, 'أحمد', 'red');
  const b2 = join(room2, 'سارة', 'blue');
  room2.startGame();
  room2.move(b2.id, 40); room2.lock(b2.id);
  room2.kick(a2.id); // الوحيد غير المثبّت يُطرد → تنتهي الجولة
  assert.equal(room2.phase, 'reveal');
});

test('تخطي دور لاعب غائب', () => {
  const room = makeRoom();
  const a1 = join(room, 'أحمد', 'red');
  const a2 = join(room, 'سارة', 'red');
  const b1 = join(room, 'نورة', 'blue');
  room.startGame();
  assert.equal(room.round.players.red, a1.id);
  room.skipTurn('red');
  assert.equal(room.round.players.red, a2.id);
  assert.ok(room.round.markers[a2.id]);
  assert.equal(room.round.markers[a1.id], undefined);
  room.skipTurn('red'); // لا بديل: يبقى بلا لاعب
  assert.ok(room.round.players.red === a1.id || room.round.players.red === null);
  assert.ok(b1);
});

test('الانقطاع والعودة بالرمز السري', () => {
  const room = makeRoom();
  const a = join(room, 'أحمد', 'red');
  room.onPlayerDisconnected(a.id, 's-أحمد');
  assert.equal(room.players.get(a.id).connected, false);
  assert.equal(code(() => room.reconnect('خطأ', 'new')), 'bad_token');
  room.reconnect(a.token, 'new');
  assert.equal(room.players.get(a.id).connected, true);
  room.onPlayerDisconnected(a.id, 's-أحمد'); // مقبس قديم: يُتجاهل
  assert.equal(room.players.get(a.id).connected, true);
});

test('نهاية اللعبة والفائز والتعادل وجولة فاصلة', () => {
  const room = makeRoom({ totalRounds: 1, questions: [Q(), Q({ target: 50 })] });
  const a = join(room, 'أحمد', 'red');
  const b = join(room, 'سارة', 'blue');
  room.startGame();
  room.move(a.id, 40); room.lock(a.id);
  room.move(b.id, 40); room.lock(b.id); // تعادل تام: كلاهما 5
  room.nextRound();
  assert.equal(room.phase, 'finished');
  assert.equal(room.winner, 'tie');
  room.tiebreaker();
  assert.equal(room.phase, 'playing');
  assert.equal(room.totalRounds, 2);
  room.move(a.id, 50); room.lock(a.id);
  room.move(b.id, 20); room.lock(b.id);
  room.nextRound();
  assert.equal(room.winner, 'red');
});

test('نقل القيادة في الغرف العامة بعد غياب المضيف', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  try {
    const room = makeRoom({ isPublic: true });
    const a = join(room, 'أحمد', 'red');
    join(room, 'سارة', 'blue');
    const promoted = [];
    room.on('promoted', (p) => promoted.push(p));
    room.onHostDisconnected('hostsock');
    mock.timers.tick(46_000);
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].socketId, a.socketId);
    assert.equal(room.players.has(a.id), false);
    assert.equal(room.hostConnected, true);
  } finally {
    mock.timers.reset();
  }
});

test('الدردشة: الفريق خاص، الكتم، وتحديد المعدل', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  try {
    const room = makeRoom();
    const a = join(room, 'أحمد', 'red');
    const b = join(room, 'سارة', 'blue');
    const m = room.chat({ playerId: a.id }, 'team', 'مرحبا');
    assert.equal(m.team, 'red');
    assert.equal(room.chatFor({ team: 'blue' }).length, 0);
    assert.equal(room.chatFor({ isHost: true }).length, 1);
    assert.equal(code(() => room.chat({ playerId: a.id }, 'room', 'سريع')), 'slow_down');
    mock.timers.tick(1000);
    room.setMuted(b.id, true);
    assert.equal(code(() => room.chat({ playerId: b.id }, 'room', 'مكتوم')), 'muted');
    assert.equal(code(() => room.chat({ isHost: true }, 'team', 'x')), 'bad_channel');
    assert.equal(code(() => room.chat({ playerId: a.id }, 'room', '   ')), 'bad_message');
  } finally {
    mock.timers.reset();
  }
});

test('تعديل الأسئلة: القادمة فقط', () => {
  const room = makeRoom();
  const a = join(room, 'أحمد', 'red');
  join(room, 'سارة', 'blue');
  room.updateQuestion(3, Q({ item: 'جديد' }));
  room.startGame();
  assert.equal(code(() => room.updateQuestion(0, Q())), 'question_locked');
  room.updateQuestion(2, Q({ item: 'بديل' }));
  assert.equal(room.questions[2].item, 'بديل');
  room.removeQuestion(3);
  assert.equal(room.questions.length, 3);
  assert.ok(a);
});

test('مدير الغرف: أكواد فريدة وقائمة عامة وتنظيف', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const mgr = new RoomManager({ sweepEveryMs: 3_600_000 });
  try {
    const base = { name: 'غرفة', teamSize: 2, totalRounds: 2, questions: [Q()] };
    const pub = mgr.create({ ...base, isPublic: true });
    mgr.create({ ...base, isPublic: false });
    assert.match(pub.code, /^[A-Z2-9]{5}$/);
    assert.equal(mgr.listPublic().length, 1);
    assert.equal(mgr.get(pub.code.toLowerCase()), pub);
    mock.timers.tick(11 * 60_000);
    mgr.sweep();
    assert.equal(mgr.rooms.size, 0);
  } finally {
    mgr.shutdown();
    mock.timers.reset();
  }
});
