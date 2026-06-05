import type { RequestClientOptions } from '@vben/request';

import { useAppConfig } from '@vben/hooks';
import { preferences } from '@vben/preferences';
import {
  authenticateResponseInterceptor,
  defaultResponseInterceptor,
  errorMessageResponseInterceptor,
  RequestClient,
} from '@vben/request';
import { useAccessStore } from '@vben/stores';

import { ElLoading, ElMessage } from 'element-plus';

import { useAuthStore } from '#/store';

import { refreshTokenApi } from './core';

const { apiURL } = useAppConfig(import.meta.env, import.meta.env.PROD);

let activeBackendRequests = 0;
let backendLoading: ReturnType<typeof ElLoading.service> | undefined;
// 登录失效处理中的标记，避免并发请求重复弹窗/重复跳转
let loginExpiredHandling = false;

function shouldSkipBackendLoading(config: any) {
  return Boolean(config?.skipBackendLoading);
}

function showBackendLoading() {
  activeBackendRequests += 1;
  if (!backendLoading) {
    backendLoading = ElLoading.service({
      background: 'rgba(0, 0, 0, 0.28)',
      lock: true,
      text: '加载中...',
    });
  }
}

function hideBackendLoading() {
  activeBackendRequests = Math.max(0, activeBackendRequests - 1);
  if (activeBackendRequests === 0 && backendLoading) {
    backendLoading.close();
    backendLoading = undefined;
  }
}

function isAbortLikeError(error: any) {
  const message = String(error?.message || '').toLowerCase();
  return (
    error?.code === 'ERR_CANCELED' ||
    error?.name === 'AbortError' ||
    error?.name === 'CanceledError' ||
    message.includes('aborted') ||
    message.includes('canceled') ||
    message.includes('cancelled')
  );
}

// 解析 JWT payload（不校验签名，仅用于前端读取过期时间做预判）
function decodeJwtPayload(token: string): null | Record<string, any> {
  const parts = token.split('.');
  const payloadPart = parts[1];
  if (parts.length !== 3 || !payloadPart) {
    return null;
  }
  try {
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4 ? '='.repeat(4 - (base64.length % 4)) : '';
    const json = decodeURIComponent(
      atob(base64 + pad)
        .split('')
        .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
        .join(''),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// 判断 token 是否已过期（提前 5 秒，留出时钟误差）。
// 非标准 JWT 或无 exp 字段时返回 false，交由后端 401 判定。
function isJwtExpired(token?: null | string): boolean {
  if (!token) {
    return true;
  }
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') {
    return false;
  }
  return Date.now() >= payload.exp * 1000 - 5000;
}

function attachBackendLoading(client: RequestClient) {
  client.addRequestInterceptor({
    fulfilled: (config) => {
      if (!shouldSkipBackendLoading(config)) {
        showBackendLoading();
      }
      return config;
    },
    rejected: (error) => {
      if (!shouldSkipBackendLoading(error?.config)) {
        hideBackendLoading();
      }
      return Promise.reject(error);
    },
  });

  client.addResponseInterceptor({
    fulfilled: (response) => {
      if (!shouldSkipBackendLoading(response?.config)) {
        hideBackendLoading();
      }
      return response;
    },
    rejected: (error) => {
      if (!shouldSkipBackendLoading(error?.config)) {
        hideBackendLoading();
      }
      return Promise.reject(error);
    },
  });
}

function createRequestClient(baseURL: string, options?: RequestClientOptions) {
  const client = new RequestClient({
    ...options,
    baseURL,
  });

  attachBackendLoading(client);

  // 登录失效统一处理：提示 + 跳转登录页（带防抖，避免并发请求重复弹窗/跳转）
  async function handleLoginExpired() {
    const accessStore = useAccessStore();
    const authStore = useAuthStore();

    accessStore.setAccessToken(null);

    if (loginExpiredHandling) {
      return;
    }
    loginExpiredHandling = true;

    ElMessage.error('登录已失效，请重新登录');

    try {
      if (
        preferences.app.loginExpiredMode === 'modal' &&
        accessStore.isAccessChecked
      ) {
        accessStore.setLoginExpired(true);
      } else {
        await authStore.logout();
      }
    } finally {
      // 跳转后允许下一次会话再次提示
      setTimeout(() => {
        loginExpiredHandling = false;
      }, 3000);
    }
  }

  async function doReAuthenticate() {
    console.warn('Access token or refresh token is invalid or expired.');
    await handleLoginExpired();
  }

  async function doRefreshToken() {
    const accessStore = useAccessStore();
    const resp = await refreshTokenApi();
    const newToken = resp.data;

    accessStore.setAccessToken(newToken);
    return newToken;
  }

  function formatToken(token: null | string) {
    return token ? `Bearer ${token}` : null;
  }

  client.addRequestInterceptor({
    fulfilled: async (config) => {
      const accessStore = useAccessStore();
      const token = accessStore.accessToken;

      // 前端预校验：access 与 refresh 均已过期时，直接判定登录失效，
      // 不再发送注定 401 的请求；刷新接口自身除外（需用旧 token 去换新 token）。
      const url = typeof config.url === 'string' ? config.url : '';
      const isRefreshCall = url.includes('/auth/refresh');
      if (
        !isRefreshCall &&
        token &&
        isJwtExpired(token) &&
        isJwtExpired(accessStore.refreshToken)
      ) {
        void handleLoginExpired();
        const canceled = new Error('canceled: login expired');
        canceled.name = 'CanceledError';
        return Promise.reject(canceled);
      }

      config.headers.Authorization = formatToken(token);
      config.headers['Accept-Language'] = preferences.app.locale;
      return config;
    },
  });

  client.addResponseInterceptor(
    defaultResponseInterceptor({
      codeField: 'code',
      dataField: 'data',
      successCode: 0,
    }),
  );

  client.addResponseInterceptor(
    authenticateResponseInterceptor({
      client,
      doReAuthenticate,
      doRefreshToken,
      enableRefreshToken: preferences.app.enableRefreshToken,
      formatToken,
    }),
  );

  client.addResponseInterceptor(
    errorMessageResponseInterceptor((msg: string, error) => {
      if (isAbortLikeError(error)) {
        return;
      }
      // 401 已由登录失效处理（handleLoginExpired）统一提示，避免重复弹窗
      if (error?.response?.status === 401) {
        return;
      }
      const responseData = error?.response?.data ?? {};
      const errorMessage = responseData?.error ?? responseData?.message ?? '';

      ElMessage.error(errorMessage || msg);
    }),
  );

  return client;
}

export { apiURL };

export const requestClient = createRequestClient(apiURL, {
  responseReturn: 'data',
  timeout: 60_000,
});

export const baseRequestClient = new RequestClient({ baseURL: apiURL });
attachBackendLoading(baseRequestClient);
