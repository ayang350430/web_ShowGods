const authService = require('../services/auth.service');
const permissionService = require('../services/permission.service');
const { getCurrentUserId } = require('../utils/currentUser');
const { signAccessToken, signRefreshToken, verifyTokenIgnoreExpiry } = require('../utils/jwt');

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        message: 'Username and password are required',
      });
    }

    const user = await authService.login({ username, password });

    if (!user) {
      return res.status(401).json({
        message: 'Invalid username or password',
      });
    }

    return res.json({
      code: 0,
      data: {
        accessToken: signAccessToken(user.id),
        refreshToken: signRefreshToken(user.id),
      },
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const register = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        message: 'Username and password are required',
      });
    }

    const user = await authService.register({ username, password });

    return res.json({
      code: 0,
      data: user,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const getAccessCodes = async (req, res, next) => {
  try {
    const codes = await permissionService.getPermissionCodes(getCurrentUserId(req));

    return res.json({
      code: 0,
      data: codes,
      message: 'ok',
    });
  } catch (error) {
    return next(error);
  }
};

const refreshToken = (req, res) => {
  const authorization = req.headers.authorization || '';
  const token = authorization.replace(/^Bearer\s+/i, '');

  try {
    const payload = verifyTokenIgnoreExpiry(token);
    const userId = Number(payload.uid) || 0;
    if (!userId) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    return res.json({
      code: 0,
      data: signAccessToken(userId),
      message: 'ok',
    });
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

const logout = (req, res) => {
  res.json({
    code: 0,
    data: null,
    message: 'ok',
  });
};

const requestPasswordReset = async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ message: '请输入账号' });
    }
    const data = await authService.requestPasswordReset({ username });
    return res.json({ code: 0, data, message: 'ok' });
  } catch (error) {
    return next(error);
  }
};

const getPasswordResetRequests = async (req, res, next) => {
  try {
    const data = await authService.getPasswordResetRequests();
    return res.json({ code: 0, data, message: 'ok' });
  } catch (error) {
    return next(error);
  }
};

const handlePasswordResetRequest = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action, newPassword } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'action must be approve or reject' });
    }
    const data = await authService.handlePasswordResetRequest(Number(id), { action, newPassword });
    return res.json({ code: 0, data, message: 'ok' });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getAccessCodes,
  getPasswordResetRequests,
  handlePasswordResetRequest,
  login,
  logout,
  register,
  refreshToken,
  requestPasswordReset,
};
