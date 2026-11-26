import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { loadServerConfig } from './src/server/config.ts';
import { createServerDatabase } from './src/server/db.ts';
import { createApiExpressApp } from './src/server/app.ts';
import { startScheduler } from './src/server/scheduler.ts';

async function startServer() {
  const config = loadServerConfig();
  const db = await createServerDatabase(config, {
    inMemory: false,
    // Demo/seed data must never be created in production.
    seedDemo: !config.isProduction,
  });

  const app = createApiExpressApp(db);

  const schedulerHandle = startScheduler(db);

  if (!config.isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Production build missing. Run npm run build first.');
      }
    });
  }

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[Printing Management System] Full-stack server running at http://0.0.0.0:${config.port} (${config.nodeEnv})`
    );
  });

  const shutdown = async () => {
    schedulerHandle.stop();
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Surface fatal runtime errors instead of dying silently.
  process.on('unhandledRejection', reason => {
    console.error('[Fatal] Unhandled promise rejection:', reason);
    process.exit(1);
  });
  process.on('uncaughtException', err => {
    console.error('[Fatal] Uncaught exception:', err);
    process.exit(1);
  });
}

startServer().catch(err => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
