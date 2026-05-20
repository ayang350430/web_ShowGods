const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const DEFAULT_SECRET = crypto.randomBytes(32).toString('hex');
const getSecret = () => process.env.JWT_SECRET || DEFAULT_SECRET;
const ACCESS_EXPIRES = '7d';
const REFRESH_EXPIRES = '30d';

function signAccessToken(userId) {
  return jwt.sign({ uid: userId, type: 'access' }, getSecret(), {
    expiresIn: ACCESS_EXPIRES,
  });
}

function signRefreshToken(userId) {
  return jwt.sign({ uid: userId, type: 'refresh' }, getSecret(), {
    expiresIn: REFRESH_EXPIRES,
  });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

function verifyTokenIgnoreExpiry(token) {
  return jwt.verify(token, getSecret(), { ignoreExpiration: true });
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  verifyTokenIgnoreExpiry,
};
