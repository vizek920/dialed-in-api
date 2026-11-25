import { GameError } from '../game/errors.js';

// يغلّف معالجًا غير متزامن: أخطاء التحقق المتوقعة (GameError) تعود 400 برمزها، والباقي للمعالج العام
export const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof GameError) return res.status(400).json({ error: err.code });
    next(err);
  }
};

// عرض السؤال للمضيفين: بلا بيانات صاحبه
export const publicQuestion = (q) => ({
  id: q.id,
  categoryId: q.categoryId,
  item: q.item,
  left: q.left,
  right: q.right,
  target: q.target,
  zoneWidth: q.zoneWidth,
  points: q.points,
  timeSec: q.timeSec,
});

// عرض السؤال لصاحبه (يشمل حالته وسبب الرفض)
export const ownQuestion = (q) => ({ ...publicQuestion(q), status: q.status, rejectReason: q.rejectReason });

// عرض السؤال للإدارة
export const adminQuestion = (q) => ({
  ...ownQuestion(q),
  ownerId: q.ownerId,
  ownerName: q.ownerName,
  createdAt: q.createdAt,
  updatedAt: q.updatedAt,
});

export const publicAccount = (h) => ({
  id: h.id,
  username: h.username,
  displayName: h.displayName,
  role: h.role,
  isBanned: !h.active,
  createdAt: h.createdAt,
  lastLoginAt: h.lastLoginAt,
});
