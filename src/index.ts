import { createApp } from './app';
import { env } from './config/env';
import { pool } from './db/pool';
import { startOutboxPoller, stopOutboxPoller } from './modules/notifications/notification.service';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`🚀 Reneo API running on port ${env.PORT} (${env.NODE_ENV})`);
  startOutboxPoller();
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received — shutting down gracefully`);
  stopOutboxPoller();
  server.close(async () => {
    await pool.end();
    console.log('✅ Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
  process.exit(1);
});
