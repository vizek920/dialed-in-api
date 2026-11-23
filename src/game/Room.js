import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { TEAMS, AVATARS, LIMITS, TIMING } from './constants.js';
import { fail } from './errors.js';
import { cleanText, validateQuestion } from './validate.js';
import { scoreRound } from './scoring.js';

const rid = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * غرفة لعب واحدة. كل منطق اللعبة هنا ولا يعرف شيئًا عن Socket.IO:
 * يُطلق أحداثًا فقط (update, marker, chat, kicked, promoted, questions, closed)
 * وطبقة الـ sockets هي التي تنقلها للمتصفحات.
 *
 * المراحل (phase): lobby → playing → reveal → (playing ...) → finished
 */
export class Room extends EventEmitter {
  constructor({ code, name, isPublic, teamSize, totalRounds, questions }) {
    super();
    this.code = code;
    this.name = name;
    this.isPublic = isPublic;
    this.teamSize = teamSize;
    this.totalRounds = totalRounds;
    this.questions = questions;

    this.locked = false;
    this.phase = 'lobby';
    this.roundIndex = -1;
    this.round = null;
    this.winner = null;

    this.players = new Map();
    this.seq = 0;
    this.carry = { red: 0, blue: 0 }; // نقاط من غادروا أو طُردوا تبقى لفريقهم
    this.bannedIps = new Set();

    this.hostToken = rid();
    this.hostSocketId = null;
    this.hostConnected = false;

    this.chatLog = [];
    this.lastChatAt = new Map();

    this.timer = null;
    this.hostTimer = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.lastActiveAt = Date.now();
  }

  // ───────────────────────── مساعدات ─────────────────────────
  touch() {
    this.lastActiveAt = Date.now();
  }

  changed() {
    this.touch();
    this.emit('update');
  }

  playerList() {
    return [...this.players.values()];
  }

  teamScore(team) {
    let sum = this.carry[team];
    for (const p of this.players.values()) if (p.team === team) sum += p.score;
    return sum;
  }

  connectedCount() {
    return this.playerList().filter((p) => p.connected).length + (this.hostConnected ? 1 : 0);
  }

  isFull() {
    return this.players.size >= this.teamSize * 2;
  }

  requirePlayer(id) {
    const p = this.players.get(id);
    if (!p) fail('no_player');
    return p;
  }

  // ───────────────────────── المضيف ─────────────────────────
  attachHost(socketId, token) {
    if (token !== undefined && !safeEqual(token, this.hostToken)) fail('bad_token');
    clearTimeout(this.hostTimer);
    this.hostSocketId = socketId;
    this.hostConnected = true;
    this.changed();
  }

  onHostDisconnected(socketId) {
    if (this.hostSocketId !== socketId) return;
    this.hostSocketId = null;
    this.hostConnected = false;
    clearTimeout(this.hostTimer);
    // في الغرف العامة تنتقل القيادة لأقدم لاعب إن لم يعد المضيف
    if (this.isPublic && this.phase !== 'finished') {
      this.hostTimer = setTimeout(() => this.transferHost(), TIMING.hostGraceMs);
      this.hostTimer.unref?.();
    }
    this.changed();
  }

  transferHost() {
    if (this.hostConnected) return false;
    const next = this.playerList()
      .filter((p) => p.connected)
      .sort((a, b) => a.seq - b.seq)[0];
    if (!next) return false;
    const socketId = next.socketId;
    this.removePlayer(next.id, { silent: true });
    this.hostToken = rid();
    this.hostSocketId = socketId;
    this.hostConnected = true;
    this.emit('promoted', { socketId, hostToken: this.hostToken });
    this.emit('questions');
    this.changed();
    return true;
  }

  // ───────────────────────── اللاعبون ─────────────────────────
  addPlayer({ name, avatar, team, socketId, ipHash }) {
    if (this.phase === 'finished') fail('game_finished');
    if (this.locked) fail('room_locked');
    if (ipHash && this.bannedIps.has(ipHash)) fail('banned');

    const cleanName = cleanText(name, LIMITS.nameMin, LIMITS.nameMax);
    if (!cleanName) fail('bad_name');
    if (!AVATARS.includes(avatar)) fail('bad_avatar');
    if (!TEAMS.includes(team)) fail('bad_team');

    const lower = cleanName.toLowerCase();
    if (this.playerList().some((p) => p.name.toLowerCase() === lower)) fail('name_taken');

    const mates = this.playerList().filter((p) => p.team === team);
    if (mates.length >= this.teamSize) fail('team_full');

    const player = {
      id: rid(6),
      token: rid(),
      name: cleanName,
      avatar,
      team,
      socketId,
      ipHash: ipHash || null,
      connected: true,
      seq: ++this.seq,
      score: 0,
      // اللاعب المتأخر يبدأ من أقل عدد أدوار لدى فريقه كي يدخل الدورة بعدالة
      turns: mates.length ? Math.min(...mates.map((m) => m.turns)) : 0,
      lastRound: -1, // آخر جولة لعبها (للتفضيل عند تساوي الأدوار)
      muted: false,
      lastMoveAt: 0,
    };
    this.players.set(player.id, player);
    this.changed();
    return player;
  }

  reconnect(token, socketId) {
    if (typeof token !== 'string') fail('bad_token');
    const player = this.playerList().find((p) => safeEqual(p.token, token));
    if (!player) fail('bad_token');
    player.socketId = socketId;
    player.connected = true;
    this.changed();
    return player;
  }

  onPlayerDisconnected(playerId, socketId) {
    const p = this.players.get(playerId);
    if (!p || p.socketId !== socketId) return; // أعاد الاتصال بمقبس آخر
    p.connected = false;
    p.socketId = null;
    this.changed();
  }

  removePlayer(playerId, { silent = false } = {}) {
    const p = this.requirePlayer(playerId);
    this.carry[p.team] += p.score;
    this.players.delete(playerId);
    this.dropFromRound(playerId);
    if (!silent) this.changed();
    return p;
  }

  kick(playerId, ban = false) {
    const p = this.requirePlayer(playerId);
    if (ban && p.ipHash) this.bannedIps.add(p.ipHash);
    this.removePlayer(playerId, { silent: true });
    this.emit('kicked', { socketId: p.socketId, ban });
    this.changed();
  }

  setMuted(playerId, muted) {
    this.requirePlayer(playerId).muted = Boolean(muted);
    this.changed();
  }

  setLocked(locked) {
    this.locked = Boolean(locked);
    this.changed();
  }

  // ───────────────────────── الأسئلة ─────────────────────────
  hostQuestions() {
    return this.questions.map((q, i) => ({ ...q, index: i }));
  }

  addQuestion(input) {
    if (this.questions.length >= LIMITS.questionsMax) fail('too_many_questions');
    this.questions.push(validateQuestion(input));
    this.emit('questions');
    this.changed();
  }

  // يُسمح بتعديل الأسئلة القادمة فقط، لا ما لُعب أو يُلعب الآن
  editableIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.questions.length) fail('bad_index');
    if (index <= this.roundIndex) fail('question_locked');
  }

  updateQuestion(index, input) {
    this.editableIndex(index);
    this.questions[index] = validateQuestion(input);
    this.emit('questions');
    this.changed();
  }

  removeQuestion(index) {
    this.editableIndex(index);
    this.questions.splice(index, 1);
    this.emit('questions');
    this.changed();
  }

  // ───────────────────────── سير اللعبة ─────────────────────────
  pickPlayer(team, excludeIds = []) {
    const candidates = this.playerList().filter(
      (p) => p.team === team && p.connected && !excludeIds.includes(p.id)
    );
    candidates.sort((a, b) => a.turns - b.turns || a.lastRound - b.lastRound || a.seq - b.seq);
    return candidates[0] || null;
  }

  startGame() {
    if (this.phase !== 'lobby') fail('bad_phase');
    this.roundIndex = 0;
    try {
      this.startRound();
    } catch (e) {
      this.roundIndex = -1;
      throw e;
    }
    this.startedAt = Date.now();
    this.changed();
  }

  startRound() {
    const q = this.questions[this.roundIndex];
    if (!q) fail('no_question');
    const picks = { red: this.pickPlayer('red'), blue: this.pickPlayer('blue') };
    if (!picks.red && !picks.blue) fail('need_players');

    const markers = {};
    for (const p of Object.values(picks)) {
      if (!p) continue;
      p.turns += 1;
      p.lastRound = this.roundIndex;
      p.lastMoveAt = 0;
      markers[p.id] = { pos: null, locked: false };
    }
    const now = Date.now();
    this.round = {
      index: this.roundIndex,
      question: q,
      players: { red: picks.red?.id ?? null, blue: picks.blue?.id ?? null },
      startedAt: now,
      endsAt: now + q.timeSec * 1000,
      markers,
      results: null,
    };
    this.phase = 'playing';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finishRound(), q.timeSec * 1000);
    this.timer.unref?.();
  }

  activeRoundIds() {
    return this.round ? Object.values(this.round.players).filter(Boolean) : [];
  }

  move(playerId, pos) {
    const marker = this.round?.markers[playerId];
    if (this.phase !== 'playing' || !marker || marker.locked) fail('not_your_turn');
    if (Date.now() >= this.round.endsAt) fail('time_up');
    if (typeof pos !== 'number' || !Number.isFinite(pos)) fail('bad_position');
    const p = this.requirePlayer(playerId);
    const now = Date.now();
    if (now - p.lastMoveAt < TIMING.moveMinIntervalMs) return; // تجاهل الطوفان بصمت
    p.lastMoveAt = now;
    marker.pos = Math.round(Math.min(100, Math.max(0, pos)) * 100) / 100;
    this.touch();
    this.emit('marker', { playerId, pos: marker.pos });
  }

  // pos اختياري: آخر موضع يراه اللاعب لحظة الضغط (قد يسبق آخر تحريك مُرسل)
  lock(playerId, pos) {
    const marker = this.round?.markers[playerId];
    if (this.phase !== 'playing' || !marker || marker.locked) fail('not_your_turn');
    if (pos !== undefined) {
      if (typeof pos !== 'number' || !Number.isFinite(pos)) fail('bad_position');
      marker.pos = Math.round(Math.min(100, Math.max(0, pos)) * 100) / 100;
    }
    if (marker.pos === null) fail('move_first');
    marker.locked = true;
    this.touch();
    this.emit('marker', { playerId, pos: marker.pos, locked: true });
    this.checkAllLocked();
    if (this.phase === 'playing') this.changed();
  }

  checkAllLocked() {
    if (this.phase !== 'playing') return;
    const ids = this.activeRoundIds();
    if (ids.length === 0 || ids.every((id) => this.round.markers[id]?.locked)) this.finishRound();
  }

  finishRound() {
    if (this.phase !== 'playing') return;
    clearTimeout(this.timer);
    const q = this.round.question;
    const entries = [];
    for (const team of TEAMS) {
      const id = this.round.players[team];
      if (!id) continue;
      const marker = this.round.markers[id];
      marker.locked = true; // تثبيت تلقائي عند انتهاء الوقت
      entries.push({ playerId: id, team, pos: marker.pos });
    }
    const rows = scoreRound(q, entries);
    for (const r of rows) {
      const p = this.players.get(r.playerId);
      if (p) p.score += r.total;
    }
    this.round.results = { rows, target: q.target };
    this.phase = 'reveal';
    this.changed();
  }

  // يخرج لاعبًا من الجولة الجارية (طرد أو خروج أو نقل قيادة)
  dropFromRound(playerId) {
    if (!this.round) return;
    for (const team of TEAMS) {
      if (this.round.players[team] === playerId) this.round.players[team] = null;
    }
    if (this.phase === 'playing') {
      delete this.round.markers[playerId];
      this.checkAllLocked();
    }
  }

  // المضيف يتخطى لاعبًا غائبًا في الجولة الحالية فيحل محله زميله التالي
  skipTurn(team) {
    if (this.phase !== 'playing') fail('bad_phase');
    if (!TEAMS.includes(team)) fail('bad_team');
    const currentId = this.round.players[team];
    if (!currentId) fail('no_player');
    const current = this.players.get(currentId);
    if (current) current.turns = Math.max(0, current.turns - 1); // لم يلعب دوره فيبقى له
    delete this.round.markers[currentId];
    const next = this.pickPlayer(team, [currentId]);
    if (next) {
      next.turns += 1;
      next.lastRound = this.roundIndex;
      next.lastMoveAt = 0;
      this.round.players[team] = next.id;
      this.round.markers[next.id] = { pos: null, locked: false };
    } else {
      this.round.players[team] = null;
    }
    this.checkAllLocked();
    if (this.phase === 'playing') this.changed();
  }

  nextRound() {
    if (this.phase !== 'reveal') fail('bad_phase');
    if (this.roundIndex + 1 >= this.totalRounds) {
      this.finishGame();
      return;
    }
    this.roundIndex += 1;
    try {
      this.startRound();
    } catch (e) {
      this.roundIndex -= 1;
      throw e;
    }
    this.changed();
  }

  finishGame() {
    clearTimeout(this.timer);
    const red = this.teamScore('red');
    const blue = this.teamScore('blue');
    this.winner = red === blue ? 'tie' : red > blue ? 'red' : 'blue';
    this.phase = 'finished';
    this.emit('finished');
    this.changed();
  }

  // جولة فاصلة عند التعادل (على المضيف إضافة سؤال لها أولًا)
  tiebreaker() {
    if (this.phase !== 'finished' || this.winner !== 'tie') fail('bad_phase');
    this.totalRounds += 1;
    this.roundIndex += 1;
    try {
      this.startRound();
    } catch (e) {
      this.totalRounds -= 1;
      this.roundIndex -= 1;
      throw e;
    }
    this.winner = null;
    this.changed();
  }

  // ───────────────────────── الدردشة ─────────────────────────
  chat(sender, channel, text) {
    const clean = cleanText(text, 1, LIMITS.chatMax);
    if (!clean) fail('bad_message');
    if (channel !== 'room' && channel !== 'team') fail('bad_channel');

    const key = sender.isHost ? 'host' : sender.playerId;
    const now = Date.now();
    if (now - (this.lastChatAt.get(key) || 0) < TIMING.chatMinIntervalMs) fail('slow_down');
    this.lastChatAt.set(key, now);

    let from;
    let team = null;
    if (sender.isHost) {
      if (channel === 'team') fail('bad_channel');
      from = { id: 'host', name: 'المضيف', avatar: null, team: null, isHost: true };
    } else {
      const p = this.requirePlayer(sender.playerId);
      if (p.muted) fail('muted');
      from = { id: p.id, name: p.name, avatar: p.avatar, team: p.team, isHost: false };
      if (channel === 'team') team = p.team;
    }

    const msg = { id: rid(4), channel, team, from, text: clean, at: now };
    this.chatLog.push(msg);
    if (this.chatLog.length > LIMITS.chatKeep) this.chatLog.shift();
    this.touch();
    this.emit('chat', msg);
    return msg;
  }

  // سجل الدردشة المسموح لهذا المشاهد برؤيته
  chatFor(viewer) {
    return this.chatLog.filter(
      (m) => m.channel === 'room' || viewer.isHost || (viewer.team && m.team === viewer.team)
    );
  }

  // ───────────────────────── العرض للعميل ─────────────────────────
  // لا يحتوي على الهدف المخفي إلا بعد كشف الجولة
  toState() {
    const reveal = this.phase === 'reveal' || this.phase === 'finished';
    let round = null;
    if (this.round) {
      const q = this.round.question;
      const showTarget = this.round.results !== null;
      round = {
        index: this.round.index,
        question: {
          item: q.item,
          left: q.left,
          right: q.right,
          zoneWidth: q.zoneWidth,
          points: q.points,
          timeSec: q.timeSec,
          ...(showTarget ? { target: q.target } : {}),
        },
        players: this.round.players,
        startedAt: this.round.startedAt,
        endsAt: this.round.endsAt,
        markers: this.round.markers,
        results: this.round.results,
      };
    }

    return {
      code: this.code,
      name: this.name,
      isPublic: this.isPublic,
      locked: this.locked,
      phase: this.phase,
      teamSize: this.teamSize,
      totalRounds: this.totalRounds,
      roundIndex: this.roundIndex,
      questionCount: this.questions.length,
      hostConnected: this.hostConnected,
      winner: reveal ? this.winner : null,
      serverNow: Date.now(),
      teams: {
        red: { score: this.teamScore('red') },
        blue: { score: this.teamScore('blue') },
      },
      players: this.playerList()
        .sort((a, b) => a.seq - b.seq)
        .map((p) => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          team: p.team,
          connected: p.connected,
          score: p.score,
          muted: p.muted,
        })),
      round,
    };
  }

  // ───────────────────────── الإغلاق ─────────────────────────
  destroy(reason = 'closed') {
    clearTimeout(this.timer);
    clearTimeout(this.hostTimer);
    this.emit('closed', reason);
    this.removeAllListeners();
  }
}
