import crypto from 'node:crypto';
import { GameError, fail } from '../game/errors.js';
import { verifyToken } from '../auth/tokens.js';

const IP_SALT = process.env.IP_SALT || 'dialed-in';
const MAX_EVENTS_PER_SEC = 120;
const MAX_ROOMS_PER_HOST = 3;

// بصمة مشفّرة للعنوان (لا نخزّن العنوان نفسه) تُستخدم للحظر داخل الغرفة
function ipHashOf(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) || socket.handshake.address || '';
  return crypto.createHash('sha256').update(IP_SALT + ip).digest('hex').slice(0, 24);
}

// حد بسيط لعدد الأحداث من المقبس الواحد في الثانية
function rateOk(socket) {
  const now = Date.now();
  const b = socket.data.bucket || (socket.data.bucket = { start: now, count: 0 });
  if (now - b.start >= 1000) {
    b.start = now;
    b.count = 0;
  }
  b.count += 1;
  return b.count <= MAX_EVENTS_PER_SEC;
}

// يربط أحداث الغرفة (من Room) بالمتصفحات
function wireRoom(io, room) {
  const code = room.code;

  room.on('update', () => io.to(code).emit('room:state', room.toState()));
  room.on('marker', (m) => io.to(code).emit('round:marker', m));

  room.on('chat', (msg) => {
    if (msg.channel === 'room') {
      io.to(code).emit('chat:message', msg);
      return;
    }
    // دردشة الفريق: لأعضاء الفريق والمضيف فقط
    for (const p of room.playerList()) {
      if (p.team === msg.team && p.socketId) io.to(p.socketId).emit('chat:message', msg);
    }
    if (room.hostSocketId) io.to(room.hostSocketId).emit('chat:message', msg);
  });

  room.on('questions', () => {
    if (room.hostSocketId) io.to(room.hostSocketId).emit('host:questions', room.hostQuestions());
  });

  room.on('kicked', ({ socketId, ban }) => {
    if (!socketId) return;
    io.to(socketId).emit('room:kicked', { ban });
    const s = io.sockets.sockets.get(socketId);
    if (s) {
      s.leave(code);
      s.data.code = null;
      s.data.playerId = null;
    }
  });

  room.on('promoted', ({ socketId, hostToken }) => {
    const s = io.sockets.sockets.get(socketId);
    if (s) {
      s.data.isHost = true;
      s.data.playerId = null;
    }
    io.to(socketId).emit('host:promoted', { hostToken, questions: room.hostQuestions() });
  });

  room.on('closed', async (reason) => {
    io.to(code).emit('room:closed', { reason });
    // نصفّر حالة كل مقبس كان فيها كي يستطيع دخول غرفة أخرى أو إنشاء واحدة
    for (const s of await io.in(code).fetchSockets()) {
      s.data.code = null;
      s.data.playerId = null;
      s.data.isHost = false;
    }
    io.in(code).socketsLeave(code);
  });
}

export function registerSockets(io, manager, hostStore) {
  manager.on('created', (room) => wireRoom(io, room));

  io.on('connection', (socket) => {
    socket.data = { code: null, playerId: null, isHost: false, bucket: null };

    // ── أدوات داخلية ──
    const roomOf = () => {
      if (!socket.data.code) fail('no_room');
      return manager.require(socket.data.code);
    };
    const hostRoom = () => {
      const room = roomOf();
      if (!socket.data.isHost || room.hostSocketId !== socket.id) fail('not_host');
      return room;
    };
    const playerRoom = () => {
      const room = roomOf();
      if (!socket.data.playerId) fail('not_player');
      return room;
    };
    // إن كانت الغرفة المسجّلة على هذا المقبس لم تعد موجودة نصفّر حالته
    const healStale = () => {
      if (socket.data.code && !manager.get(socket.data.code)) {
        socket.data.code = null;
        socket.data.playerId = null;
        socket.data.isHost = false;
      }
    };
    const enter = (room, { playerId = null, isHost = false } = {}) => {
      socket.join(room.code);
      socket.data.code = room.code;
      socket.data.playerId = playerId;
      socket.data.isHost = isHost;
    };

    // تغليف كل حدث: فحص المعدل، التقاط الأخطاء، والرد عبر ack
    const on = (event, handler) => {
      socket.on(event, async (payload, ack) => {
        if (typeof payload === 'function') {
          ack = payload;
          payload = {};
        }
        const reply = typeof ack === 'function' ? ack : () => {};
        if (!rateOk(socket)) {
          reply({ ok: false, error: 'rate_limited' });
          return;
        }
        try {
          const data = await handler(payload && typeof payload === 'object' ? payload : {});
          reply({ ok: true, ...(data || {}) });
        } catch (err) {
          if (err instanceof GameError) {
            reply({ ok: false, error: err.code });
          } else {
            console.error(`[socket:${event}]`, err);
            reply({ ok: false, error: 'server_error' });
          }
        }
      });
    };

    const playerSnapshot = (room, player) => ({
      playerId: player.id,
      token: player.token,
      state: room.toState(),
      chat: room.chatFor({ isHost: false, team: player.team }),
    });

    socket.emit('server:hello', { id: socket.id });

    // ── عام ──
    on('ping:client', () => ({ at: Date.now() }));
    on('lobby:public', () => ({ rooms: manager.listPublic() }));

    // ── المضيف: إنشاء الغرفة والعودة إليها ──
    on('room:create', async (p) => {
      const auth = verifyToken(p.auth);
      if (!auth) fail('unauthorized');
      // الحساب يُقرأ من المتجر: الإيقاف وتغيير الدور يسريان فورًا
      const account = await hostStore.findById(auth.sub);
      if (!account || !account.active) fail('unauthorized');
      healStale();
      if (socket.data.code) fail('already_in_room');
      if (manager.countByOwner(account.id) >= MAX_ROOMS_PER_HOST) fail('too_many_rooms');
      const room = manager.create({
        name: p.name,
        isPublic: p.isPublic,
        teamSize: p.teamSize,
        totalRounds: p.totalRounds,
        questions: p.questions,
      });
      room.ownerId = account.id;
      room.ownerName = account.displayName;
      room.attachHost(socket.id);
      enter(room, { isHost: true });
      return {
        code: room.code,
        hostToken: room.hostToken,
        state: room.toState(),
        questions: room.hostQuestions(),
        chat: room.chatFor({ isHost: true }),
      };
    });

    on('host:rejoin', (p) => {
      const room = manager.require(p.code);
      room.attachHost(socket.id, p.hostToken);
      enter(room, { isHost: true });
      return { state: room.toState(), questions: room.hostQuestions(), chat: room.chatFor({ isHost: true }) };
    });

    // ── اللاعب ──
    on('room:join', (p) => {
      healStale();
      if (socket.data.code) fail('already_in_room');
      const room = manager.require(p.code);
      const player = room.addPlayer({
        name: p.name,
        avatar: p.avatar,
        team: p.team,
        socketId: socket.id,
        ipHash: ipHashOf(socket),
      });
      enter(room, { playerId: player.id });
      return playerSnapshot(room, player);
    });

    on('room:rejoin', (p) => {
      const room = manager.require(p.code);
      const player = room.reconnect(p.token, socket.id);
      enter(room, { playerId: player.id });
      return playerSnapshot(room, player);
    });

    on('room:leave', () => {
      const room = playerRoom();
      room.removePlayer(socket.data.playerId);
      socket.leave(room.code);
      socket.data.code = null;
      socket.data.playerId = null;
    });

    on('player:move', (p) => {
      playerRoom().move(socket.data.playerId, p.pos);
    });

    on('player:lock', (p) => {
      playerRoom().lock(socket.data.playerId, p.pos);
    });

    // ── الدردشة ──
    on('chat:send', (p) => {
      const room = roomOf();
      room.chat({ isHost: socket.data.isHost, playerId: socket.data.playerId }, p.channel, p.text);
    });

    // ── أدوات المضيف ──
    on('host:start', () => hostRoom().startGame());
    on('host:nextRound', () => hostRoom().nextRound());
    on('host:tiebreaker', () => hostRoom().tiebreaker());
    on('host:skipTurn', (p) => hostRoom().skipTurn(p.team));
    on('host:lockRoom', (p) => hostRoom().setLocked(p.locked));
    on('host:kick', (p) => hostRoom().kick(p.playerId, p.ban === true));
    on('host:mute', (p) => hostRoom().setMuted(p.playerId, p.muted));
    on('host:addQuestion', (p) => hostRoom().addQuestion(p.question));
    on('host:updateQuestion', (p) => hostRoom().updateQuestion(p.index, p.question));
    on('host:removeQuestion', (p) => hostRoom().removeQuestion(p.index));
    on('host:close', () => {
      const room = hostRoom();
      manager.remove(room.code, 'host_closed');
    });

    // ── الانقطاع ──
    socket.on('disconnect', () => {
      const { code, playerId, isHost } = socket.data;
      const room = code ? manager.get(code) : null;
      if (!room) return;
      if (isHost) room.onHostDisconnected(socket.id);
      else if (playerId) room.onPlayerDisconnected(playerId, socket.id);
    });
  });
}
