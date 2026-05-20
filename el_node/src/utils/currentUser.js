const { verifyToken } = require('./jwt');

const getCurrentUserId = (req) => {
  const authorization = req.headers.authorization || '';
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token) {
    return 0;
  }

  try {
    const payload = verifyToken(token);
    return Number(payload.uid) || 0;
  } catch {
    return 0;
  }
};

module.exports = {
  getCurrentUserId,
};
