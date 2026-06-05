<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import {
  ElButton,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElPagination,
  ElSelect,
  ElTag,
} from 'element-plus';
import { useUserStore } from '@vben/stores';

import {
  getBatchOrderRecordsApi,
  getBatchOrdersApi,
  recheckRepairOrdersApi,
  requestOrderRefundApi,
  retryBatchOrderApi,
} from '#/api';

type OrderStatusFilter = 'all' | 'failed' | 'running' | 'success';

const loading = ref(false);
const polling = ref(false);
const router = useRouter();
const route = useRoute();
const highlightOrderNo = ref('');
const records = ref<OrderApi.BatchOrderRecord[]>([]);
const selectedBatchId = ref<number>();
const batchKeyword = ref('');
const orderKeyword = ref('');
const orderStatusFilter = ref<OrderStatusFilter>('all');
// 搜索条件
const searchBatchNo = ref('');
const searchOrderNo = ref('');
const searchNoteUrl = ref('');
const searchNoteId = ref('');
const expandedOrderIds = ref(new Set<number>());
const batchOrders = ref<OrderApi.BatchOrderRecordItem[]>([]);
const isMobile = ref(false);
const mobilePane = ref<'batches' | 'orders'>('batches');
const mobileFilterOpen = ref(false);
const recordsShellRef = ref<HTMLElement>();
const batchOrdersLoading = ref(false);
const refundLoadingId = ref<number>();
const recheckLoading = ref(false);
const retryLoading = ref(false);

const userStore = useUserStore();
const isAdmin = computed(() =>
  (userStore.userInfo?.roles ?? []).some((role: string) =>
    ['admin', 'super'].includes(role),
  ),
);

function canRequestRefund(order: OrderApi.BatchOrderRecordItem) {
  const blocked = [
    'failed',
    'refund_approved',
    'refund_calculating',
    'refund_rejected',
    'refund_requested',
    'stopping',
  ];
  if (blocked.includes(order.order_status)) return false;
  if (Number(order.refund_amount || 0) > 0) return false;
  return true;
}

async function handleRequestRefund(order: OrderApi.BatchOrderRecordItem) {
  try {
    await ElMessageBox.confirm(
      `确定要对订单 ${order.order_no} 申请退款吗？提交后将停止任务并进入退款流程。`,
      '申请退款',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  refundLoadingId.value = order.id;
  try {
    await requestOrderRefundApi(order.id);
    ElMessage.success('退款申请已提交');
    await loadRecords();
  } catch (error: any) {
    ElMessage.error(error?.message || '退款申请失败');
  } finally {
    refundLoadingId.value = undefined;
  }
}

const hasUncompletedOrders = computed(() =>
  batchOrders.value.some(
    (o) => !['cancelled', 'completed'].includes(o.order_status),
  ),
);

const hasFailedOrders = computed(() =>
  batchOrders.value.some(
    (o) => o.order_status === 'failed' && Number(o.refund_amount || 0) <= 0,
  ),
);

async function handleRetryBatch() {
  if (!selectedBatchId.value) return;
  const failedCount = batchOrders.value.filter(
    (o) => o.order_status === 'failed' && Number(o.refund_amount || 0) <= 0,
  ).length;
  try {
    await ElMessageBox.confirm(
      `确定要重试该批次中 ${failedCount} 条失败订单吗？`,
      '批次重试',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  retryLoading.value = true;
  try {
    const result = await retryBatchOrderApi(selectedBatchId.value);
    ElMessage.success(`重试成功：${result.retried_count ?? 0} 条订单已重新提交`);
    await loadRecords();
    if (selectedBatchId.value) {
      await loadBatchOrders(selectedBatchId.value);
    }
  } catch (error: any) {
    ElMessage.error(error?.message || '重试失败');
  } finally {
    retryLoading.value = false;
  }
}

async function handleRecheckRepair() {
  if (!selectedBatchId.value) return;
  recheckLoading.value = true;
  try {
    const result = await recheckRepairOrdersApi(selectedBatchId.value);
    ElMessage.success(result.message || `已开始验收 ${result.total} 条订单`);
    // 延迟刷新，给后台一点处理时间
    setTimeout(async () => {
      await loadRecords();
      if (selectedBatchId.value) {
        await loadBatchOrders(selectedBatchId.value);
      }
    }, 3000);
  } catch (error: any) {
    ElMessage.error(error?.message || '验收快照失败');
  } finally {
    recheckLoading.value = false;
  }
}

function toggleOrderExpand(id: number) {
  const next = new Set(expandedOrderIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedOrderIds.value = next;
}

function updateMobileLayout() {
  isMobile.value = window.matchMedia('(max-width: 900px)').matches;
  if (!isMobile.value) {
    mobilePane.value = 'batches';
  }
}

function selectBatch(batchId: number) {
  selectedBatchId.value = batchId;
  if (isMobile.value) {
    mobilePane.value = 'orders';
    void nextTick(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }
}

function backToBatchList() {
  mobilePane.value = 'batches';
  void nextTick(() => {
    recordsShellRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function expandEnter(el: Element) {
  const htmlEl = el as HTMLElement;
  htmlEl.style.overflow = 'hidden';
  htmlEl.style.height = '0';
  htmlEl.style.opacity = '0';
  void htmlEl.offsetHeight;
  htmlEl.style.transition = 'height 0.3s ease-out, opacity 0.25s ease-out';
  htmlEl.style.height = `${htmlEl.scrollHeight}px`;
  htmlEl.style.opacity = '1';
}
function expandAfterEnter(el: Element) {
  const htmlEl = el as HTMLElement;
  htmlEl.style.height = '';
  htmlEl.style.overflow = '';
  htmlEl.style.transition = '';
}
function expandLeave(el: Element) {
  const htmlEl = el as HTMLElement;
  htmlEl.style.overflow = 'hidden';
  htmlEl.style.height = `${htmlEl.scrollHeight}px`;
  void htmlEl.offsetHeight;
  htmlEl.style.transition = 'height 0.25s ease-in, opacity 0.2s ease-in';
  htmlEl.style.height = '0';
  htmlEl.style.opacity = '0';
}
function expandAfterLeave(el: Element) {
  const htmlEl = el as HTMLElement;
  htmlEl.style.height = '';
  htmlEl.style.overflow = '';
  htmlEl.style.transition = '';
  htmlEl.style.opacity = '';
}
const pagination = ref({
  page: 1,
  page_size: 10,
  total: 0,
});
let pollingTimer: ReturnType<typeof setInterval> | undefined;

const filteredRecords = computed(() => {
  const keyword = batchKeyword.value.trim().toLowerCase();
  if (!keyword) {
    return records.value;
  }

  return records.value.filter((record) =>
    [
      record.batch_no,
      record.batch_id,
      record.status,
      batchStatusLabel(record.status),
      batchTargetTypeLabel(record),
      record.submitted_at,
      record.created_at,
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword),
  );
});

const selectedBatch = computed(() =>
  records.value.find((record) => record.id === selectedBatchId.value),
);

const selectedBatchNeedsReplenish = computed(() =>
  batchOrders.value.some((order) => order.order_status === 'repair_review'),
);

const filteredOrders = computed(() => {
  const orders = batchOrders.value;
  const keyword = orderKeyword.value.trim().toLowerCase();

  return orders.filter((order) => {
    const statusMatched =
      orderStatusFilter.value === 'all' ||
      (orderStatusFilter.value === 'success' && order.order_status === 'completed') ||
      (orderStatusFilter.value === 'failed' && order.order_status === 'failed') ||
      (orderStatusFilter.value === 'running' &&
        !['cancelled', 'completed', 'failed'].includes(order.order_status));

    if (!statusMatched) {
      return false;
    }
    if (!keyword) {
      return true;
    }

    return [
      order.order_no,
      order.note_id,
      order.note_url,
      order.source_note_url,
      order.order_status,
      orderStatusLabel(order.order_status),
      targetTypeLabel(order.target_type),
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword);
  });
});

const serverSummary = ref({
  processing_orders: 0,
  total_actual_paid: 0,
  total_orders: 0,
});

const summary = computed(() => ({
  runningOrders: serverSummary.value.processing_orders,
  totalAmount: serverSummary.value.total_actual_paid,
  totalBatches: pagination.value.total,
  totalOrders: serverSummary.value.total_orders,
}));

function batchActualPaidAmount(record: OrderApi.BatchOrderRecord) {
  if (record.total_actual_paid !== undefined) {
    return Number(record.total_actual_paid) || 0;
  }
  return (record.orders ?? []).reduce(
    (total, order) => total + Number(order.actual_paid_amount || 0),
    0,
  );
}

function batchTargetTypeLabel(record: OrderApi.BatchOrderRecord) {
  return targetTypeLabel(record.target_type || record.orders?.[0]?.target_type || '');
}

function openConsumptionBatch(record: OrderApi.BatchOrderRecord) {
  void router.push({
    name: 'ConsumptionRecords',
    query: {
      keyword: record.batch_no,
    },
  });
}

async function loadBatchOrders(batchId: number) {
  batchOrdersLoading.value = true;
  try {
    batchOrders.value = await getBatchOrdersApi(batchId);
  } catch {
    batchOrders.value = [];
    ElMessage.error('加载订单失败');
  } finally {
    batchOrdersLoading.value = false;
  }
}

watch(selectedBatchId, () => {
  orderKeyword.value = '';
  orderStatusFilter.value = 'all';
  expandedOrderIds.value.clear();
  batchOrders.value = [];
  if (selectedBatchId.value) {
    loadBatchOrders(selectedBatchId.value);
  }
});

function formatMoney(value?: number) {
  return `￥ ${(Number(value) || 0).toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatDateTime(value?: string) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const pad = (number: number) => String(number).padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(' ');
}

function targetTypeLabel(type: string) {
  if (type === 'impression') {
    return '曝光';
  }
  if (type === 'like') {
    return '点赞';
  }
  return '阅读';
}

function batchStatusLabel(status: string) {
  const statusMap: Record<string, string> = {
    cancelled: '已取消',
    completed: '已完成',
    failed: '失败',
    pending: '待处理',
    processing: '处理中',
    refunded: '已退款',
    stopping: '停止中',
  };
  return statusMap[status] || status || '-';
}

function orderStatusLabel(status: string) {
  const statusMap: Record<string, string> = {
    cancelled: '已终止',
    completed: '订单完成',
    failed: '订单失败',
    manual_review: '人工处理',
    processing: '处理中',
    repair_review: '需要补单',
    refund_requested: '退款中',
    running: '进行中',
    stopping: '停止中',
  };
  Object.assign(statusMap, {
    refund_approved: '退款已通过',
    refund_calculating: '退款计算中',
    refund_rejected: '退款已拒绝',
  });
  return statusMap[status] || status || '-';
}

function externalStatusLabel(status: string, orderStatus?: string) {
  // 退款已通过的订单，兜底显示已停止（正常情况后端已更新为 stopped）
  if (orderStatus === 'refund_approved' && !['stopped', 'completed', 'failed'].includes(status)) return '已停止';
  const map: Record<string, string> = {
    accepted: '已接单',
    completed: '已完成',
    failed: '失败',
    pending: '等待中',
    processing: '处理中',
    running: '进行中',
    stop_requested: '停止请求中',
    stopped: '已停止',
    stopping: '停止中',
  };
  return map[status] || status || '-';
}

function orderDisplayStatusLabel(order: OrderApi.BatchOrderRecordItem) {
  if (order.order_status === 'running' && order.external_status === 'completed') {
    return '上游完成';
  }
  return orderStatusLabel(order.order_status);
}

function orderStatusChipClass(order: OrderApi.BatchOrderRecordItem) {
  const status = order.order_status;
  if (status === 'completed') return 'status-chip--success';
  if (['failed', 'refund_rejected', 'cancelled'].includes(status)) {
    return 'status-chip--danger';
  }
  if (
    ['refund_requested', 'refund_calculating', 'refund_approved', 'stopping'].includes(
      status,
    ) ||
    isRefundingOrder(order) ||
    isRefundedOrder(order)
  ) {
    return 'status-chip--warning';
  }
  if (['running', 'processing', 'repair_review', 'manual_review'].includes(status)) {
    return 'status-chip--primary';
  }
  return 'status-chip--muted';
}

function orderNoteUrl(order: OrderApi.BatchOrderRecordItem) {
  return order.source_note_url || order.note_url || '';
}

function refundLabel(order: OrderApi.BatchOrderRecordItem) {
  if (order.order_status === 'refund_approved') {
    return '已退款';
  }
  if (order.order_status === 'refund_rejected') {
    return '退款已拒绝';
  }
  if (['refund_calculating', 'stopping'].includes(order.order_status)) {
    return '退款中';
  }
  if (order.refund_amount > 0) {
    return '已退款';
  }
  if (order.order_status === 'failed' && Number(order.actual_paid_amount || 0) <= 0) {
    return '已退款';
  }
  if (['refund_requested', 'refund_calculating'].includes(order.order_status)) {
    return '退款中';
  }
  return '无退款';
}

function isRefundedOrder(order: OrderApi.BatchOrderRecordItem) {
  return (
    order.order_status === 'refund_approved' ||
    Number(order.refund_amount || 0) > 0 ||
    Number((order as OrderApi.BatchOrderRecordItem & { refunded_quantity?: number })
      .refunded_quantity || 0) > 0 ||
    (order.order_status === 'failed' && Number(order.actual_paid_amount || 0) <= 0)
  );
}

function isRefundingOrder(order: OrderApi.BatchOrderRecordItem) {
  return ['refund_requested', 'refund_calculating', 'stopping'].includes(order.order_status);
}

function isRefundRejectedOrder(order: OrderApi.BatchOrderRecordItem) {
  return order.order_status === 'refund_rejected';
}

function hasRefundedOrder(record: OrderApi.BatchOrderRecord) {
  const s = record.order_status_summary;
  if (s) {
    return (s.refund_approved || 0) > 0;
  }
  return (record.orders || []).some(isRefundedOrder);
}

function hasRefundingOrder(record: OrderApi.BatchOrderRecord) {
  const s = record.order_status_summary;
  if (s) {
    return (
      (s.refund_requested || 0) + (s.refund_calculating || 0) + (s.stopping || 0) > 0
    );
  }
  return (record.orders || []).some(isRefundingOrder);
}

function hasRefundRejectedOrder(record: OrderApi.BatchOrderRecord) {
  const s = record.order_status_summary;
  if (s) {
    return (s.refund_rejected || 0) > 0;
  }
  return (record.orders || []).some(isRefundRejectedOrder);
}

function hasRepairReviewOrder(record: OrderApi.BatchOrderRecord) {
  const s = record.order_status_summary;
  if (s) {
    return (s.repair_review || 0) > 0;
  }
  return (record.orders || []).some((order) => order.order_status === 'repair_review');
}

function batchDisplayStatusLabel(record: OrderApi.BatchOrderRecord) {
  if (hasRepairReviewOrder(record)) {
    return '待补单';
  }
  if (hasRefundedOrder(record)) {
    return '已退款';
  }
  if (hasRefundingOrder(record)) {
    return '退款中';
  }
  if (hasRefundRejectedOrder(record)) {
    return '退款已拒绝';
  }
  return batchStatusLabel(record.status);
}

function formatShortDateTime(value?: string) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortenBatchNo(batchNo: string) {
  if (!batchNo || batchNo.length <= 18) {
    return batchNo || '-';
  }
  return `${batchNo.slice(0, 12)}…${batchNo.slice(-4)}`;
}

function batchStatusPillClass(record: OrderApi.BatchOrderRecord) {
  if (hasRepairReviewOrder(record)) {
    return 'rb-badge--warning';
  }
  if (hasRefundedOrder(record)) {
    return 'rb-badge--muted';
  }
  if (hasRefundingOrder(record)) {
    return 'rb-badge--warning';
  }
  if (hasRefundRejectedOrder(record)) {
    return 'rb-badge--danger';
  }
  if (record.status === 'completed') {
    return 'rb-badge--success';
  }
  if (record.status === 'failed') {
    return 'rb-badge--danger';
  }
  if (record.status === 'processing') {
    return 'rb-badge--primary';
  }
  return 'rb-badge--muted';
}

function syncDefaultSelectedBatch() {
  if (
    selectedBatchId.value &&
    records.value.some((record) => record.id === selectedBatchId.value)
  ) {
    return;
  }
  if (isMobile.value) {
    selectedBatchId.value = undefined;
    return;
  }
  const first = filteredRecords.value[0] || records.value[0];
  selectedBatchId.value = first?.id;
}

function batchProgress(record: OrderApi.BatchOrderRecord) {
  const orders = record.orders ?? [];
  if (orders.length > 0) {
    const progressTotal = orders.reduce((sum, order) => sum + orderProgress(order), 0);
    return Math.min(100, Math.max(0, progressTotal / orders.length));
  }
  const total = Number(record.total_count) || 0;
  if (total <= 0) return 0;
  const done = Number(record.succeeded_count) || 0;
  const processing = Number(record.processing_count) || 0;
  return Math.min(100, Math.max(0, ((done + processing * 0.1) / total) * 100));
}

function orderProgress(order: OrderApi.BatchOrderRecordItem) {
  if (order.order_status === 'completed') {
    return 100;
  }
  const externalProgress = Number(order.external_progress);
  if (Number.isFinite(externalProgress) && externalProgress > 0) {
    return Math.min(100, Math.max(0, externalProgress * 100));
  }
  const total = Math.max(Number(order.ordered_quantity) || 0, 0);
  if (total <= 0) {
    return 0;
  }
  const completed = Math.min(Math.max(Number(order.completed_quantity) || 0, 0), total);
  return Math.min(100, Math.max(0, (completed / total) * 100));
}

function copyTextWithFallback(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

async function copyField(text: string) {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else if (!copyTextWithFallback(text)) {
      throw new Error('copy failed');
    }
    ElMessage.success('已复制');
  } catch {
    if (copyTextWithFallback(text)) {
      ElMessage.success('已复制');
      return;
    }
    ElMessage.error('复制失败');
  }
}

function handleSearch() {
  pagination.value.page = 1;
  selectedBatchId.value = undefined;
  void loadRecords();
}

function handleSearchReset() {
  searchBatchNo.value = '';
  searchOrderNo.value = '';
  searchNoteUrl.value = '';
  searchNoteId.value = '';
  batchKeyword.value = '';
  if (route.query.batch_id || route.query.batch_no || route.query.order_no) {
    router.replace({ query: {} });
  }
  pagination.value.page = 1;
  selectedBatchId.value = undefined;
  void loadRecords();
}

async function loadRecords(options: { silent?: boolean } = {}) {
  if (polling.value) {
    return;
  }
  const silent = Boolean(options.silent);
  polling.value = silent;
  if (!silent) {
    loading.value = true;
  }
  try {
    const apiParams: Record<string, any> = {
      page: pagination.value.page,
      page_size: pagination.value.page_size,
    };
    // 用搜索条件 ref 传参，后端直接过滤
    if (searchBatchNo.value.trim()) apiParams.batch_no = searchBatchNo.value.trim();
    if (searchOrderNo.value.trim()) apiParams.order_no = searchOrderNo.value.trim();
    if (searchNoteUrl.value.trim()) apiParams.note_url = searchNoteUrl.value.trim();
    if (searchNoteId.value.trim()) apiParams.note_id = searchNoteId.value.trim();

    const orderRecords = await getBatchOrderRecordsApi(apiParams, { silent });
    records.value = orderRecords.items;
    pagination.value.total = orderRecords.total;
    if (orderRecords.summary) {
      serverSummary.value = orderRecords.summary;
    }
    if (
      selectedBatchId.value &&
      !records.value.some((record) => record.id === selectedBatchId.value)
    ) {
      selectedBatchId.value = undefined;
    }
    if (!route.query.batch_no && !route.query.batch_id) {
      syncDefaultSelectedBatch();
    }
  } finally {
    if (!silent) {
      loading.value = false;
    }
    polling.value = false;
  }
}

function pollRecords() {
  if (document.hidden) {
    return;
  }
  void loadRecords({ silent: true });
}

function startPolling() {
  stopPolling();
  pollingTimer = setInterval(pollRecords, 5 * 60 * 1000);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
}

function handleVisibilityChange() {
  if (document.hidden) {
    return;
  }
  pollRecords();
}

function handleBatchPageChange(page: number) {
  pagination.value.page = page;
  selectedBatchId.value = undefined;
  void loadRecords();
}

function handleBatchPageSizeChange(pageSize: number) {
  pagination.value.page = 1;
  pagination.value.page_size = pageSize;
  selectedBatchId.value = undefined;
  void loadRecords();
}

async function navigateToQueryBatch() {
  const qBatchId = route.query.batch_id as string;
  const qBatchNo = route.query.batch_no as string;
  const qOrderNo = route.query.order_no as string;
  if (!qBatchNo && !qBatchId) return;

  // 后端已按 batch_id / batch_no / order_no 过滤返回，直接选中匹配的批次
  const targetBatchId = qBatchId ? Number(qBatchId) : undefined;
  const matched = targetBatchId
    ? records.value.find((r) => r.id === targetBatchId)
    : records.value[0];

  if (!matched) return;

  selectedBatchId.value = matched.id;
  if (isMobile.value) {
    mobilePane.value = 'orders';
  }

  if (qOrderNo) {
    highlightOrderNo.value = qOrderNo;
    const unwatch = watch(batchOrders, (orders) => {
      if (orders.length > 0) {
        const target = orders.find((o) => o.order_no === qOrderNo);
        if (target) {
          expandedOrderIds.value.add(target.id);
          setTimeout(() => {
            const el = document.querySelector(`[data-order-no="${qOrderNo}"]`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 350);
        }
        unwatch();
      }
    });
  }
}

// 从 URL query 初始化搜索条件
function applyQueryToSearch() {
  const qBatchNo = route.query.batch_no as string;
  const qOrderNo = route.query.order_no as string;
  if (qBatchNo) searchBatchNo.value = qBatchNo;
  if (qOrderNo) searchOrderNo.value = qOrderNo;
}

// 监听路由 query 变化（从补单列表等页面跳转过来时组件可能已挂载，onMounted 不会再触发）
watch(
  () => ({ ...route.query }),
  async (newQuery, oldQuery) => {
    if (newQuery.batch_no || newQuery.batch_id || newQuery.order_no) {
      if (
        newQuery.batch_no !== oldQuery?.batch_no ||
        newQuery.batch_id !== oldQuery?.batch_id ||
        newQuery.order_no !== oldQuery?.order_no
      ) {
        applyQueryToSearch();
        await loadRecords();
        await navigateToQueryBatch();
      }
    }
  },
);

onMounted(async () => {
  updateMobileLayout();
  window.addEventListener('resize', updateMobileLayout);
  applyQueryToSearch();
  await loadRecords();
  await navigateToQueryBatch();
  startPolling();
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

onUnmounted(() => {
  stopPolling();
  window.removeEventListener('resize', updateMobileLayout);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
  <div class="order-record-page" :class="{ 'order-record-page--mobile-orders': isMobile && mobilePane === 'orders' }">
    <section v-show="!isMobile || mobilePane === 'batches'" class="page-head">
      <div class="head-text">
        <span class="eyebrow">Orders</span>
        <h1>下单记录</h1>
        <p>
          <template v-if="selectedBatch">
            当前批次 {{ selectedBatch.batch_no }}，共 {{ batchOrdersLoading ? '…' : batchOrders.length }} 条订单
          </template>
          <template v-else>点击上方批次查看订单明细</template>
        </p>
      </div>
      <div class="head-actions">
        <ElButton
          v-if="isAdmin && selectedBatch && hasFailedOrders"
          type="danger"
          :loading="retryLoading"
          @click="handleRetryBatch"
        >
          批次重试
        </ElButton>
        <ElButton
          v-if="isAdmin && selectedBatch && hasUncompletedOrders"
          type="warning"
          :loading="recheckLoading"
          @click="handleRecheckRepair"
        >
          验收快照
        </ElButton>
        <ElTag v-if="selectedBatchNeedsReplenish" type="warning">
          补单已自动申请，等待管理员审批
        </ElTag>
        <button class="head-btn" :disabled="loading || batchOrdersLoading" @click="() => { loadRecords(); if (selectedBatchId) loadBatchOrders(selectedBatchId); }">
          {{ loading || batchOrdersLoading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </section>

    <section v-show="!isMobile || mobilePane === 'batches'" class="summary-grid">
      <div class="stat-card stat-card--primary">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" /><path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>批次数</span>
          <strong>{{ summary.totalBatches }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--success">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>订单总数</span>
          <strong>{{ summary.totalOrders }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--warning">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>进行中</span>
          <strong>{{ summary.runningOrders }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--danger">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M5.05 3.636a1 1 0 010 1.414 7 7 0 000 9.9 1 1 0 11-1.414 1.414 9 9 0 010-12.728 1 1 0 011.414 0zm9.9 0a1 1 0 011.414 0 9 9 0 010 12.728 1 1 0 11-1.414-1.414 7 7 0 000-9.9 1 1 0 010-1.414zM7.879 6.464a1 1 0 010 1.414 3 3 0 000 4.243 1 1 0 11-1.415 1.414 5 5 0 010-7.07 1 1 0 011.415 0zm4.242 0a1 1 0 011.415 0 5 5 0 010 7.072 1 1 0 01-1.415-1.415 3 3 0 000-4.242 1 1 0 010-1.415zM10 9a1 1 0 100 2 1 1 0 000-2z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>累计消费</span>
          <strong>{{ formatMoney(summary.totalAmount) }}</strong>
        </div>
      </div>
    </section>

    <section
      class="record-panel"
      :class="{ 'record-panel--mobile-orders': isMobile && mobilePane === 'orders' }"
      v-loading="loading"
    >
      <div v-show="!isMobile || mobilePane === 'batches'" class="filter-bar-wrap">
        <button
          v-if="isMobile"
          type="button"
          class="mobile-filter-toggle"
          @click="mobileFilterOpen = !mobileFilterOpen"
        >
          <span>{{ mobileFilterOpen ? '收起搜索' : '搜索条件' }}</span>
          <span class="mobile-filter-toggle-arrow" :class="{ open: mobileFilterOpen }">›</span>
        </button>
        <div v-show="!isMobile || mobileFilterOpen" class="filter-bar">
        <ElInput
          v-model="searchBatchNo"
          clearable
          placeholder="批次号"
          @keyup.enter="handleSearch"
        />
        <ElInput
          v-model="searchOrderNo"
          clearable
          placeholder="订单号"
          @keyup.enter="handleSearch"
        />
        <ElInput
          v-model="searchNoteUrl"
          clearable
          placeholder="笔记链接"
          @keyup.enter="handleSearch"
        />
        <ElInput
          v-model="searchNoteId"
          clearable
          placeholder="笔记ID"
          @keyup.enter="handleSearch"
        />
        <ElButton type="primary" @click="handleSearch" :loading="loading">搜索</ElButton>
        <ElButton @click="handleSearchReset">重置</ElButton>
        <span class="filter-count">共 {{ pagination.total }} 个批次</span>
        </div>
      </div>

      <button
        v-if="isMobile && mobilePane === 'batches' && filteredRecords.length > 0"
        type="button"
        class="mobile-scroll-hint"
        @click="recordsShellRef?.scrollIntoView({ behavior: 'smooth', block: 'start' })"
      >
        <span class="mobile-scroll-hint-arrow">↓</span>
        <span>向下查看 {{ filteredRecords.length }} 个批次列表</span>
      </button>

      <div
        v-if="!loading && filteredRecords.length === 0"
        class="empty-state empty-state--fill"
      >
        暂无匹配的批次记录
      </div>

      <div v-else ref="recordsShellRef" class="records-shell">
        <aside
          v-show="!isMobile || mobilePane === 'batches'"
          class="records-sidebar"
        >
          <div v-if="isMobile" class="mobile-section-label">批次列表</div>
          <ElInput
            v-model="batchKeyword"
            clearable
            size="small"
            placeholder="筛选当前页批次"
          />
          <div class="records-batch-list">
            <button
              v-for="record in filteredRecords"
              :key="record.id"
              type="button"
              class="rb-item"
              :class="{
                active: selectedBatchId === record.id,
                'rb-item--refund': hasRefundedOrder(record) || hasRefundingOrder(record),
                'rb-item--danger': hasRefundRejectedOrder(record),
              }"
              @click="selectBatch(record.id)"
            >
              <div class="rb-item-row">
                <span class="rb-kind">{{ batchTargetTypeLabel(record) }}</span>
                <span class="rb-badge" :class="batchStatusPillClass(record)">
                  {{ batchDisplayStatusLabel(record) }}
                </span>
              </div>
              <span class="rb-no" :title="record.batch_no">
                {{ shortenBatchNo(record.batch_no) }}
              </span>
              <div class="rb-item-row rb-meta">
                <span>{{ formatShortDateTime(record.submitted_at || record.created_at) }}</span>
                <span>{{ formatMoney(batchActualPaidAmount(record)) }}</span>
              </div>
              <div class="rb-item-row rb-item-foot">
                <div class="rb-counts">
                  <span class="ok">{{ record.succeeded_count }} 成</span>
                  <span class="bad">{{ record.failed_count }} 败</span>
                  <span class="total">共 {{ record.total_count }}</span>
                </div>
                <span v-if="isMobile" class="rb-item-chevron">›</span>
              </div>
            </button>
            <div v-if="filteredRecords.length === 0" class="records-sidebar-empty">
              无匹配批次
            </div>
          </div>
          <div class="records-sidebar-footer">
            <ElPagination
              v-model:current-page="pagination.page"
              v-model:page-size="pagination.page_size"
              :page-sizes="[10, 20, 50, 100]"
              :total="pagination.total"
              small
              background
              layout="total, prev, pager, next"
              @current-change="handleBatchPageChange"
              @size-change="handleBatchPageSizeChange"
            />
          </div>
        </aside>

        <section
          v-show="!isMobile || mobilePane === 'orders'"
          class="records-main"
        >
          <div v-if="isMobile && selectedBatch" class="mobile-order-header">
            <div class="mobile-order-header-top">
              <button type="button" class="mobile-back-btn" @click="backToBatchList">
                ← 批次列表
              </button>
              <span class="rb-badge" :class="batchStatusPillClass(selectedBatch)">
                {{ batchDisplayStatusLabel(selectedBatch) }}
              </span>
            </div>
            <div class="mobile-order-header-main">
              <div class="mobile-order-header-copy">
                <span class="mobile-order-type">{{ batchTargetTypeLabel(selectedBatch) }}</span>
                <strong class="mobile-order-amount">{{ formatMoney(batchActualPaidAmount(selectedBatch)) }}</strong>
              </div>
              <div class="mobile-order-header-actions">
                <ElButton
                  v-if="isAdmin && hasFailedOrders"
                  size="small"
                  type="danger"
                  plain
                  :loading="retryLoading"
                  @click="handleRetryBatch"
                >
                  重试
                </ElButton>
                <ElButton
                  v-if="isAdmin && hasUncompletedOrders"
                  size="small"
                  type="warning"
                  plain
                  :loading="recheckLoading"
                  @click="handleRecheckRepair"
                >
                  验收
                </ElButton>
                <ElButton
                  size="small"
                  plain
                  type="primary"
                  @click="openConsumptionBatch(selectedBatch)"
                >
                  消费记录
                </ElButton>
              </div>
            </div>
            <code class="mobile-order-batch-no">{{ selectedBatch.batch_no }}</code>
            <div class="mobile-order-header-meta">
              <span>{{ selectedBatch.total_count }} 单</span>
              <span class="ok">{{ selectedBatch.succeeded_count }} 成功</span>
              <span class="bad">{{ selectedBatch.failed_count }} 失败</span>
            </div>
          </div>
          <template v-if="selectedBatch">
            <div v-if="!isMobile" class="rm-head">
              <div class="rm-head-main">
                <code class="rm-batch-no">{{ selectedBatch.batch_no }}</code>
                <div class="rm-head-tags">
                  <span class="rb-badge" :class="batchStatusPillClass(selectedBatch)">
                    {{ batchDisplayStatusLabel(selectedBatch) }}
                  </span>
                  <ElTag size="small" effect="plain" type="primary">
                    {{ batchTargetTypeLabel(selectedBatch) }}
                  </ElTag>
                  <span class="rm-amount">{{ formatMoney(batchActualPaidAmount(selectedBatch)) }}</span>
                  <ElButton
                    size="small"
                    plain
                    type="primary"
                    @click="openConsumptionBatch(selectedBatch)"
                  >
                    消费记录
                  </ElButton>
                </div>
              </div>
            </div>

            <div v-if="!isMobile" class="rm-stats">
              <span>{{ formatDateTime(selectedBatch.submitted_at || selectedBatch.created_at) }}</span>
              <span>{{ selectedBatch.total_count }} 单</span>
              <span class="ok">{{ selectedBatch.succeeded_count }} 成功</span>
              <span class="bad">{{ selectedBatch.failed_count }} 失败</span>
            </div>

            <div class="rm-toolbar">
              <ElInput
                v-model="orderKeyword"
                clearable
                size="small"
                placeholder="搜索订单号、笔记ID、链接、状态"
              />
              <ElSelect v-model="orderStatusFilter" class="status-select" size="small">
                <ElOption label="全部" value="all" />
                <ElOption label="成功" value="success" />
                <ElOption label="失败" value="failed" />
                <ElOption label="进行中" value="running" />
              </ElSelect>
              <span class="filter-count">共 {{ filteredOrders.length }} 条</span>
            </div>

            <div v-loading="batchOrdersLoading" class="records-order-list">
              <template v-if="!batchOrdersLoading">
                <div v-for="order in filteredOrders" :key="order.id" class="order-block">
          <article
            class="order-detail-row"
            :class="{
              refunded: isRefundedOrder(order),
              refunding: isRefundingOrder(order),
              'refund-rejected': isRefundRejectedOrder(order),
              expanded: expandedOrderIds.has(order.id),
              highlighted: highlightOrderNo === order.order_no,
            }"
            :data-order-no="order.order_no"
            :style="{ '--progress': `${orderProgress(order)}%` }"
            @click="toggleOrderExpand(order.id)"
          >
            <template v-if="isMobile">
              <div class="m-card-head">
                <div class="m-avatar">
                  <img
                    v-if="order.avatar_url"
                    :src="order.avatar_url"
                    alt=""
                    referrerpolicy="no-referrer"
                  />
                  <span v-else>{{ targetTypeLabel(order.target_type).slice(0, 1) }}</span>
                </div>
                <div class="m-card-info">
                  <div class="m-card-title">
                    <strong>{{ order.title || order.note_id || '未记录笔记' }}</strong>
                    <span class="status-chip" :class="orderStatusChipClass(order)">
                      {{ orderDisplayStatusLabel(order) }}
                    </span>
                  </div>
                  <p v-if="order.author_name" class="m-card-author">{{ order.author_name }}</p>
                  <a
                    v-if="orderNoteUrl(order)"
                    class="m-card-link"
                    :href="orderNoteUrl(order)"
                    target="_blank"
                    rel="noopener noreferrer"
                    @click.stop
                  >
                    查看笔记链接
                  </a>
                </div>
              </div>
              <div class="m-card-metrics">
                <div class="m-metric">
                  <span class="m-metric-label">数量</span>
                  <span class="m-metric-value">{{ order.ordered_quantity.toLocaleString('zh-CN') }}</span>
                </div>
                <div class="m-metric">
                  <span class="m-metric-label">实付</span>
                  <span class="m-metric-value m-metric-value--amount">
                    {{ formatMoney(order.actual_paid_amount || order.payable_amount) }}
                  </span>
                </div>
                <div class="m-metric">
                  <span class="m-metric-label">退款</span>
                  <span
                    class="m-metric-value"
                    :class="{ 'm-metric-value--warn': Number(order.refund_amount) > 0 }"
                  >
                    {{ refundLabel(order) }}
                  </span>
                </div>
              </div>
              <div
                v-if="order.order_status === 'failed' && order.reason_message"
                class="order-card-alert fail-reason"
              >
                失败原因：{{ order.reason_message }}
              </div>
              <div v-if="order.stop_response_message" class="order-card-alert stop-reason">
                停止原因：{{ order.stop_response_message }}
              </div>
              <div class="m-card-foot">
                <div class="m-progress-wrap">
                  <div class="m-progress-track">
                    <div
                      class="m-progress-fill"
                      :style="{ width: `${orderProgress(order)}%` }"
                    ></div>
                  </div>
                  <span class="m-progress-text">
                    {{ targetTypeLabel(order.target_type) }} · 已完成
                    {{ (order.completed_quantity || 0).toLocaleString('zh-CN') }}/{{ order.ordered_quantity.toLocaleString('zh-CN') }}
                  </span>
                </div>
                <span class="row-expand-arrow" :class="{ open: expandedOrderIds.has(order.id) }">›</span>
              </div>
            </template>
            <template v-else>
            <div class="order-card-main">
              <div class="product-thumb">
                <img
                  v-if="order.avatar_url"
                  :src="order.avatar_url"
                  alt=""
                  referrerpolicy="no-referrer"
                />
                <span v-else>{{ targetTypeLabel(order.target_type) }}</span>
              </div>
              <div class="product-text">
                <div class="order-card-title-row">
                  <strong>{{ order.title || order.note_id || '未记录笔记ID' }}</strong>
                  <span class="status-text">{{ orderDisplayStatusLabel(order) }}</span>
                </div>
                <p class="order-card-meta">
                  <span>{{ order.order_no }}</span>
                  <span>{{ formatDateTime(order.created_at) }}</span>
                </p>
                <span v-if="order.author_name" class="author-line">
                  {{ order.author_name }} / {{ order.note_id }}
                </span>
                <em>{{ order.source_note_url || order.note_url || '-' }}</em>
              </div>
              <div class="order-card-side">
                <span class="order-card-qty">{{ order.ordered_quantity.toLocaleString('zh-CN') }}</span>
                <strong class="amount-text">{{ formatMoney(order.actual_paid_amount || order.payable_amount) }}</strong>
                <span class="refund-text" :class="{ 'has-refund': Number(order.refund_amount) > 0 }">
                  {{ refundLabel(order) }}
                </span>
              </div>
            </div>
            <div v-if="order.order_status === 'failed' && order.reason_message" class="order-card-alert fail-reason">
              失败原因：{{ order.reason_message }}
            </div>
            <div v-if="order.stop_response_message" class="order-card-alert stop-reason">
              停止原因：{{ order.stop_response_message }}
            </div>
            <div class="order-card-foot">
              <span class="order-card-foot-meta">
                {{ targetTypeLabel(order.target_type) }} · 已完成 {{ (order.completed_quantity || 0).toLocaleString('zh-CN') }}/{{ order.ordered_quantity.toLocaleString('zh-CN') }}
              </span>
              <span class="row-expand-arrow" :class="{ open: expandedOrderIds.has(order.id) }">›</span>
            </div>
            </template>
          </article>
          <Transition @enter="expandEnter" @after-enter="expandAfterEnter" @leave="expandLeave" @after-leave="expandAfterLeave">
          <div v-if="expandedOrderIds.has(order.id)" class="expand-panel">
            <!-- 基本信息 -->
            <div class="exp-section">
              <div class="exp-section-title">基本信息</div>
              <div class="exp-grid">
                <div class="exp-cell">
                  <span class="exp-label">订单编号</span>
                  <span class="exp-value mono">{{ order.order_no }}<button class="copy-btn" title="复制" @click.stop="copyField(order.order_no)">复制</button></span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">订单ID</span>
                  <span class="exp-value mono">{{ order.id }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">服务类型</span>
                  <span class="exp-value">
                    <ElTag size="small" :type="order.target_type === 'view' ? 'primary' : order.target_type === 'like' ? 'danger' : 'warning'" disable-transitions>
                      {{ targetTypeLabel(order.target_type) }}
                    </ElTag>
                  </span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">订单状态</span>
                  <span class="exp-value">
                    <ElTag size="small" :type="order.order_status === 'completed' ? 'success' : order.order_status === 'failed' ? 'danger' : 'info'" disable-transitions>
                      {{ orderDisplayStatusLabel(order) }}
                    </ElTag>
                  </span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">创建时间</span>
                  <span class="exp-value">{{ formatDateTime(order.created_at) }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">更新时间</span>
                  <span class="exp-value">{{ formatDateTime(order.updated_at) }}</span>
                </div>
              </div>
            </div>

            <!-- 笔记信息 -->
            <div class="exp-section">
              <div class="exp-section-title">笔记信息</div>
              <div class="exp-grid">
                <div class="exp-cell">
                  <span class="exp-label">笔记标题</span>
                  <span class="exp-value">{{ order.title || '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">博主昵称</span>
                  <span class="exp-value">{{ order.author_name || '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">笔记ID</span>
                  <span class="exp-value mono">{{ order.note_id || '-' }}<button v-if="order.note_id" class="copy-btn" title="复制" @click.stop="copyField(order.note_id)">复制</button></span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">博主ID</span>
                  <span class="exp-value mono">{{ order.author_id || '-' }}<button v-if="order.author_id" class="copy-btn" title="复制" @click.stop="copyField(order.author_id)">复制</button></span>
                </div>
                <div class="exp-cell exp-wide">
                  <span class="exp-label">原始链接</span>
                  <span class="exp-value-row">
                    <a v-if="order.source_note_url" class="exp-link" :href="order.source_note_url" target="_blank" @click.stop>{{ order.source_note_url }}</a>
                    <span v-else>-</span>
                    <button v-if="order.source_note_url" class="copy-btn" title="复制" @click.stop="copyField(order.source_note_url)">复制</button>
                  </span>
                </div>
                <div class="exp-cell exp-wide">
                  <span class="exp-label">解析链接</span>
                  <a v-if="order.note_url" class="exp-link" :href="order.note_url" target="_blank" @click.stop>{{ order.note_url }}</a>
                  <span v-else class="exp-value">-</span>
                </div>
              </div>
            </div>

            <!-- 数量与金额 -->
            <div class="exp-section">
              <div class="exp-section-title">数量与金额</div>
              <div class="exp-stats">
                <div class="exp-stat-card">
                  <span class="exp-stat-label">下单数量</span>
                  <span class="exp-stat-num">{{ order.ordered_quantity.toLocaleString('zh-CN') }}</span>
                </div>
                <div class="exp-stat-card">
                  <span class="exp-stat-label">完成数量</span>
                  <span class="exp-stat-num" :class="{ 'text-success': (order.completed_quantity || 0) >= order.ordered_quantity }">{{ (order.completed_quantity || 0).toLocaleString('zh-CN') }}</span>
                </div>
                <div class="exp-stat-card">
                  <span class="exp-stat-label">应付金额</span>
                  <span class="exp-stat-num">{{ formatMoney(order.payable_amount) }}</span>
                </div>
                <div class="exp-stat-card">
                  <span class="exp-stat-label">实付金额</span>
                  <span class="exp-stat-num text-primary">{{ formatMoney(order.actual_paid_amount) }}</span>
                </div>
                <div class="exp-stat-card">
                  <span class="exp-stat-label">退款金额</span>
                  <span class="exp-stat-num" :class="{ 'text-warning': Number(order.refund_amount) > 0 }">{{ formatMoney(order.refund_amount) }}</span>
                </div>
                <div class="exp-stat-card">
                  <span class="exp-stat-label">售后退款</span>
                  <span class="exp-stat-num">{{ refundLabel(order) }}</span>
                </div>
              </div>
            </div>

            <!-- 外部任务 -->
            <div class="exp-section">
              <div class="exp-section-title">外部任务</div>
              <div class="exp-grid">
                <div class="exp-cell">
                  <span class="exp-label">外部任务ID</span>
                  <span class="exp-value mono">{{ order.external_task_id || '-' }}<button v-if="order.external_task_id" class="copy-btn" title="复制" @click.stop="copyField(order.external_task_id)">复制</button></span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">外部状态</span>
                  <span class="exp-value">{{ externalStatusLabel(order.external_status, order.order_status) }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">外部进度</span>
                  <span class="exp-value">
                    <template v-if="order.external_progress">
                      <span class="exp-progress-bar">
                        <span class="exp-progress-fill" :style="{ width: `${(order.external_progress * 100).toFixed(1)}%` }"></span>
                        <span class="exp-progress-text">{{ (order.external_progress * 100).toFixed(1) }}%</span>
                      </span>
                    </template>
                    <template v-else>-</template>
                  </span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">补单次数</span>
                  <span class="exp-value">{{ order.repair_count || 0 }}</span>
                </div>
              </div>
            </div>

            <!-- 数据快照 -->
            <div class="exp-section">
              <div class="exp-section-title">数据快照</div>
              <div class="exp-grid">
                <div class="exp-cell">
                  <span class="exp-label">阅读数快照</span>
                  <span class="exp-value">{{ order.snapshot_current_read_count ?? '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">验收阅读数</span>
                  <span class="exp-value">{{ order.snapshot_verified_read_count ?? '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">验收点赞数</span>
                  <span class="exp-value">{{ order.snapshot_verified_like_count ?? '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">点赞数</span>
                  <span class="exp-value">{{ order.like_count ?? '-' }}</span>
                </div>
              </div>
            </div>

            <!-- 备注信息 -->
            <div v-if="order.reason_message || order.stop_response_message" class="exp-section">
              <div class="exp-section-title">备注信息</div>
              <div class="exp-notes">
                <div v-if="order.reason_message" class="exp-note-item">
                  <span class="exp-label">备注/原因</span>
                  <span class="exp-value">{{ order.reason_message }}</span>
                </div>
                <div v-if="order.stop_response_message" class="exp-note-item">
                  <span class="exp-label">停止原因</span>
                  <span class="exp-value">{{ order.stop_response_message }}</span>
                </div>
              </div>
            </div>

          </div>
          </Transition>
                </div>
                <div
                  v-if="filteredOrders.length === 0"
                  class="empty-state empty-state--inline"
                >
                  暂无匹配的订单明细
                </div>
              </template>
            </div>
          </template>

          <template v-else-if="isMobile">
            <div class="records-main-empty records-main-empty--mobile">
              <p>点击上方批次卡片</p>
              <small>选择批次后在此查看订单明细</small>
              <button type="button" class="mobile-back-btn mobile-back-btn--cta" @click="backToBatchList">
                查看批次列表
              </button>
            </div>
          </template>

          <div v-else class="records-main-empty">
            <p>请选择左侧批次</p>
            <small>点击批次卡片查看订单明细</small>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.order-record-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: calc(100dvh - 88px);
  padding: 20px;
  box-sizing: border-box;
  color: var(--el-text-color-primary);
}

.page-head,
.summary-grid {
  flex-shrink: 0;
}

/* ---- header ---- */
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 24px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.eyebrow {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--el-color-primary);
}

.page-head h1 { margin: 2px 0 0; font-size: 22px; font-weight: 700; }
.page-head p { margin: 4px 0 0; font-size: 13px; color: var(--el-text-color-secondary); }

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.head-btn {
  padding: 8px 20px;
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 8px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.head-btn:hover:not(:disabled) { background: var(--el-color-primary); color: #fff; }
.head-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ---- stat cards ---- */
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.stat-card:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
}

.stat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 10px;
  flex-shrink: 0;
}

.stat-card--primary .stat-icon { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.stat-card--success .stat-icon { background: var(--el-color-success-light-8); color: var(--el-color-success); }
.stat-card--warning .stat-icon { background: var(--el-color-warning-light-8); color: var(--el-color-warning); }
.stat-card--danger .stat-icon { background: var(--el-color-danger-light-8); color: var(--el-color-danger); }

.stat-body { display: flex; flex-direction: column; gap: 4px; }
.stat-body span { font-size: 12px; color: var(--el-text-color-secondary); }
.stat-body strong { font-size: 20px; font-weight: 700; line-height: 1.1; }

.stat-card--danger .stat-body strong { color: var(--el-color-danger); }

/* ---- common card base ---- */
.detail-head,
.order-detail-row,
.empty-state {
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.batch-row span,
.tag-cell,
.product-cell p,
.product-cell em {
  margin: 0;
  color: var(--el-text-color-secondary);
}

/* ---- record panel ---- */
.record-panel {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 18px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  flex-shrink: 0;
}

.filter-bar :deep(.el-input) {
  width: 160px;
}

.filter-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.status-select {
  width: 110px;
}

.records-shell {
  flex: 1 1 0;
  display: flex;
  min-height: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  overflow: hidden;
}

.records-sidebar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 260px;
  flex-shrink: 0;
  min-height: 0;
  padding: 12px;
  border-right: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-light);
  overflow: hidden;
}

.records-sidebar > :deep(.el-input) {
  flex-shrink: 0;
}

.records-batch-list {
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 4px;
  overscroll-behavior: contain;
}

.records-sidebar-footer {
  flex-shrink: 0;
  padding-top: 4px;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.records-sidebar-footer :deep(.el-pagination) {
  flex-wrap: wrap;
  justify-content: center;
}

.records-sidebar-empty {
  padding: 24px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.rb-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  flex-shrink: 0;
  margin-bottom: 8px;
  padding: 10px 11px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-bg-color);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.rb-item:last-child {
  margin-bottom: 0;
}

.rb-item:hover {
  border-color: var(--el-color-primary-light-5);
}

.rb-item.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary-light-7);
}

.rb-item--refund.active {
  border-color: var(--el-color-warning);
  box-shadow: 0 0 0 1px var(--el-color-warning-light-7);
}

.rb-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.rb-kind {
  font-size: 11px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.rb-no {
  display: block;
  font-size: 12px;
  font-weight: 600;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}

.rb-meta {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.rb-counts {
  display: flex;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
}

.rb-counts .ok { color: var(--el-color-success); }
.rb-counts .bad { color: var(--el-color-danger); }
.rb-counts .total { color: var(--el-text-color-secondary); font-weight: 500; }

.rb-item-foot {
  align-items: center;
}

.rb-item-chevron {
  display: none;
  flex-shrink: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  color: var(--el-text-color-placeholder);
}

.rb-badge {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.rb-badge--primary {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.rb-badge--success {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.rb-badge--warning {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.rb-badge--danger {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.rb-badge--muted {
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}

.records-main {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 14px 16px;
  background: var(--el-bg-color);
  overflow: hidden;
}

.records-main-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--el-text-color-secondary);
}

.records-main-empty p {
  margin: 0;
  font-size: 14px;
}

.records-main-empty small {
  font-size: 12px;
  opacity: 0.85;
}

.records-main-empty--mobile {
  flex: none;
  min-height: 160px;
  padding: 24px 16px;
  border: 1px dashed var(--el-border-color);
  border-radius: 12px;
  background: var(--el-fill-color-light);
}

.mobile-back-btn--cta {
  margin-top: 8px;
  padding: 8px 16px;
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 8px;
  background: var(--el-color-primary-light-9);
}

.mobile-filter-toggle {
  display: none;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.mobile-filter-toggle-arrow {
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
  transform: rotate(90deg);
  transition: transform 0.2s;
}

.mobile-filter-toggle-arrow.open {
  transform: rotate(-90deg);
}

.mobile-order-header {
  position: sticky;
  top: 0;
  z-index: 5;
  margin: 0 0 12px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 14px;
  background: linear-gradient(
    180deg,
    var(--el-bg-color) 0%,
    color-mix(in srgb, var(--el-color-primary) 4%, var(--el-bg-color)) 100%
  );
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.06);
}

.mobile-order-header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.mobile-order-header-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.mobile-order-header-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mobile-order-type {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.mobile-order-header-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.mobile-order-batch-no {
  display: block;
  margin-top: 8px;
  font-size: 11px;
  font-weight: 600;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}

.mobile-order-header-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--el-border-color-lighter);
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.mobile-order-header-meta .ok {
  color: var(--el-color-success);
  font-weight: 600;
}

.mobile-order-header-meta .bad {
  color: var(--el-color-danger);
  font-weight: 600;
}

.mobile-order-amount {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

.status-chip {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}

.status-chip--primary {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.status-chip--success {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.status-chip--warning {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.status-chip--danger {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.status-chip--muted {
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}

.m-card-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.m-avatar {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
  font-size: 16px;
  font-weight: 700;
}

.m-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.m-card-info {
  flex: 1;
  min-width: 0;
}

.m-card-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.m-card-title strong {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 700;
  line-height: 1.45;
  color: var(--el-text-color-primary);
}

.m-card-author {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.m-card-link {
  display: inline-flex;
  margin-top: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-primary);
  text-decoration: none;
}

.m-card-metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.m-metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
}

.m-metric-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.m-metric-value {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

.m-metric-value--amount {
  color: var(--el-color-primary);
}

.m-metric-value--warn {
  color: var(--el-color-warning);
}

.m-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.m-progress-wrap {
  flex: 1;
  min-width: 0;
}

.m-progress-track {
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--el-fill-color);
}

.m-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    var(--el-color-primary-light-3),
    var(--el-color-primary)
  );
  transition: width 0.35s ease;
}

.m-progress-text {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.rm-head {
  flex-shrink: 0;
  margin-bottom: 10px;
}

.rm-batch-no {
  display: block;
  font-size: 13px;
  font-weight: 600;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-text-color-primary);
  word-break: break-all;
}

.rm-head-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}

.rm-amount {
  font-size: 16px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

.rm-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

.rm-stats .ok { color: var(--el-color-success); font-weight: 600; }
.rm-stats .bad { color: var(--el-color-danger); font-weight: 600; }

.rm-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-shrink: 0;
}

.rm-toolbar :deep(.el-input) {
  flex: 1;
  min-width: 180px;
}

.records-order-list {
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 4px;
}

.order-block {
  flex-shrink: 0;
}

.empty-state--inline {
  margin: 24px 0;
  text-align: center;
}

.order-detail-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  overflow: hidden;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
  cursor: pointer;
  transition:
    background-color 0.35s ease,
    border-color 0.35s ease;
}

.order-card-main {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  min-width: 0;
}

.order-card-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.order-card-title-row strong {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.order-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.order-card-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
  min-width: 88px;
}

.order-card-qty {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

.order-card-side .amount-text {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.order-card-side .refund-text {
  font-size: 11px;
  white-space: nowrap;
}

.order-card-alert {
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.4;
}

.order-card-alert.fail-reason {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.order-card-alert.stop-reason {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.order-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--el-border-color-extra-light);
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.order-card-foot-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.order-detail-row::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--progress, 0%);
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  content: '';
  pointer-events: none;
  transition:
    width 1.15s cubic-bezier(0.22, 1, 0.36, 1),
    background 0.35s ease;
}

@media (prefers-reduced-motion: reduce) {
  .order-detail-row::before {
    transition: none;
  }
}

.order-detail-row.refunded,
.order-detail-row.refunding {
  border-color: var(--el-color-warning-light-5);
  background: color-mix(in srgb, var(--el-color-warning) 9%, var(--el-bg-color));
}

.order-detail-row.refund-rejected {
  border-color: var(--el-color-danger-light-5);
  background: color-mix(in srgb, var(--el-color-danger) 6%, var(--el-bg-color));
}

.order-detail-row.refunded::before,
.order-detail-row.refunding::before {
  background: color-mix(in srgb, var(--el-color-warning) 14%, transparent);
}

.order-detail-row.refund-rejected::before {
  background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
}

.order-detail-row > * {
  position: relative;
  z-index: 1;
}

.product-cell {
  display: flex;
  gap: 14px;
  align-items: center;
  min-width: 0;
}

.product-thumb {
  display: grid;
  place-items: center;
  overflow: hidden;
  width: 80px;
  height: 80px;
  border-radius: 8px;
  flex-shrink: 0;
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
  font-weight: 700;
  font-size: 20px;
}

.product-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.product-text > strong {
  display: block;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.author-line {
  display: block;
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-text em {
  display: block;
  overflow: hidden;
  font-style: normal;
  font-size: 12px;
  font-family: Consolas, 'SF Mono', monospace;
  color: var(--el-color-primary-light-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}

.tag-cell span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-head {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.num-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.num-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.num-cell > strong {
  font-size: 15px;
  font-weight: 700;
  font-family: Consolas, 'SF Mono', monospace;
  white-space: nowrap;
}

.num-sub {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.num-right {
  text-align: right;
}

.amount-text {
  color: var(--el-color-primary);
}

.status-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.status-text {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.status-cell .fail-reason {
  overflow: hidden;
  color: var(--el-color-danger);
  font-size: 11px;
  line-height: 1.3;
  text-overflow: ellipsis;
}

.status-cell .stop-reason {
  overflow: hidden;
  color: var(--el-color-warning);
  font-size: 11px;
  line-height: 1.3;
  text-overflow: ellipsis;
}

.refund-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.refund-text.has-refund {
  color: var(--el-color-warning);
  font-weight: 600;
}

.order-detail-row {
  cursor: pointer;
}

.order-detail-row.expanded {
  border-color: var(--el-color-primary-light-5);
}

.order-detail-row.highlighted {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-7);
  animation: highlight-pulse 1.5s ease-in-out 2;
}

@keyframes highlight-pulse {
  0%, 100% { box-shadow: 0 0 0 2px var(--el-color-primary-light-7); }
  50% { box-shadow: 0 0 0 4px var(--el-color-primary-light-5); }
}

.records-main .product-thumb {
  width: 52px;
  height: 52px;
  font-size: 14px;
}

.order-card-main .product-thumb {
  width: 52px;
  height: 52px;
  font-size: 13px;
}

.row-expand-arrow {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--el-text-color-placeholder);
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
  transform: rotate(0deg);
  transform-origin: center center;
  transition: transform 0.25s ease, color 0.2s;
}

.row-expand-arrow.open {
  transform: rotate(90deg);
  color: var(--el-color-primary);
}

.order-detail-row:hover .row-expand-arrow {
  color: var(--el-color-primary);
}

.expand-panel {
  padding: 0 20px 16px;
  border: 1px solid var(--el-border-color-light);
  border-top: none;
  border-radius: 0 0 12px 12px;
  background: var(--el-fill-color-blank);
  margin-top: -8px;
  margin-bottom: 4px;
}

.exp-section {
  padding-top: 16px;
}

.exp-section + .exp-section {
  border-top: 1px dashed var(--el-border-color-lighter);
  margin-top: 14px;
}

.exp-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 10px;
  padding-left: 8px;
  border-left: 3px solid var(--el-color-primary);
  line-height: 1;
}

.exp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px 20px;
}

.exp-cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.exp-wide {
  grid-column: 1 / -1;
}

.exp-label {
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1.2;
}

.exp-value {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  word-break: break-all;
  line-height: 1.4;
}

.exp-value.mono {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 12px;
  letter-spacing: -0.2px;
}

.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 6px;
  padding: 1px 4px;
  font-size: 12px;
  line-height: 1;
  background: transparent;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  vertical-align: middle;
  transition: all 0.2s;
}

.copy-btn:hover {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}

.exp-value-row {
  display: flex;
  align-items: center;
  gap: 0;
}

.exp-link {
  font-size: 12px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  color: var(--el-color-primary);
  word-break: break-all;
  line-height: 1.4;
  text-decoration: none;
}

.exp-link:hover {
  text-decoration: underline;
}

.exp-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 10px;
}

.exp-stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 8px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.exp-stat-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.exp-stat-num {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.exp-stat-num.text-primary {
  color: var(--el-color-primary);
}

.exp-stat-num.text-success {
  color: var(--el-color-success);
}

.exp-stat-num.text-warning {
  color: var(--el-color-warning);
}

.exp-notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.exp-note-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.exp-progress-bar {
  display: inline-flex;
  align-items: center;
  position: relative;
  width: 140px;
  height: 16px;
  background: var(--el-border-color-lighter);
  border-radius: 8px;
  overflow: hidden;
}

.exp-progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  background: var(--el-color-primary);
  border-radius: 8px;
  transition: width 0.3s;
}

.exp-progress-text {
  position: relative;
  z-index: 1;
  width: 100%;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.3);
}

.expand-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 14px;
  border-top: 1px dashed var(--el-border-color-lighter);
  margin-top: 14px;
}

.empty-state {
  padding: 56px 16px;
  border: none;
  background: none;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.empty-state--fill {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

@media (min-width: 901px) and (max-width: 1200px) {
  .records-shell {
    flex-direction: column;
  }

  .records-sidebar {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  .records-main {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }

  .records-order-list {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
  }

  .order-card-main {
    flex-wrap: wrap;
  }

  .order-card-side {
    flex-direction: row;
    align-items: center;
    justify-content: flex-end;
    width: 100%;
    gap: 10px;
  }
}

@media (max-width: 900px) {
  .order-record-page {
    width: 100%;
    max-width: 100%;
    min-height: auto;
    padding: 12px;
    gap: 12px;
    overflow-x: hidden;
    box-sizing: border-box;
  }

  .order-record-page--mobile-orders {
    padding: 8px;
    gap: 0;
  }

  .page-head {
    align-items: flex-start;
    flex-direction: column;
    padding: 14px 16px;
  }

  .head-actions {
    flex-wrap: wrap;
    width: 100%;
  }

  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .stat-card {
    padding: 10px 12px;
    gap: 10px;
  }

  .stat-icon {
    width: 34px;
    height: 34px;
  }

  .stat-body strong {
    font-size: 18px;
  }

  .record-panel {
    flex: none;
    width: 100%;
    max-width: 100%;
    min-height: auto;
    padding: 12px;
    box-sizing: border-box;
  }

  .filter-bar-wrap {
    width: 100%;
  }

  .record-panel--mobile-orders {
    padding: 8px;
    border: none;
    background: transparent;
  }

  .mobile-filter-toggle {
    display: flex;
  }

  .filter-bar {
    padding: 10px;
    margin-bottom: 10px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 10px;
    background: var(--el-fill-color-blank);
  }

  .filter-bar :deep(.el-input) {
    width: 100%;
  }

  .filter-count {
    width: 100%;
    margin-left: 0;
  }

  .mobile-scroll-hint {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    margin-bottom: 10px;
    padding: 10px 12px;
    border: 1px dashed var(--el-color-primary-light-5);
    border-radius: 10px;
    background: color-mix(in srgb, var(--el-color-primary) 6%, var(--el-bg-color));
    color: var(--el-color-primary);
    font-size: 13px;
    cursor: pointer;
  }

  .mobile-scroll-hint-arrow {
    animation: records-hint-bounce 1.5s ease-in-out infinite;
  }

  @keyframes records-hint-bounce {
    0%,
    100% {
      transform: translateY(0);
    }

    50% {
      transform: translateY(3px);
    }
  }

  .records-shell {
    flex: none;
    width: 100%;
    max-width: 100%;
    min-height: auto;
    display: block;
    overflow: visible;
    border: none;
    border-radius: 0;
    box-sizing: border-box;
  }

  .records-batch-list {
    flex: none;
    min-height: auto;
    overflow: visible;
    max-height: none;
    padding-right: 0;
  }

  .records-sidebar {
    display: block;
    width: 100%;
    max-width: 100%;
    max-height: none;
    padding: 0;
    border-right: none;
    background: transparent;
    border-bottom: none;
    box-sizing: border-box;
  }

  .records-main {
    flex: none;
    width: 100%;
    max-width: 100%;
    min-height: auto;
    overflow: visible;
    padding: 0;
    box-sizing: border-box;
  }

  .records-order-list {
    flex: none;
    min-height: auto;
    overflow: visible;
    max-height: none;
  }

  .rm-toolbar {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    padding: 0;
    border: none;
    background: transparent;
  }

  .rm-toolbar :deep(.el-input) {
    flex: 1 1 auto;
    min-width: 0;
    width: auto;
  }

  .rm-toolbar .status-select {
    width: 88px;
    flex-shrink: 0;
  }

  .rm-toolbar .filter-count {
    width: auto;
    margin-left: auto;
    text-align: right;
  }

  .mobile-section-label {
    margin-bottom: 8px;
    font-size: 12px;
    font-weight: 700;
    color: var(--el-text-color-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .mobile-back-btn {
    display: inline-flex;
    align-items: center;
    margin-bottom: 0;
    padding: 4px 0;
    border: none;
    background: transparent;
    color: var(--el-color-primary);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }

  .records-sidebar > :deep(.el-input) {
    width: 100%;
    margin-bottom: 8px;
  }

  .records-sidebar-footer {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--el-border-color-lighter);
  }

  .rb-item {
    margin-bottom: 10px;
    padding: 14px 14px;
  }

  .rb-item.active .rb-item-chevron {
    color: var(--el-color-primary);
  }

  .rb-item-chevron {
    display: inline-flex;
  }

  .records-main-empty {
    flex: none;
  }

  .order-detail-row::before {
    display: none;
  }

  .order-detail-row {
    padding: 14px;
    border-radius: 14px;
    background: var(--el-bg-color);
    box-shadow: 0 2px 10px rgba(15, 23, 42, 0.05);
  }

  .order-detail-row.expanded {
    border-color: var(--el-color-primary-light-5);
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08);
  }

  .order-detail-row.refunded,
  .order-detail-row.refunding,
  .order-detail-row.refund-rejected {
    background: var(--el-bg-color);
  }

  .records-order-list {
    gap: 12px;
  }

  .expand-panel {
    margin-top: -4px;
    padding: 0 12px 14px;
    border-radius: 0 0 14px 14px;
  }
}

@media (min-width: 901px) {
  .mobile-scroll-hint,
  .mobile-section-label,
  .mobile-back-btn,
  .mobile-order-header,
  .mobile-filter-toggle {
    display: none;
  }

  .record-panel {
    min-height: calc(100dvh - 300px);
  }
}

@media (max-width: 640px) {
  .summary-grid {
    grid-template-columns: 1fr 1fr;
  }

  .rm-head-tags {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>


