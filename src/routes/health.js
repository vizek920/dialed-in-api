import { Router } from 'express';

const startedAt = Date.now();
const router = Router();

// يستخدمه Render لفحص الصحة، ويوقظ الخادم إذا كان نائمًا
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'dialed-in-api',
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  });
});

export default router;
