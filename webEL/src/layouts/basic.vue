<script lang="ts" setup>
import type { NotificationItem } from '@vben/layouts';

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { AuthenticationLoginExpiredModal } from '@vben/common-ui';
import { useWatermark } from '@vben/hooks';
import {
  BasicLayout,
  LockScreen,
  Notification,
  UserDropdown,
} from '@vben/layouts';
import { preferences, usePreferences } from '@vben/preferences';
import { useAccessStore, useUserStore } from '@vben/stores';

import { ElNotification } from 'element-plus';

import { $t } from '#/locales';
import { getUserNotificationsApi } from '#/api';
import { useAuthStore } from '#/store';
import LoginForm from '#/views/_core/authentication/login.vue';

const notifications = ref<NotificationItem[]>([]);
const notificationPollInterval = 5_000;
let hasLoadedNotifications = false;
let notificationPollTimer: number | undefined;

const router = useRouter();
const userStore = useUserStore();
const authStore = useAuthStore();
const accessStore = useAccessStore();
const { destroyWatermark, updateWatermark } = useWatermark();
const { isDark } = usePreferences();
const showDot = computed(() =>
  notifications.value.some((item) => !item.isRead),
);

const menus = computed(() => [
  {
    handler: () => {
      router.push({ name: 'Profile' });
    },
    icon: 'lucide:user',
    text: $t('page.auth.profile'),
  },
]);

const avatar = computed(() => {
  return userStore.userInfo?.avatar ?? preferences.app.defaultAvatar;
});

function getNotificationStorageKey() {
  const userId = userStore.userInfo?.userId || userStore.userInfo?.username || 'guest';
  return `goods:notifications:${userId}`;
}

function readNotificationState() {
  try {
    const raw = localStorage.getItem(getNotificationStorageKey());
    const state = raw ? JSON.parse(raw) : {};
    return {
      readIds: new Set<string>(state.readIds || []),
      removedIds: new Set<string>(state.removedIds || []),
    };
  } catch {
    return {
      readIds: new Set<string>(),
      removedIds: new Set<string>(),
    };
  }
}

function saveNotificationState(readIds: Set<string>, removedIds: Set<string>) {
  localStorage.setItem(
    getNotificationStorageKey(),
    JSON.stringify({
      readIds: [...readIds],
      removedIds: [...removedIds],
    }),
  );
}

function notificationAvatar(type?: string) {
  const textMap: Record<string, string> = {
    danger: '!',
    info: 'IN',
    success: 'OK',
    warning: '!',
  };
  return `https://avatar.vercel.sh/goods-${type || 'info'}.svg?text=${encodeURIComponent(textMap[type || 'info'] || 'IN')}`;
}

async function loadNotifications(silent = false) {
  const { readIds, removedIds } = readNotificationState();
  const previousIds = new Set(notifications.value.map((item) => String(item.id)));
  const data = await getUserNotificationsApi({ silent });
  const nextNotifications = data
    .filter((item) => !removedIds.has(String(item.id)))
    .map((item) => ({
      ...item,
      avatar: notificationAvatar(item.type),
      isRead: readIds.has(String(item.id)),
    }));

  notifications.value = nextNotifications;

  if (hasLoadedNotifications) {
    const urgentNotification = nextNotifications.find(
      (item) =>
        item.id &&
        !item.isRead &&
        !previousIds.has(String(item.id)) &&
        (item.title === '退款待审核' || item.link === '/orders/refunds'),
    );

    if (urgentNotification) {
      ElNotification({
        duration: 0,
        message: urgentNotification.message || '有新的退款申请需要处理',
        title: '新的退款申请',
        type: 'warning',
      });
    }
  }

  hasLoadedNotifications = true;
}

async function handleLogout() {
  await authStore.logout(false);
}

function handleNoticeClear() {
  const { readIds, removedIds } = readNotificationState();
  notifications.value.forEach((item) => {
    if (item.id) {
      removedIds.add(String(item.id));
    }
  });
  saveNotificationState(readIds, removedIds);
  notifications.value = [];
}

function markRead(id: number | string) {
  const { readIds, removedIds } = readNotificationState();
  readIds.add(String(id));
  saveNotificationState(readIds, removedIds);
  const item = notifications.value.find((item) => item.id === id);
  if (item) {
    item.isRead = true;
  }
}

function remove(id: number | string) {
  const { readIds, removedIds } = readNotificationState();
  removedIds.add(String(id));
  saveNotificationState(readIds, removedIds);
  notifications.value = notifications.value.filter((item) => item.id !== id);
}

function handleMakeAll() {
  const { readIds, removedIds } = readNotificationState();
  notifications.value.forEach((item) => {
    if (item.id) {
      readIds.add(String(item.id));
    }
    item.isRead = true;
  });
  saveNotificationState(readIds, removedIds);
}

const viewAll = () => {
  router.push('/orders/refunds');
};

const handleClick = (item: NotificationItem) => {
  if (item.id) {
    markRead(item.id);
  }
  if (item.link) {
    navigateTo(item.link, item.query, item.state);
  }
};

function navigateTo(
  link: string,
  query?: Record<string, any>,
  state?: Record<string, any>,
) {
  if (link.startsWith('http://') || link.startsWith('https://')) {
    // 外部链接，在新标签页打开
    window.open(link, '_blank');
  } else {
    // 内部路由链接，支持 query 参数和 state
    router.push({
      path: link,
      query: query || {},
      state,
    });
  }
}

onMounted(() => {
  void loadNotifications();
  notificationPollTimer = window.setInterval(() => {
    void loadNotifications(true);
  }, notificationPollInterval);
});

onBeforeUnmount(() => {
  if (notificationPollTimer) {
    window.clearInterval(notificationPollTimer);
    notificationPollTimer = undefined;
  }
});

watch(
  () => ({
    enable: preferences.app.watermark,
    content: preferences.app.watermarkContent,
    isDark: isDark.value,
  }),
  async ({ enable, content, isDark: isDarkValue }) => {
    if (enable) {
      const watermarkColor = isDarkValue
        ? 'rgba(255, 255, 255, 0.12)'
        : 'rgba(0, 0, 0, 0.12)';

      await updateWatermark({
        advancedStyle: {
          colorStops: [
            {
              color: watermarkColor,
              offset: 0,
            },
            {
              color: watermarkColor,
              offset: 1,
            },
          ],
          type: 'linear',
        },
        content:
          content ||
          `${userStore.userInfo?.username} - ${userStore.userInfo?.realName}`,
      });
    } else {
      destroyWatermark();
    }
  },
  {
    immediate: true,
  },
);
</script>

<template>
  <BasicLayout @clear-preferences-and-logout="handleLogout">
    <template #user-dropdown>
      <UserDropdown
        :avatar
        :menus
        :text="userStore.userInfo?.realName"
        description="ann.vben@gmail.com"
        tag-text="Pro"
        @logout="handleLogout"
      />
    </template>
    <template #notification>
      <Notification
        :dot="showDot"
        :notifications="notifications"
        @clear="handleNoticeClear"
        @read="(item) => item.id && markRead(item.id)"
        @remove="(item) => item.id && remove(item.id)"
        @make-all="handleMakeAll"
        @on-click="handleClick"
        @view-all="viewAll"
      />
    </template>
    <template #extra>
      <AuthenticationLoginExpiredModal
        v-model:open="accessStore.loginExpired"
        :avatar
      >
        <LoginForm />
      </AuthenticationLoginExpiredModal>
    </template>
    <template #lock-screen>
      <LockScreen :avatar @to-login="handleLogout" />
    </template>
  </BasicLayout>
</template>
