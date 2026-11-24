import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { LIMITS, TIMING } from './constants.js';
import { fail } from './errors.js';
import { validateRoomSettings } from './validate.js';
import { Room } from './Room.js';

// أحرف واضحة بلا التباس (بدون 0 O 1 I L)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(length = 5) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return out;
}

export function normalizeCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

// يدير كل الغرف الحية في الذاكرة. أحداثه: created(room) و removed(room)
export class RoomManager extends EventEmitter {
  constructor({ sweepEveryMs = 60_000 } = {}) {
    super();
    this.rooms = new Map();
    this.sweepTimer = setInterval(() => this.sweep(), sweepEveryMs);
    this.sweepTimer.unref?.();
  }

  create(input) {
    if (this.rooms.size >= LIMITS.maxRooms) fail('server_busy');
    const settings = validateRoomSettings(input);
    let code = randomCode();
    while (this.rooms.has(code)) code = randomCode();
    const room = new Room({ code, ...settings });
    this.rooms.set(code, room);
    this.emit('created', room);
    return room;
  }

  get(code) {
    return this.rooms.get(normalizeCode(code)) || null;
  }

  require(code) {
    const room = this.get(code);
    if (!room) fail('no_room');
    return room;
  }

  remove(code, reason = 'closed') {
    const room = this.rooms.get(code);
    if (!room) return;
    this.rooms.delete(code);
    room.destroy(reason);
    this.emit('removed', room);
  }

  // قائمة الغرف العامة للردهة (بيانات عامة فقط)
  listPublic() {
    const out = [];
    for (const room of this.rooms.values()) {
      if (!room.isPublic || room.phase === 'finished') continue;
      let status = 'waiting';
      if (room.phase !== 'lobby') status = 'playing';
      if (room.locked || room.isFull()) status = 'locked';
      out.push({
        code: room.code,
        name: room.name,
        status,
        players: room.players.size,
        maxPlayers: room.teamSize * 2,
        avatars: room.playerList().slice(0, 5).map((pl) => pl.avatar),
        totalRounds: room.totalRounds,
        hostConnected: room.hostConnected,
      });
    }
    return out;
  }

  // يحذف الغرف المهجورة والمنتهية القديمة
  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      const idle = now - room.lastActiveAt;
      if (room.connectedCount() === 0 && idle > TIMING.emptyRoomTtlMs) this.remove(room.code, 'abandoned');
      else if (room.phase === 'finished' && idle > TIMING.finishedRoomTtlMs) this.remove(room.code, 'finished');
    }
  }

  shutdown() {
    clearInterval(this.sweepTimer);
    for (const code of [...this.rooms.keys()]) this.remove(code, 'shutdown');
  }
}
