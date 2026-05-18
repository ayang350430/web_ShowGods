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

  async function doReAuthenticate() {
    console.warn('Access token or refresh token is invalid or expired.');

    const accessStore = useAccessStore();
    const authStore = useAuthStore();

    accessStore.setAccessToken(null);

    if (
      preferences.app.loginExpiredMode === 'modal' &&
      accessStore.isAccessChecked
    ) {
      accessStore.setLoginExpired(true);
    } else {
      await authStore.logout();
    }
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

      config.headers.Authorization = formatToken(accessStore.accessToken);
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
      const responseData = error?.response?.data ?? {};
      const errorMessage = responseData?.error ?? responseData?.message ?? '';

      ElMessage.error(errorMessage || msg);
    }),
  );

  return client;
}

export const requestClient = createRequestClient(apiURL, {
  responseReturn: 'data',
});

export const baseRequestClient = new RequestClient({ baseURL: apiURL });
attachBackendLoading(baseRequestClient);
