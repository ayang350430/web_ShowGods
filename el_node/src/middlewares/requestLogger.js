const fs = require('fs');
const path = require('path');

const defaultLogDir = path.resolve(process.cwd(), 'logs');
const logDir = process.env.REQUEST_LOG_DIR || defaultLogDir;

const pad = (value) => String(value).padStart(2, '0');

const formatLogDate = (date = new Date()) => {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const getDurationMs = (startTime) => {
  return Number(process.hrtime.bigint() - startTime) / 1_000_000;
};

const getCurrentUserId = (req) => {
  return req.user?.id || req.user?.user_id || req.headers['x-user-id'] || null;
};
const cleanupOldRequestLogs = async () => {
  try {
    await fs.promises.mkdir(logDir, { recursive: true });
    const files = await fs.promises.readdir(logDir);
    const today = new Date();
    const retentionStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);

    await Promise.all(
      files
        .filter((file) => /^request-\d{4}-\d{2}-\d{2}\.log$/.test(file))
        .map(async (file) => {
          const match = file.match(/^request-(\d{4})-(\d{2})-(\d{2})\.log$/);
          if (!match) {
            return;
          }

          const [, year, month, day] = match;
          const fileDate = new Date(Number(year), Number(month) - 1, Number(day));
          if (fileDate < retentionStart) {
            await fs.promises.unlink(path.join(logDir, file));
          }
        }),
    );
  } catch (error) {
    console.error('[request-log] failed to cleanup old log files', error);
  }
};

const writeRequestLog = async (entry) => {
  try {
    await cleanupOldRequestLogs();
    const filePath = path.join(logDir, `request-${formatLogDate(new Date(entry.time))}.log`);
    await fs.promises.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('[request-log] failed to write log file', error);
  }
};

const requestLogger = (req, res, next) => {
  const startedAt = new Date();
  const startTime = process.hrtime.bigint();
  const requestId = `${startedAt.getTime()}-${Math.random().toString(16).slice(2, 10)}`;

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  res.on('finish', () => {
    const durationMs = Math.round(getDurationMs(startTime) * 100) / 100;
    const statusCode = res.statusCode;
    const success = statusCode < 400;
    const entry = {
      duration_ms: durationMs,
      ip: req.ip || req.socket?.remoteAddress || '',
      level: success ? 'info' : 'error',
      method: req.method,
      path: req.originalUrl || req.url,
      request_id: requestId,
      status_code: statusCode,
      success,
      time: startedAt.toISOString(),
      user_agent: req.get('user-agent') || '',
      user_id: getCurrentUserId(req),
    };

    const message = `[${entry.time}] ${success ? 'SUCCESS' : 'FAILED'} ${entry.method} ${entry.path} ${entry.status_code} ${entry.duration_ms}ms request_id=${entry.request_id}`;
    if (success) {
      console.log(message);
    } else {
      console.error(message);
    }

    void writeRequestLog(entry);
  });

  next();
};

module.exports = {
  requestLogger,
  cleanupOldRequestLogs,
  writeRequestLog,
};

