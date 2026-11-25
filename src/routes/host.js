import { Router } from 'express';
import { signToken } from '../auth/tokens.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { requireRole } from '../auth/middleware.js';

export { readBearer } from '../auth/middleware.js';

const MAX_FAILS = 8;
const WINDOW_MS = 15 * 60_000;
const DUMMY_HASH = hashPassword('dummy-password');

// دخول المضيف/المشرف/المدير: اسم مستخدم وكلمة مرور → رمز. محاولات الفشل محدودة لكل عنوان واسم.
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
      await hostStore.touchLogin?.(host.id);
      const token = signToken({ sub: host.id, name: host.displayName, role: host.role });
      res.json({
        token,
        host: { id: host.id, username: host.username, displayName: host.displayName, role: host.role },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/host/me', requireRole(hostStore, 'host', 'moderator', 'admin'), (req, res) => {
    res.json({ host: req.user });
  });

  return router;
}
