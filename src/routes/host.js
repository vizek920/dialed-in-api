import { Router } from 'express';
import { signToken, verifyToken } from '../auth/tokens.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

const DUMMY_HASH = hashPassword('dummy-password');

const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60_000;

// يقرأ رمز المضيف من ترويسة Authorization
export function readBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
}

// دخول المضيف: اسم مستخدم وكلمة مرور → رمز. محاولات الفشل محدودة لكل عنوان واسم.
export default function hostRouter(hostStore) {
  const router = Router();
  const fails = new Map(); // key → { count, first }

  const tooMany = (key) => {
    const f = fails.get(key);
    if (!f) return false;
    if (Date.now() - f.first > WINDOW_MS) {
      fails.delete(key);
      return false;
    }
    return f.count >= MAX_FAILS;
  };
  const noteFail = (key) => {
    const f = fails.get(key);
    if (!f || Date.now() - f.first > WINDOW_MS) fails.set(key, { count: 1, first: Date.now() });
    else f.count += 1;
  };

  router.post('/host/login', async (req, res, next) => {
    try {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 40) : '';
      const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
      if (!username || !password) return res.status(400).json({ error: 'bad_credentials' });

      const key = `${req.ip}|${username.toLowerCase()}`;
      if (tooMany(key)) return res.status(429).json({ error: 'too_many_attempts' });

      const host = await hostStore.findByUsername(username);
      // نتحقق دائمًا من كلمة مرور (حتى لو الحساب غير موجود) لتقليل الفروق الزمنية
      const passwordOk = verifyPassword(password, host?.passwordHash ?? DUMMY_HASH);
      const ok = Boolean(host && host.active && passwordOk);
      if (!ok) {
        noteFail(key);
        return res.status(401).json({ error: 'bad_credentials' });
      }
      fails.delete(key);
      const token = signToken({ sub: host.id, name: host.username, role: host.role });
      res.json({ token, host: { id: host.id, username: host.username, role: host.role } });
    } catch (err) {
      next(err);
    }
  });

  router.get('/host/me', (req, res) => {
    const t = readBearer(req);
    if (!t) return res.status(401).json({ error: 'unauthorized' });
    res.json({ host: { id: t.sub, username: t.name, role: t.role } });
  });

  return router;
}
