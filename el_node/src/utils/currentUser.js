const getCurrentUserId = (req) => {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer dev-token-(\d+)$/);

  return Number(match?.[1] || 1);
};

module.exports = {
  getCurrentUserId,
};
