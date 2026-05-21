const path = require('node:path');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const routes = require('./routes');
const { requestLogger } = require('./middlewares/requestLogger');
const { notFoundHandler, errorHandler } = require('./middlewares/errorHandlers');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

app.use('/api', routes);
// 静态托管前端文件
const distDir = process.env.DIST_DIR || path.join(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;