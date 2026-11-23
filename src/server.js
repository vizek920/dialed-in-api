import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { config, isAllowedOrigin } from './config.js';
import healthRouter from './routes/health.js';
import { registerSockets } from './sockets/index.js';

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

app.get('/', (_req, res) => res.json({ name: 'Dialed In API' }));
app.use(healthRouter);

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
});
registerSockets(io);

server.listen(config.port, () => {
  console.log(`Dialed In API listening on :${config.port}`);
});

// إغلاق نظيف عند إيقاف Render للخادم
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    io.close(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
