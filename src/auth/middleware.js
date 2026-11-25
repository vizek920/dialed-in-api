import { verifyToken } from './tokens.js';

// يقرأ رمز الدخول من ترويسة Authorization: Bearer ...
export function readBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
}

// يسمح فقط بالأدوار المذكورة. يعيد قراءة الحساب من المتجر في كل طلب،
// فإيقاف حساب أو تغيير دوره يسري فورًا حتى لو رمزه لم ينتهِ بعد.
export function requireRole(hostStore, ...roles) {
  return async (req, res, next) => {
    try {
      const token = readBearer(req);
      if (!token) return res.status(401).json({ error: 'unauthorized' });
      const account = await hostStore.findById(token.sub);
      if (!account || !account.active) return res.status(401).json({ error: 'unauthorized' });
      if (!roles.includes(account.role)) return res.status(403).json({ error: 'forbidden' });
      req.user = { id: account.id, username: account.username, displayName: account.displayName, role: account.role };
      next();
    } catch (err) {
      next(err);
    }
  };
}
