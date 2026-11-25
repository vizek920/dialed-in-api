import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { config, isAllowedOrigin } from './config.js';
import healthRouter from './routes/health.js';
import roomsRouter from './routes/rooms.js';
import hostRouter from './routes/host.js';
import bankRouter from './routes/bank.js';
import adminRouter from './routes/admin.js';
import { MemoryBankStore } from './store/memoryBank.js';
import { hostStoreFromEnv } from './auth/hostStore.js';
import { RoomManager } from './game/roomManager.js';
import { registerSockets } from './sockets/index.js';

// ينشئ التطبيق كاملًا دون تشغيله (ليسهل اختباره)
export function createApp({ hostStore = hostStoreFromEnv(), bankStore = new MemoryBankStore() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render يعمل خلف وسيط
  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        cb(null, isAllowedOrigin(origin));
      },
    })
  );
  app.use(express.json({ limit: '50kb' }));

  const manager = new RoomManager();

  app.get('/', (_req, res) => res.json({ name: 'Dialed In API' }));
  app.use(healthRouter);
  app.use('/api', roomsRouter(manager));
  app.use('/api', hostRouter(hostStore));
  app.use('/api', bankRouter(bankStore, hostStore));
  app.use('/api', adminRouter({ manager, bankStore, hostStore }));

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ error: 'server_error' });
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin(origin, cb) {
        cb(null, isAllowedOrigin(origin));
      },
    },
    pingInterval: 20000,
    pingTimeout: 20000,
    maxHttpBufferSize: 1e5, // 100KB تكفي لأي رسالة لعبة
  });
  registerSockets(io, manager, hostStore);

  return { app, server, io, manager };
}

// تشغيل مباشر (npm start)
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, io, manager } = createApp();
  server.listen(config.port, () => {
    console.log(`Dialed In API listening on :${config.port}`);
  });

  // إغلاق نظيف عند إيقاف Render للخادم
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      manager.shutdown();
      io.close(() => server.close(() => process.exit(0)));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
