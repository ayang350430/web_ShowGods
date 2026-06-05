const { getCurrentUserId } = require('../utils/currentUser');

/**
 * 登录校验中间件。
 *
 * 受保护接口在 token 缺失 / 无效 / 过期时，统一返回 HTTP 401。
 * 前端（webEL）的响应拦截器只认 HTTP 401 来触发「重新登录」流程，
 * 因此这里必须返回 401，而不是像 getCurrentUserId 那样回落成「用户0」继续放行。
 *
 * 解析逻辑复用 getCurrentUserId，保证与各业务接口的取用户逻辑完全一致。
 */
const requireAuth = (req, res, next) => {
  const userId = getCurrentUserId(req);

  if (!userId) {
    return res.status(401).json({
      code: 401,
      data: null,
      message: '登录已失效，请重新登录',
    });
  }

  req.userId = userId;
  return next();
};

module.exports = requireAuth;
