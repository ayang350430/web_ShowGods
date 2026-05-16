<script lang="ts" setup>
import type { TabOption } from '@vben/types';
import type { Component } from 'vue';

import type { DashboardApi } from '#/api';

import { computed, onMounted, ref } from 'vue';

import {
  AnalysisChartCard,
  AnalysisChartsTabs,
} from '@vben/common-ui';
import {
  SvgBellIcon,
  SvgCakeIcon,
  SvgCardIcon,
  SvgDownloadIcon,
} from '@vben/icons';
import { preferences } from '@vben/preferences';
import { useUserStore } from '@vben/stores';

import {
  getDashboardRankingsApi,
  getDashboardSummaryApi,
  getTodayWeatherApi,
} from '#/api';

import AnalyticsTrends from './analytics-trends.vue';
import AnalyticsVisitsData from './analytics-visits-data.vue';
import AnalyticsVisitsSales from './analytics-visits-sales.vue';
import AnalyticsVisitsSource from './analytics-visits-source.vue';
import AnalyticsVisits from './analytics-visits.vue';

interface ChartDatum {
  name: string;
  value: number;
}

interface OverviewCard {
  icon: Component;
  kind: 'money' | 'number';
  title: string;
  totalTitle: string;
  totalValue: number;
  value: number;
}

const emptyMetrics: DashboardApi.DashboardMetrics = {
  available_balance: 0,
  completed_total: 0,
  failed_total: 0,
  manual_review_total: 0,
  order_amount_all: 0,
  order_amount_today: 0,
  order_amount_yesterday: 0,
  order_quantity_all: 0,
  order_quantity_today: 0,
  order_quantity_yesterday: 0,
  order_total: 0,
  recent_net_amount: 0,
  refund_approved_total: 0,
  refunding_total: 0,
  retryable_batch_items: 0,
  running_total: 0,
  xhs_active_total: 0,
  xhs_cooling_total: 0,
  xhs_disabled_total: 0,
  xhs_invalid_total: 0,
  xhs_total: 0,
};

const userStore = useUserStore();
const summary = ref<DashboardApi.DashboardSummary>();
const rankings = ref<DashboardApi.DashboardRankings>();
const weather = ref<DashboardApi.TodayWeather>();

const metrics = computed(() => summary.value?.metrics ?? emptyMetrics);
const todoText = computed(() => {
  return `${metrics.value.completed_total}/${metrics.value.order_total}`;
});
const weatherText = computed(() => {
  if (!weather.value) {
    return '今日天气加载中...';
  }

  return `${weather.value.city}，当前 ${weather.value.current_temperature}${weather.value.unit}，今日 ${weather.value.temperature_min}${weather.value.unit} - ${weather.value.temperature_max}${weather.value.unit}`;
});

function formatMoney(value?: number) {
  return `￥ ${(Number(value) || 0).toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatNumber(value?: number) {
  return (Number(value) || 0).toLocaleString('zh-CN');
}

function formatOverviewValue(card: OverviewCard, value: number) {
  return card.kind === 'money' ? formatMoney(value) : formatNumber(value);
}

const chartTabs: TabOption[] = [
  {
    label: '订单趋势',
    value: 'trends',
  },
  {
    label: '用户排行',
    value: 'visits',
  },
];

const overviewItems = computed<OverviewCard[]>(() => [
  {
    icon: SvgCardIcon,
    kind: 'number',
    title: '订单总数',
    totalTitle: '已完成订单',
    totalValue: metrics.value.completed_total,
    value: metrics.value.order_total,
  },
  {
    icon: SvgCakeIcon,
    kind: 'number',
    title: '进行中订单',
    totalTitle: '异常/审核订单',
    totalValue:
      metrics.value.failed_total +
      metrics.value.manual_review_total +
      metrics.value.refunding_total +
      metrics.value.refund_approved_total,
    value: metrics.value.running_total,
  },
  {
    icon: SvgDownloadIcon,
    kind: 'number',
    title: '今日下单量',
    totalTitle: '累计下单量',
    totalValue: metrics.value.order_quantity_all,
    value: metrics.value.order_quantity_today,
  },
  {
    icon: SvgBellIcon,
    kind: 'money',
    title: '今日消费',
    totalTitle: '可用余额',
    totalValue: metrics.value.available_balance,
    value: metrics.value.order_amount_today,
  },
]);

const trendCategories = computed(() => ['昨日', '今日', '累计']);
const quantityTrendData = computed(() => [
  metrics.value.order_quantity_yesterday,
  metrics.value.order_quantity_today,
  metrics.value.order_quantity_all,
]);
const amountTrendData = computed(() => [
  metrics.value.order_amount_yesterday,
  metrics.value.order_amount_today,
  metrics.value.order_amount_all,
]);

const rankingRows = computed(
  () => rankings.value?.rankings_by_amount.slice(0, 10) ?? [],
);
const rankingCategories = computed(() =>
  rankingRows.value.length > 0
    ? rankingRows.value.map((item) => item.display_name || item.username)
    : ['暂无数据'],
);
const rankingAmountData = computed(() =>
  rankingRows.value.length > 0
    ? rankingRows.value.map((item) => item.charge_amount_total)
    : [0],
);
const rankingQuantityData = computed(() =>
  rankingRows.value.length > 0
    ? rankingRows.value.map((item) => item.ordered_quantity_total)
    : [0],
);

const orderStatusData = computed<ChartDatum[]>(() => [
  { name: '进行中', value: metrics.value.running_total },
  { name: '已完成', value: metrics.value.completed_total },
  { name: '失败', value: metrics.value.failed_total },
  { name: '人工审核', value: metrics.value.manual_review_total },
  { name: '退款中', value: metrics.value.refunding_total },
]);

const xhsAccountData = computed<ChartDatum[]>(() => [
  { name: '可用', value: metrics.value.xhs_active_total },
  { name: '冷却中', value: metrics.value.xhs_cooling_total },
  { name: '失效', value: metrics.value.xhs_invalid_total },
  { name: '已禁用', value: metrics.value.xhs_disabled_total },
]);

const amountBreakdownData = computed<ChartDatum[]>(() => {
  const historicalAmount = Math.max(
    metrics.value.order_amount_all -
      metrics.value.order_amount_today -
      metrics.value.order_amount_yesterday,
    0,
  );

  return [
    { name: '今日消费', value: metrics.value.order_amount_today },
    { name: '昨日消费', value: metrics.value.order_amount_yesterday },
    { name: '历史消费', value: historicalAmount },
  ];
});

function getBrowserLocation() {
  if (!navigator.geolocation) {
    return Promise.resolve(undefined);
  }

  return new Promise<{ latitude: number; longitude: number } | undefined>(
    (resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
        },
        () => {
          resolve(undefined);
        },
        {
          enableHighAccuracy: false,
          maximumAge: 10 * 60 * 1000,
          timeout: 1200,
        },
      );
    },
  );
}

async function loadDashboard() {
  void getDashboardRankingsApi({
    ranking_period: 'all',
    target_type: 'all',
  })
    .then((rankingsData) => {
      rankings.value = rankingsData;
    })
    .catch(() => {
      rankings.value = undefined;
    });

  void getBrowserLocation()
    .then((location) => getTodayWeatherApi(location))
    .catch(() => getTodayWeatherApi())
    .then((weatherData) => {
      weather.value = weatherData;
    });

  summary.value = await getDashboardSummaryApi({ ranking_period: 'all' });
}

onMounted(() => {
  void loadDashboard();
});
</script>

<template>
  <div class="p-5">
    <div class="card-box flex items-center p-4 py-6">
      <img
        :src="userStore.userInfo?.avatar || preferences.app.defaultAvatar"
        alt="avatar"
        class="size-20 rounded-full"
      />
      <div class="ml-6 flex flex-col justify-center">
        <h1 class="text-md font-semibold md:text-xl">
          早安, {{ userStore.userInfo?.realName }}, 开始您一天的工作吧!
        </h1>
        <span class="mt-1 text-foreground/80">
          {{ weatherText }}
        </span>
      </div>
      <div class="ml-auto flex flex-col justify-center text-right">
        <span class="text-foreground/80"> 待办 </span>
        <span class="text-2xl">{{ todoText }}</span>
      </div>
    </div>

    <div class="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      <div
        v-for="item in overviewItems"
        :key="item.title"
        class="card-box flex min-h-32 flex-col justify-between p-5"
      >
        <div class="flex items-start justify-between gap-4">
          <h2 class="text-xl font-semibold">{{ item.title }}</h2>
          <component :is="item.icon" class="size-8 shrink-0 text-primary" />
        </div>
        <strong class="mt-6 text-2xl font-semibold">
          {{ formatOverviewValue(item, item.value) }}
        </strong>
        <div class="mt-5 flex items-center justify-between text-sm text-foreground/70">
          <span>{{ item.totalTitle }}</span>
          <span>{{ formatOverviewValue(item, item.totalValue) }}</span>
        </div>
      </div>
    </div>
    <AnalysisChartsTabs :tabs="chartTabs" class="mt-5">
      <template #trends>
        <AnalyticsTrends
          :amount-data="amountTrendData"
          :categories="trendCategories"
          :quantity-data="quantityTrendData"
        />
      </template>
      <template #visits>
        <AnalyticsVisits
          :amount-data="rankingAmountData"
          :categories="rankingCategories"
          :quantity-data="rankingQuantityData"
        />
      </template>
    </AnalysisChartsTabs>

    <div class="mt-5 w-full md:flex">
      <AnalysisChartCard class="mt-5 md:mt-0 md:mr-4 md:w-1/3" title="订单状态">
        <AnalyticsVisitsSource :data="orderStatusData" />
      </AnalysisChartCard>
      <AnalysisChartCard class="mt-5 md:mt-0 md:mr-4 md:w-1/3" title="小红书账号池">
        <AnalyticsVisitsSales :data="xhsAccountData" />
      </AnalysisChartCard>
      <AnalysisChartCard class="mt-5 md:mt-0 md:w-1/3" title="金额分布">
        <AnalyticsVisitsData :data="amountBreakdownData" />
      </AnalysisChartCard>
    </div>
  </div>
</template>
