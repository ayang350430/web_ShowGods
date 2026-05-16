require('dotenv').config();

const app = require('./app');
const { closePool, initializeDatabase } = require('./config/database');

const port = Number(process.env.PORT) || 3000;

let server;

// 启动服务器
const startServer = async () => {
  await initializeDatabase();

  server = app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
  });
};

// 关闭服务器
const shutdown = async (signal) => {
  console.log(`${signal} received, closing server...`);

  if (server) {
    server.close(async () => {
      await closePool();
      console.log('Server closed');
      process.exit(0);
    });
    return;
  }

  await closePool();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
