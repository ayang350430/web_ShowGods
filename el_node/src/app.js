const express = require('express');// 引入express框架
const cors = require('cors');// 引入cors中间件
const helmet = require('helmet'); // 引入helmet中间件
const routes = require('./routes');
const { requestLogger } = require('./middlewares/requestLogger');
// 引入错误处理中间件
const { notFoundHandler, errorHandler } = require('./middlewares/errorHandlers');

// 初始化应用
const app = express();

// 应用中间件
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

