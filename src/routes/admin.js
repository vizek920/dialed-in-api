import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { fail } from '../game/errors.js';
import { cleanText, validateQuestion } from '../game/validate.js';
import { adminQuestion, publicAccount, wrap } from './util.js';

const MAX_CATEGORIES = 40;
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const ROLES = ['host', 'moderator', 'admin'];

const roomView = (room) => ({
  code: room.code,
  name: room.name,
  isPublic: room.isPublic,
  locked: room.locked,
  phase: room.phase,
  roundIndex: room.roundIndex,
  totalRounds: room.totalRounds,
  teamSize: room.teamSize,
  hostConnected: room.hostConnected,
  ownerName: room.ownerName ?? null,
  createdAt: room.createdAt,
  lastActiveAt: room.lastActiveAt,
  players: room
    .playerList()
    .sort((a, b) => a.seq - b.seq)
    .map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      team: p.team,
      connected: p.connected,
      muted: p.muted,
      score: p.score,
    })),
});

// لوحة الإدارة.
//   مشرف (moderator): الغرف الحية + مراجعة المقترحات
//   مدير (admin): كل ما سبق + بنك الأسئلة والتصنيفات + الحسابات
export default function adminRouter({ manager, bankStore, hostStore }) {
  const router = Router();
  const staff = requireRole(hostStore, 'moderator', 'admin');
  const admin = requireRole(hostStore, 'admin');

  const room = (req) => {
    const r = manager.get(req.params.code);
    if (!r) fail('no_room');
    return r;
  };

  // ───────── نظرة عامة والغرف ─────────
  router.get('/admin/overview', staff, wrap(async (_req, res) => {
    const rooms = [...manager.rooms.values()];
    const [pending, approved, hosts] = await Promise.all([
      bankStore.countQuestions({ status: 'pending' }),
      bankStore.countQuestions({ status: 'approved' }),
      hostStore.list(),
    ]);
    res.json({
      rooms: rooms.length,
      players: rooms.reduce((n, r) => n + r.players.size, 0),
      pending,
      approved,
      hosts: hosts.length,
    });
  }));

  router.get('/admin/rooms', staff, (_req, res) => {
    const rooms = [...manager.rooms.values()].sort((a, b) => b.createdAt - a.createdAt).map(roomView);
    res.json({ rooms });
  });

  router.post('/admin/rooms/:code/close', staff, wrap(async (req, res) => {
    manager.remove(room(req).code, 'admin_closed');
    res.json({ ok: true });
  }));

  router.post('/admin/rooms/:code/lock', staff, wrap(async (req, res) => {
    room(req).setLocked(req.body?.locked === true);
    res.json({ ok: true });
  }));

  router.post('/admin/rooms/:code/players/:pid/mute', staff, wrap(async (req, res) => {
    room(req).setMuted(req.params.pid, req.body?.muted === true);
    res.json({ ok: true });
  }));

  router.post('/admin/rooms/:code/players/:pid/kick', staff, wrap(async (req, res) => {
    room(req).kick(req.params.pid, req.body?.ban === true);
    res.json({ ok: true });
  }));

  // ───────── المقترحات ─────────
  router.get('/admin/suggestions', staff, wrap(async (_req, res) => {
    const [list, cats] = await Promise.all([bankStore.listQuestions({ status: 'pending' }), bankStore.listCategories()]);
    const byId = new Map(cats.map((c) => [c.id, c.name]));
    // الأقدم أولًا: من اقترح أولًا يُراجَع أولًا
    list.sort((a, b) => a.createdAt - b.createdAt);
    res.json({ questions: list.map((q) => ({ ...adminQuestion(q), categoryName: byId.get(q.categoryId) ?? null })) });
  }));

  const pendingQuestion = async (req) => {
    const q = await bankStore.getQuestion(req.params.id);
    if (!q) fail('not_found');
    if (q.status !== 'pending') fail('bad_status');
    return q;
  };

  router.post('/admin/questions/:id/approve', staff, wrap(async (req, res) => {
    const q = await pendingQuestion(req);
    let categoryId = q.categoryId;
    if (req.body?.categoryId) {
      const cat = await bankStore.getCategory(req.body.categoryId);
      if (!cat) fail('bad_category');
      categoryId = cat.id;
    }
    const updated = await bankStore.updateQuestion(q.id, {
      status: 'approved',
      categoryId,
      rejectReason: null,
      reviewedBy: req.user.id,
      reviewedAt: Date.now(),
    });
    res.json({ question: adminQuestion(updated) });
  }));

  router.post('/admin/questions/:id/reject', staff, wrap(async (req, res) => {
    const q = await pendingQuestion(req);
    const reason = req.body?.reason ? cleanText(req.body.reason, 1, 200) : null;
    if (req.body?.reason && !reason) fail('bad_reason');
    const updated = await bankStore.updateQuestion(q.id, {
      status: 'rejected',
      rejectReason: reason,
      reviewedBy: req.user.id,
      reviewedAt: Date.now(),
    });
    res.json({ question: adminQuestion(updated) });
  }));

  // ───────── بنك الأسئلة (للمدير) ─────────
  router.get('/admin/bank', admin, wrap(async (req, res) => {
    const filter = { status: 'approved', limit: 500 };
    if (typeof req.query.categoryId === 'string' && req.query.categoryId) {
      filter.categoryId = req.query.categoryId === 'none' ? null : req.query.categoryId;
    }
    if (typeof req.query.q === 'string') filter.search = req.query.q.slice(0, 40);
    const list = await bankStore.listQuestions(filter);
    res.json({ questions: list.map(adminQuestion) });
  }));

  const categoryOrNull = async (id) => {
    if (id === undefined || id === null || id === '') return null;
    const cat = await bankStore.getCategory(id);
    if (!cat) fail('bad_category');
    return cat.id;
  };

  router.post('/admin/bank', admin, wrap(async (req, res) => {
    const q = validateQuestion(req.body);
    const categoryId = await categoryOrNull(req.body?.categoryId);
    const created = await bankStore.createQuestion({
      ...q,
      ownerId: null,
      ownerName: null,
      categoryId,
      status: 'approved',
    });
    res.status(201).json({ question: adminQuestion(created) });
  }));

  router.patch('/admin/bank/:id', admin, wrap(async (req, res) => {
    const q = await bankStore.getQuestion(req.params.id);
    if (!q) fail('not_found');
    const next = validateQuestion({ ...q, ...req.body });
    const patch = { ...next };
    if (req.body && 'categoryId' in req.body) patch.categoryId = await categoryOrNull(req.body.categoryId);
    res.json({ question: adminQuestion(await bankStore.updateQuestion(q.id, patch)) });
  }));

  router.delete('/admin/bank/:id', admin, wrap(async (req, res) => {
    if (!(await bankStore.deleteQuestion(req.params.id))) fail('not_found');
    res.json({ ok: true });
  }));

  // ───────── التصنيفات (للمدير) ─────────
  router.get('/admin/categories', staff, wrap(async (_req, res) => {
    const [cats, approved] = await Promise.all([bankStore.listCategories(), bankStore.listQuestions({ status: 'approved' })]);
    const counts = new Map();
    for (const q of approved) counts.set(q.categoryId, (counts.get(q.categoryId) || 0) + 1);
    res.json({ categories: cats.map((c) => ({ ...c, count: counts.get(c.id) || 0 })) });
  }));

  router.post('/admin/categories', admin, wrap(async (req, res) => {
    const name = cleanText(req.body?.name, 2, 40);
    if (!name) fail('bad_category_name');
    if ((await bankStore.listCategories()).length >= MAX_CATEGORIES) fail('too_many_categories');
    if (await bankStore.findCategoryByName(name)) fail('category_exists');
    res.status(201).json({ category: await bankStore.createCategory(name) });
  }));

  router.patch('/admin/categories/:id', admin, wrap(async (req, res) => {
    const patch = {};
    if (req.body?.name !== undefined) {
      const name = cleanText(req.body.name, 2, 40);
      if (!name) fail('bad_category_name');
      const other = await bankStore.findCategoryByName(name);
      if (other && other.id !== String(req.params.id)) fail('category_exists');
      patch.name = name;
    }
    if (typeof req.body?.isActive === 'boolean') patch.isActive = req.body.isActive;
    const updated = await bankStore.updateCategory(req.params.id, patch);
    if (!updated) fail('not_found');
    res.json({ category: updated });
  }));

  router.delete('/admin/categories/:id', admin, wrap(async (req, res) => {
    if (!(await bankStore.deleteCategory(req.params.id))) fail('not_found');
    res.json({ ok: true });
  }));

  // ───────── الحسابات (للمدير) ─────────
  router.get('/admin/hosts', admin, wrap(async (_req, res) => {
    res.json({ hosts: (await hostStore.list()).map(publicAccount) });
  }));

  const checkPassword = (pw) => {
    if (typeof pw !== 'string' || pw.length < 8 || pw.length > 100) fail('bad_password');
    return pw;
  };

  router.post('/admin/hosts', admin, wrap(async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) fail('bad_username');
    const displayName = cleanText(req.body?.displayName || username, 2, 30);
    if (!displayName) fail('bad_display_name');
    const role = req.body?.role || 'host';
    if (!ROLES.includes(role)) fail('bad_role');
    const created = await hostStore.create({ username, password: checkPassword(req.body?.password), displayName, role });
    if (!created) fail('username_taken');
    res.status(201).json({ host: publicAccount(created) });
  }));

  router.patch('/admin/hosts/:id', admin, wrap(async (req, res) => {
    const target = await hostStore.findById(req.params.id);
    if (!target) fail('not_found');
    const self = target.id === req.user.id;
    const patch = {};
    if (req.body?.displayName !== undefined) {
      const name = cleanText(req.body.displayName, 2, 30);
      if (!name) fail('bad_display_name');
      patch.displayName = name;
    }
    if (req.body?.role !== undefined) {
      if (!ROLES.includes(req.body.role)) fail('bad_role');
      if (self && req.body.role !== target.role) fail('cannot_change_self');
      patch.role = req.body.role;
    }
    if (typeof req.body?.isBanned === 'boolean') {
      if (self && req.body.isBanned) fail('cannot_change_self');
      patch.active = !req.body.isBanned;
    }
    if (req.body?.password !== undefined) patch.password = checkPassword(req.body.password);
    const updated = await hostStore.update(target.id, patch);

    // إيقاف حساب يغلق غرفه الحية فورًا
    if (patch.active === false) {
      for (const r of [...manager.rooms.values()]) if (r.ownerId === target.id) manager.remove(r.code, 'admin_closed');
    }
    res.json({ host: publicAccount(updated) });
  }));

  return router;
}
