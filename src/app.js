import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { userForToken } from './auth.js';
import { createInbox } from './inbox.js';
import { createOrders } from './orders.js';
import { apiRoutes } from './routes/api.js';
import { webhookRoutes } from './routes/webhooks.js';
import { connectRoutes } from './routes/connect.js';
import { legalRoutes } from './routes/legal.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export function createApp(db, config, { fetchImpl } = {}) {
  const app = express();
  const server = createServer(app);
  const io = new Server(server);

  const emit = (workspaceId, event, payload) => io.to(`workspace:${workspaceId}`).emit(event, payload);
  const inbox = createInbox(db, config, { emit, fetchImpl });
  const orders = createOrders(db, inbox, { emit });

  io.use((socket, next) => {
    const user = userForToken(db, socket.handshake.auth?.token);
    if (!user) return next(new Error('unauthorized'));
    socket.join(`workspace:${user.workspace_id}`);
    next();
  });

  app.disable('x-powered-by');
  // Keep the raw body so webhook signatures can be checked against the exact bytes.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use(webhookRoutes(config, inbox));
  app.use(connectRoutes(db, config, { fetchImpl, emit }));
  app.use(legalRoutes(config));
  app.use('/api', apiRoutes(db, config, inbox, orders));
  app.get('/app', (_req, res) => res.sendFile('app.html', { root: PUBLIC_DIR }));
  app.get('/bn', (_req, res) => res.sendFile('bn.html', { root: PUBLIC_DIR }));
  app.use(express.static(PUBLIC_DIR));

  return { app, server, io, inbox, orders };
}
