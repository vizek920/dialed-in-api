import { Router } from 'express';

// مسارات الغرف (قراءة فقط؛ اللعب نفسه عبر Socket.IO)
export default function roomsRouter(manager) {
  const router = Router();

  router.get('/rooms/public', (_req, res) => {
    res.json({ rooms: manager.listPublic() });
  });

  router.get('/rooms/:code/exists', (req, res) => {
    const room = manager.get(req.params.code);
    res.json({
      exists: Boolean(room),
      joinable: Boolean(room && room.phase !== 'finished' && !room.locked && !room.isFull()),
    });
  });

  return router;
}
