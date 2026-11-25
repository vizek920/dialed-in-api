import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { fail } from '../game/errors.js';
import { validateQuestion } from '../game/validate.js';
import { ownQuestion, publicQuestion, wrap } from './util.js';

const MAX_MINE = 150; // أسئلة المضيف الشخصية
const MAX_PENDING = 20; // مقترحاته المعلّقة في آن واحد

// بنك الأسئلة من جهة المضيف: يتصفح بنك الموقع، ويدير قائمته الشخصية، ويقترح أسئلة للبنك.
export default function bankRouter(bankStore, hostStore) {
  const router = Router();
  router.use('/bank', requireRole(hostStore, 'host', 'moderator', 'admin'));

  // التصنيفات الفعّالة مع عدد الأسئلة المعتمدة في كل منها
  router.get('/bank/categories', wrap(async (_req, res) => {
    const [cats, approved] = await Promise.all([
      bankStore.listCategories({ activeOnly: true }),
      bankStore.listQuestions({ status: 'approved' }),
    ]);
    const counts = new Map();
    for (const q of approved) counts.set(q.categoryId, (counts.get(q.categoryId) || 0) + 1);
    res.json({ categories: cats.map((c) => ({ id: c.id, name: c.name, count: counts.get(c.id) || 0 })) });
  }));

  // أسئلة بنك الموقع المعتمدة
  router.get('/bank/questions', wrap(async (req, res) => {
    const filter = { status: 'approved', limit: 300 };
    if (typeof req.query.categoryId === 'string' && req.query.categoryId) filter.categoryId = req.query.categoryId;
    if (typeof req.query.q === 'string') filter.search = req.query.q.slice(0, 40);
    const list = await bankStore.listQuestions(filter);
    res.json({ questions: list.map(publicQuestion) });
  }));

  // قائمتي الشخصية
  router.get('/bank/mine', wrap(async (req, res) => {
    const list = await bankStore.listQuestions({ ownerId: req.user.id });
    res.json({ questions: list.map(ownQuestion) });
  }));

  router.post('/bank/mine', wrap(async (req, res) => {
    if ((await bankStore.countQuestions({ ownerId: req.user.id })) >= MAX_MINE) fail('too_many_questions');
    const q = validateQuestion(req.body);
    const created = await bankStore.createQuestion({
      ...q,
      ownerId: req.user.id,
      ownerName: req.user.displayName,
      categoryId: null,
      status: 'private',
    });
    res.status(201).json({ question: ownQuestion(created) });
  }));

  // سؤالي: لا يُعدَّل ولا يُحذف إن كان معتمدًا في البنك العام
  const mineOf = async (req) => {
    const q = await bankStore.getQuestion(req.params.id);
    if (!q || q.ownerId !== req.user.id) fail('not_found');
    return q;
  };

  router.patch('/bank/mine/:id', wrap(async (req, res) => {
    const q = await mineOf(req);
    if (q.status === 'pending' || q.status === 'approved') fail('question_locked');
    const next = validateQuestion({ ...q, ...req.body });
    const updated = await bankStore.updateQuestion(q.id, { ...next, status: 'private', rejectReason: null });
    res.json({ question: ownQuestion(updated) });
  }));

  router.delete('/bank/mine/:id', wrap(async (req, res) => {
    const q = await mineOf(req);
    if (q.status === 'approved') fail('question_locked');
    await bankStore.deleteQuestion(q.id);
    res.json({ ok: true });
  }));

  // اقتراح سؤال للبنك العام (يمرّ بمراجعة المشرف)
  router.post('/bank/mine/:id/suggest', wrap(async (req, res) => {
    const q = await mineOf(req);
    if (q.status !== 'private' && q.status !== 'rejected') fail('question_locked');
    const cat = await bankStore.getCategory(req.body?.categoryId);
    if (!cat || !cat.isActive) fail('bad_category');
    if ((await bankStore.countQuestions({ ownerId: req.user.id, status: 'pending' })) >= MAX_PENDING) fail('too_many_pending');
    const updated = await bankStore.updateQuestion(q.id, { categoryId: cat.id, status: 'pending', rejectReason: null });
    res.json({ question: ownQuestion(updated) });
  }));

  return router;
}
