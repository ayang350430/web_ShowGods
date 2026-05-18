<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import {
  ElButton,
  ElInput,
  ElMessage,
  ElOption,
  ElPagination,
  ElSelect,
} from 'element-plus';

import {
  getBatchLinkCheckRecordsApi,
  getBatchOrderRecordsApi,
  getProblemLinkRecordsApi,
  requestReplenishBatchOrderApi,
} from '#/api';

type OrderStatusFilter = 'all' | 'failed' | 'running' | 'success';

const loading = ref(false);
const polling = ref(false);
const replenishLoading = ref(false);
const router = useRouter();
const records = ref<OrderApi.BatchOrderRecord[]>([]);
const checkRecords = ref<OrderApi.ProblemLinkRecord[]>([]);
const selectedBatchId = ref<number>();
const selectedProblemBatchNo = ref('');
const batchKeyword = ref('');
const orderKeyword = ref('');
const orderStatusFilter = ref<OrderStatusFilter>('all');
const pagination = ref({
  page: 1,
  page_size: 10,
  total: 0,
});
let pollingTimer: ReturnType<typeof setInterval> | undefined;

function normalizeCheckRecordAsProblem(
  record: OrderApi.BatchLinkCheckRecord,
): OrderApi.ProblemLinkRecord | undefined {
  if (record.valid) {
    return undefined;
  }

  return {
    author_name: record.author_name,
    avatar_url: record.avatar_url,
    check_batch_no: record.check_batch_no,
    created_at: record.created_at,
    errors: record.errors,
    id: record.id,
    line_no: record.line_no,
    note_id: record.note_id,
    note_url: record.note_url,
    ordered_quantity: record.ordered_quantity,
    payable_amount: record.payable_amount,
    raw: record.raw,
    resolved_note_url: record.resolved_note_url,
    target_type: record.target_type,
    title: record.title,
    valid: false,
  };
}

const checkBatchGroups = computed(() => {
  const map = new Map<string, OrderApi.ProblemLinkRecord[]>();
  for (const record of checkRecords.value) {
    const group = map.get(record.check_batch_no) ?? [];
    group.push(record);
    map.set(record.check_batch_no, group);
  }

  return [...map.entries()]
    .map(([batchNo, items]) => {
      const sortedItems = items.toSorted(
        (a, b) => Number(a.line_no) - Number(b.line_no),
      );
      return {
        amount: sortedItems.reduce(
          (total, item) => total + Number(item.payable_amount || 0),
          0,
        ),
        batchNo,
        failedCount: sortedItems.filter((item) => !item.valid).length,
        records: sortedItems,
        successCount: sortedItems.filter((item) => item.valid).length,
        time: sortedItems[0]?.created_at || '',
        total: sortedItems.length,
      };
    })
    .toSorted((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
});

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

const filteredProblemBatches = computed(() => {
  const keyword = batchKeyword.value.trim().toLowerCase();
  if (!keyword) {
    return checkBatchGroups.value;
  }

  return checkBatchGroups.value.filter((record) =>
    [
      record.batchNo,
      '问题链接',
      '一键删除问题链接',
      record.time,
      record.records.map((item) => item.raw).join(' '),
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword),
  );
});

const selectedBatch = computed(() =>
  records.value.find((record) => record.id === selectedBatchId.value),
);

const selectedProblemBatch = computed(() =>
  checkBatchGroups.value.find(
    (record) => record.batchNo === selectedProblemBatchNo.value,
  ),
);

const selectedBatchNeedsReplenish = computed(() =>
  (selectedBatch.value?.orders ?? []).some((order) => order.order_status === 'repair_review'),
);

const filteredOrders = computed(() => {
  const orders = selectedBatch.value?.orders ?? [];
  const keyword = orderKeyword.value.trim().toLowerCase();

  return orders.filter((order) => {
    const statusMatched =
      orderStatusFilter.value === 'all' ||
      (orderStatusFilter.value === 'success' && order.order_status === 'completed') ||
      (orderStatusFilter.value === 'failed' && order.order_status === 'failed') ||
      (orderStatusFilter.value === 'running' &&
        !['completed', 'failed'].includes(order.order_status));

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

const filteredProblemRecords = computed(() => {
  const records = selectedProblemBatch.value?.records ?? [];
  const keyword = orderKeyword.value.trim().toLowerCase();

  return records.filter((record) => {
    const statusMatched =
      orderStatusFilter.value === 'all' ||
      (orderStatusFilter.value === 'success' && record.valid) ||
      (orderStatusFilter.value === 'failed' && !record.valid);

    if (!statusMatched) {
      return false;
    }
    if (!keyword) {
      return true;
    }

    return [
      record.raw,
      record.note_id,
      record.note_url,
      record.resolved_note_url,
      record.title,
      record.author_name,
      record.errors.join(' '),
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword);
  });
});

const summary = computed(() => {
  const totalAmount = records.value.reduce(
    (total, record) => total + batchActualPaidAmount(record),
    0,
  );
  const totalOrders = records.value.reduce(
    (total, record) => total + Number(record.total_count || 0),
    0,
  );
  const runningOrders = records.value.reduce(
    (total, record) => total + Number(record.processing_count || 0),
    0,
  );

  return {
    runningOrders,
    totalAmount,
    totalBatches: records.value.length + checkBatchGroups.value.length,
    totalOrders:
      totalOrders +
      checkBatchGroups.value.reduce((total, record) => total + record.total, 0),
  };
});

function batchActualPaidAmount(record: OrderApi.BatchOrderRecord) {
  return (record.orders ?? []).reduce(
    (total, order) => total + Number(order.actual_paid_amount || 0),
    0,
  );
}

function batchTargetTypeLabel(record: OrderApi.BatchOrderRecord) {
  return targetTypeLabel(record.orders?.[0]?.target_type || '');
}

function openConsumptionBatch(record: OrderApi.BatchOrderRecord) {
  void router.push({
    name: 'ConsumptionRecords',
    query: {
      keyword: record.batch_no,
    },
  });
}

watch([selectedBatchId, selectedProblemBatchNo], () => {
  orderKeyword.value = '';
  orderStatusFilter.value = 'all';
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
    completed: '已完成',
    failed: '失败',
    pending: '待处理',
    processing: '处理中',
  };
  return statusMap[status] || status || '-';
}

function orderStatusLabel(status: string) {
  const statusMap: Record<string, string> = {
    completed: '订单完成',
    failed: '订单失败',
    manual_review: '人工处理',
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

function orderDisplayStatusLabel(order: OrderApi.BatchOrderRecordItem) {
  if (order.order_status === 'running' && order.external_status === 'completed') {
    return '上游完成';
  }
  return orderStatusLabel(order.order_status);
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
  return (record.orders || []).some(isRefundedOrder);
}

function hasRefundingOrder(record: OrderApi.BatchOrderRecord) {
  return (record.orders || []).some(isRefundingOrder);
}

function hasRefundRejectedOrder(record: OrderApi.BatchOrderRecord) {
  return (record.orders || []).some(isRefundRejectedOrder);
}

function hasRepairReviewOrder(record: OrderApi.BatchOrderRecord) {
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

function batchProgress(record: OrderApi.BatchOrderRecord) {
  const orders = record.orders ?? [];
  const total = orders.length;
  if (total <= 0) {
    return 0;
  }
  const progressTotal = orders.reduce((sum, order) => sum + orderProgress(order), 0);
  return Math.min(100, Math.max(0, progressTotal / total));
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

async function copySelectedProblemBatchLinks() {
  const recordsToCopy = selectedProblemBatch.value?.records ?? [];
  if (recordsToCopy.length === 0) {
    ElMessage.warning('暂无可复制的问题链接');
    return;
  }

  const copyText = recordsToCopy.map((record) => record.raw).join('\n');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(copyText);
    } else if (!copyTextWithFallback(copyText)) {
      throw new Error('Clipboard fallback failed');
    }
    ElMessage.success(`已复制 ${recordsToCopy.length} 条问题链接`);
  } catch {
    if (copyTextWithFallback(copyText)) {
      ElMessage.success(`已复制 ${recordsToCopy.length} 条问题链接`);
      return;
    }
    ElMessage.error('复制失败，浏览器未授权剪贴板');
  }
}

async function replenishSelectedBatch() {
  if (!selectedBatch.value) {
    return;
  }
  replenishLoading.value = true;
  try {
    await requestReplenishBatchOrderApi(selectedBatch.value.id);
    ElMessage.success('已提交补单申请，等待管理员同意');
    await loadRecords({ silent: true });
  } catch (error: any) {
    ElMessage.error(error?.message || '补单申请失败，请稍后重试');
  } finally {
    replenishLoading.value = false;
  }
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
    const [orderRecords, problemRecords, linkCheckRecords] = await Promise.all([
      getBatchOrderRecordsApi({
        page: pagination.value.page,
        page_size: pagination.value.page_size,
      }, { silent }),
      getProblemLinkRecordsApi({ silent }),
      getBatchLinkCheckRecordsApi({ silent }),
    ]);
    records.value = orderRecords.items;
    pagination.value.total = orderRecords.total;
    const failedCheckRecords =
      problemRecords.length === 0
        ? linkCheckRecords
            .map(normalizeCheckRecordAsProblem)
            .filter((record): record is OrderApi.ProblemLinkRecord =>
              Boolean(record),
            )
        : [];
    const dedupeMap = new Map<string, OrderApi.ProblemLinkRecord>();
    for (const record of [...failedCheckRecords, ...problemRecords]) {
      const key = `${record.check_batch_no}-${record.line_no}-${record.raw}`;
      dedupeMap.set(key, {
        ...record,
        valid: false,
      });
    }
    checkRecords.value = [...dedupeMap.values()];
    if (
      selectedBatchId.value &&
      !records.value.some((record) => record.id === selectedBatchId.value)
    ) {
      selectedBatchId.value = undefined;
    }
    if (
      selectedProblemBatchNo.value &&
      !checkBatchGroups.value.some(
        (record) => record.batchNo === selectedProblemBatchNo.value,
      )
    ) {
      selectedProblemBatchNo.value = '';
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
  pollingTimer = setInterval(pollRecords, 5000);
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
  selectedProblemBatchNo.value = '';
  loadRecords();
}

function handleBatchPageSizeChange(pageSize: number) {
  pagination.value.page = 1;
  pagination.value.page_size = pageSize;
  selectedBatchId.value = undefined;
  selectedProblemBatchNo.value = '';
  loadRecords();
}

onMounted(() => {
  void loadRecords();
  startPolling();
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<template>
  <div class="order-record-page">
    <section class="page-head">
      <div>
        <h1>下单记录</h1>
        <p v-if="!selectedBatch && !selectedProblemBatch">
          默认显示批次，确认提交和问题链接批次会分开标记。
        </p>
        <p v-else-if="selectedBatch">
          {{ selectedBatch.batch_no }} 内共有 {{ selectedBatch.orders.length }} 条订单。
        </p>
        <p v-else-if="selectedProblemBatch">
          {{ selectedProblemBatch.batchNo }} 内共有 {{ selectedProblemBatch.total }} 条问题链接检测记录。
        </p>
      </div>
      <div class="head-actions">
        <ElButton
          v-if="selectedBatch || selectedProblemBatch"
          @click="
            selectedBatchId = undefined;
            selectedProblemBatchNo = '';
          "
        >
          返回批次
        </ElButton>
        <ElButton
          v-if="selectedProblemBatch"
          type="primary"
          @click="copySelectedProblemBatchLinks"
        >
          一键复制问题链接
        </ElButton>
        <ElButton
          v-if="selectedBatchNeedsReplenish"
          :loading="replenishLoading"
          type="warning"
          @click="replenishSelectedBatch"
        >
          申请补单
        </ElButton>
        <ElButton :loading="loading" type="primary" @click="() => loadRecords()">
          刷新
        </ElButton>
      </div>
    </section>

    <section v-if="!selectedBatch && !selectedProblemBatch" class="summary-grid">
      <div>
        <span>批次数</span>
        <strong>{{ summary.totalBatches }}</strong>
      </div>
      <div>
        <span>订单总数</span>
        <strong>{{ summary.totalOrders }}</strong>
      </div>
      <div>
        <span>进行中</span>
        <strong>{{ summary.runningOrders }}</strong>
      </div>
      <div>
        <span>累计消费</span>
        <strong>{{ formatMoney(summary.totalAmount) }}</strong>
      </div>
    </section>

    <section class="filter-bar">
      <template v-if="!selectedBatch && !selectedProblemBatch">
        <ElInput
          v-model="batchKeyword"
          clearable
          placeholder="搜索批次号、批次ID、时间、状态"
        />
        <span>共 {{ filteredRecords.length + filteredProblemBatches.length }} 个批次</span>
      </template>
      <template v-else>
        <ElInput
          v-model="orderKeyword"
          clearable
          placeholder="搜索订单号、笔记ID、链接、状态"
        />
        <ElSelect v-model="orderStatusFilter" class="status-select">
          <ElOption label="全部" value="all" />
          <ElOption label="成功" value="success" />
          <ElOption label="失败" value="failed" />
          <ElOption label="进行中" value="running" />
        </ElSelect>
        <span>
          共 {{ selectedProblemBatch ? filteredProblemRecords.length : filteredOrders.length }} 条记录
        </span>
      </template>
    </section>

    <section v-loading="loading" class="record-list">
      <template v-if="!selectedBatch && !selectedProblemBatch">
        <article
          v-for="record in filteredRecords"
          :key="record.id"
          class="batch-row"
          :class="{
            refunded: hasRefundedOrder(record),
            refunding: hasRefundingOrder(record),
            'refund-rejected': hasRefundRejectedOrder(record),
          }"
          :style="{ '--progress': `${batchProgress(record)}%` }"
          @click="
            selectedBatchId = record.id;
            selectedProblemBatchNo = '';
          "
        >
          <div>
            <div class="batch-title-line">
              <strong
                class="batch-no-link"
                title="查看这批次的消费记录"
                @click.stop="openConsumptionBatch(record)"
              >
                {{ record.batch_no }}
              </strong>
              <span class="batch-type-tag service">
                {{ batchTargetTypeLabel(record) }}
              </span>
              <span class="batch-type-tag primary">
                确认提交
              </span>
            </div>
            <span>提交时间：{{ formatDateTime(record.submitted_at || record.created_at) }}</span>
          </div>
          <div class="batch-stat">
            <span>总数</span>
            <strong>{{ record.total_count }}</strong>
          </div>
          <div class="batch-stat">
            <span>成功</span>
            <strong>{{ record.succeeded_count }}</strong>
          </div>
          <div class="batch-stat">
            <span>失败</span>
            <strong>{{ record.failed_count }}</strong>
          </div>
          <div class="batch-money">
            <span>实际付款金额</span>
            <strong>{{ formatMoney(batchActualPaidAmount(record)) }}</strong>
          </div>
          <span
            class="batch-kind-tag batch-type-tag"
            :class="hasRefundedOrder(record) || hasRefundingOrder(record) ? 'warning' : 'primary'"
          >
            {{ batchDisplayStatusLabel(record) }}
          </span>
        </article>

        <article
          v-for="record in filteredProblemBatches"
          :key="record.batchNo"
          class="batch-row problem-batch-row"
          :style="{ '--progress': '100%' }"
          @click="
            selectedBatchId = undefined;
            selectedProblemBatchNo = record.batchNo;
          "
        >
          <div>
            <div class="batch-title-line">
              <strong>{{ record.batchNo }}</strong>
              <span class="batch-type-tag warning">
                问题链接
              </span>
            </div>
            <span>检测时间：{{ formatDateTime(record.time) }}</span>
          </div>
          <div class="batch-stat">
            <span>总数</span>
            <strong>{{ record.total }}</strong>
          </div>
          <div class="batch-stat">
            <span>通过</span>
            <strong>{{ record.successCount }}</strong>
          </div>
          <div class="batch-stat">
            <span>放弃</span>
            <strong>{{ record.failedCount }}</strong>
          </div>
          <div class="batch-money">
            <span>预估金额</span>
            <strong>{{ formatMoney(record.amount) }}</strong>
          </div>
          <span class="batch-kind-tag batch-type-tag danger">
            放弃
          </span>
        </article>
      </template>

      <template v-else-if="selectedBatch">
        <div class="detail-head">
          <span>商品</span>
          <span>标签</span>
          <span>单价</span>
          <span>数量</span>
          <span>订单状态</span>
          <span>售后退款</span>
          <span>实际付款金额</span>
        </div>

        <article
          v-for="order in filteredOrders"
          :key="order.id"
          class="order-detail-row"
          :class="{
            refunded: isRefundedOrder(order),
            refunding: isRefundingOrder(order),
            'refund-rejected': isRefundRejectedOrder(order),
          }"
          :style="{ '--progress': `${orderProgress(order)}%` }"
        >
        <!-- {{ order }} -->
          <div class="product-cell">
            <div class="product-thumb">
              <img v-if="order.avatar_url" :src="order.avatar_url" alt="" />
              <span v-else>{{ targetTypeLabel(order.target_type) }}</span>
            </div>
            <div>
              <p>
                订单编号：{{ order.order_no }}
                <span>订单创建时间：{{ formatDateTime(order.created_at) }}</span>
              </p>
              <strong>{{ order.title || order.note_id || '未记录笔记ID' }}</strong>
              <span v-if="order.author_name" class="author-line">
                {{ order.author_name }} / {{ order.note_id }}
              </span>
              <em>{{ order.source_note_url || order.note_url || '-' }}</em>
            </div>
          </div>
          <div class="tag-cell">
            <span>{{ targetTypeLabel(order.target_type) }}服务</span>
            <span>订单ID：{{ order.id }}</span>
            <span>批次：{{ selectedBatch.batch_no }}</span>
            <span>明细：#{{ order.batch_item_id }}</span>
          </div>
          <!-- formatMoney(order.actual_paid_amount / Math.max(order.ordered_quantity, 1)) -->
          <strong>{{ formatMoney(order.actual_paid_amount || order.payable_amount) }}</strong>
          <div class="quantity-cell">
            <strong>{{ order.ordered_quantity.toLocaleString('zh-CN') }}</strong>
          </div>
          <div class="order-status-cell">
            <span>{{ orderDisplayStatusLabel(order) }}</span>
            <small v-if="order.order_status === 'failed' && order.reason_message">
              失败原因：{{ order.reason_message }}
            </small>
          </div>
          <span>{{ refundLabel(order) }}</span>
          <strong>{{ formatMoney(order.actual_paid_amount || order.payable_amount) }}</strong>
        </article>
      </template>

      <template v-else-if="selectedProblemBatch">
        <div class="detail-head problem-detail-head">
          <span>链接内容</span>
          <span>标签</span>
          <span>预估单价</span>
          <span>数量</span>
          <span>处理状态</span>
          <span>放弃原因</span>
          <span>预估金额</span>
        </div>

        <article
          v-for="record in filteredProblemRecords"
          :key="record.id"
          class="order-detail-row problem-detail-row"
        >
          <div class="product-cell">
            <div class="product-thumb problem-thumb">
              <span>问题</span>
            </div>
            <div>
              <p>
                检测批次：{{ selectedProblemBatch.batchNo }}
                <span>检测时间：{{ formatDateTime(record.created_at) }}</span>
              </p>
              <strong>{{ record.title || record.note_id || '未解析到笔记ID' }}</strong>
              <em>{{ record.raw }}</em>
            </div>
          </div>
          <div class="tag-cell">
            <span>问题链接</span>
            <span>{{ targetTypeLabel(record.target_type) }}检测</span>
            <span>明细：#{{ record.line_no }}</span>
          </div>
          <strong>{{ formatMoney(record.payable_amount / Math.max(record.ordered_quantity, 1)) }}</strong>
          <strong>{{ record.ordered_quantity.toLocaleString('zh-CN') }}</strong>
          <span>{{ record.valid ? '成功' : '放弃' }}</span>
          <span>{{ record.valid ? '无' : record.errors.join('、') || '未知问题' }}</span>
          <strong>{{ formatMoney(record.payable_amount) }}</strong>
        </article>
      </template>

      <div
        v-if="
          !loading &&
          !selectedBatch &&
          !selectedProblemBatch &&
          filteredRecords.length + filteredProblemBatches.length === 0
        "
        class="empty-state"
      >
        暂无匹配的批次记录
      </div>
      <div
        v-if="!loading && selectedBatch && filteredOrders.length === 0"
        class="empty-state"
      >
        暂无匹配的订单明细
      </div>
      <div
        v-if="
          !loading &&
          selectedProblemBatch &&
          filteredProblemRecords.length === 0
        "
        class="empty-state"
      >
        暂无匹配的问题链接明细
      </div>
      <div v-if="!selectedBatch && !selectedProblemBatch" class="pagination-bar">
        <ElPagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.page_size"
          :page-sizes="[10, 20, 50, 100]"
          :total="pagination.total"
          background
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="handleBatchPageChange"
          @size-change="handleBatchPageSizeChange"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.order-record-page {
  min-height: 100%;
  padding: 16px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-primary);
}

.page-head,
.summary-grid > div,
.filter-bar,
.batch-row,
.detail-head,
.order-detail-row,
.empty-state {
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  padding: 18px 20px;
}

.page-head h1 {
  margin: 0 0 6px;
  font-size: 22px;
}

.page-head p,
.summary-grid span,
.batch-row span,
.filter-bar span,
.tag-cell,
.product-cell p,
.product-cell em {
  margin: 0;
  color: var(--el-text-color-secondary);
}

.head-actions {
  display: flex;
  gap: 8px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.summary-grid > div {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
}

.summary-grid strong {
  font-size: 24px;
}

.filter-bar {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto auto;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
  padding: 12px 14px;
}

.status-select {
  width: 120px;
}

.record-list {
  display: grid;
  gap: 12px;
}

.batch-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(220px, 1.5fr) repeat(3, minmax(80px, 0.5fr)) minmax(150px, 0.8fr) 110px;
  gap: 14px;
  align-items: center;
  overflow: hidden;
  padding: 16px 18px;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    transform 0.2s ease;
}

.batch-row::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--progress);
  background: color-mix(in srgb, var(--el-color-success) 12%, transparent);
  content: '';
  pointer-events: none;
  transition: width 1.15s cubic-bezier(0.22, 1, 0.36, 1);
}

.batch-row:hover {
  border-color: var(--el-color-primary);
  transform: translateY(-1px);
}

.problem-batch-row {
  border-color: var(--el-color-warning-light-5);
}

.problem-batch-row::before {
  background: color-mix(in srgb, var(--el-color-warning) 12%, transparent);
}

.batch-row.refunded,
.batch-row.refunding {
  border-color: var(--el-color-warning-light-5);
  background: color-mix(in srgb, var(--el-color-warning) 9%, var(--el-bg-color));
}

.batch-row.refund-rejected {
  border-color: var(--el-color-danger-light-5);
  background: color-mix(in srgb, var(--el-color-danger) 6%, var(--el-bg-color));
}

.batch-row.refunded::before,
.batch-row.refunding::before {
  background: color-mix(in srgb, var(--el-color-warning) 16%, transparent);
}

.batch-row.refund-rejected::before {
  background: color-mix(in srgb, var(--el-color-danger) 12%, transparent);
}

.batch-row > * {
  position: relative;
  z-index: 1;
}

.batch-no-link {
  cursor: pointer;
}

.batch-no-link:hover {
  color: var(--el-color-primary);
  text-decoration: underline;
  text-underline-offset: 3px;
}

.batch-row strong,
.batch-row span {
  display: block;
}

.batch-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.batch-title-line strong {
  display: block;
  font-size: 16px;
  line-height: 24px;
}

.batch-type-tag {
  display: flex !important;
  align-items: center;
  justify-content: center;
  min-width: 62px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  vertical-align: middle;
  text-align: center;
}

.batch-type-tag.primary {
  border-color: color-mix(in srgb, var(--el-color-primary) 35%, transparent);
  background: color-mix(in srgb, var(--el-color-primary) 14%, transparent);
  color: var(--el-color-primary);
}

.batch-type-tag.service {
  border-color: color-mix(in srgb, var(--el-color-success) 35%, transparent);
  background: color-mix(in srgb, var(--el-color-success) 14%, transparent);
  color: var(--el-color-success);
}

.batch-type-tag.warning {
  border-color: color-mix(in srgb, var(--el-color-warning) 38%, transparent);
  background: color-mix(in srgb, var(--el-color-warning) 16%, transparent);
  color: var(--el-color-warning);
}

.batch-type-tag.danger {
  border-color: color-mix(in srgb, var(--el-color-danger) 38%, transparent);
  background: color-mix(in srgb, var(--el-color-danger) 16%, transparent);
  color: var(--el-color-danger);
}

.batch-stat,
.batch-money {
  display: grid;
  gap: 4px;
}

.batch-money strong {
  font-size: 18px;
}

.batch-kind-tag {
  align-self: center;
  justify-self: end;
}

.detail-head,
.order-detail-row {
  display: grid;
  grid-template-columns: minmax(360px, 2fr) minmax(170px, 1fr) 110px 90px 110px 110px 140px;
  gap: 16px;
  align-items: center;
}

.detail-head {
  padding: 14px 20px;
  color: var(--el-text-color-primary);
  font-weight: 650;
}

.order-detail-row {
  position: relative;
  overflow: hidden;
  padding: 18px 20px;
  transition:
    background-color 0.35s ease,
    border-color 0.35s ease;
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
  .batch-row::before,
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
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 18px;
  align-items: center;
}

.product-thumb {
  display: grid;
  place-items: center;
  overflow: hidden;
  width: 112px;
  height: 96px;
  border-radius: 6px;
  background:
    linear-gradient(135deg, rgb(225 232 255 / 85%), rgb(247 250 255)),
    var(--el-fill-color-light);
  color: var(--el-color-primary);
  font-weight: 700;
}

.product-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.problem-thumb {
  background:
    linear-gradient(135deg, rgb(255 234 204 / 85%), rgb(255 250 241)),
    var(--el-fill-color-light);
  color: var(--el-color-warning);
}

.product-cell p {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-bottom: 12px;
  font-size: 13px;
}

.product-cell strong {
  display: block;
  margin-bottom: 8px;
  font-size: 16px;
  line-height: 1.55;
}

.author-line {
  display: block;
  overflow: hidden;
  margin-bottom: 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.product-cell em {
  display: block;
  overflow: hidden;
  font-style: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-cell {
  display: grid;
  gap: 6px;
  line-height: 1.5;
}

.order-status-cell {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.order-status-cell small {
  overflow: hidden;
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
}

.quantity-cell {
  display: grid;
  gap: 4px;
}

.quantity-cell small {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
}

.empty-state {
  padding: 56px 16px;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding: 14px 4px;
}

@media (max-width: 1200px) {
  .batch-row,
  .detail-head,
  .order-detail-row {
    grid-template-columns: 1fr;
  }

  .detail-head {
    display: none;
  }
}

@media (max-width: 900px) {
  .page-head {
    align-items: stretch;
    flex-direction: column;
  }

  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .filter-bar {
    grid-template-columns: 1fr;
  }

  .status-select {
    width: 100%;
  }

  .product-cell {
    grid-template-columns: 1fr;
  }
}
</style>


