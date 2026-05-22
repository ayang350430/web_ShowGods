<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, reactive, ref } from 'vue';

import { useUserStore } from '@vben/stores';

import {
  ElButton,
  ElDialog,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElPagination,
  ElPopconfirm,
  ElSelect,
  ElTag,
} from 'element-plus';

import {
  batchApproveRefundsApi,
  batchRejectRefundsApi,
  fullRefundBatchApi,
  fullRefundOrderApi,
  getRefundRecordsApi,
  reviewOrderRefundApi,
} from '#/api';

// ─── 批次分组接口 ───
interface BatchGroup {
  batch_no: string;
  display_name: string;
  orders: OrderApi.RefundRecord[];
  total_ordered: number;
  total_paid: number;
  total_refunded: number;
  remaining: number;
  target_type: string;
  username: string;
}

const loading = ref(false);
const records = ref<OrderApi.RefundRecord[]>([]);
const reviewingOrderId = ref<number>();
const batchApprovingNo = ref<string>();
const batchRejectingNo = ref<string>();
const fullRefundingBatchNo = ref<string>();
const fullRefundingOrderId = ref<number>();
const userStore = useUserStore();
const expandedBatches = ref<Set<string>>(new Set());

function collapseEnter(el: Element) {
  const h = el as HTMLElement;
  h.style.overflow = 'hidden';
  h.style.height = '0';
  h.style.opacity = '0';
  void h.offsetHeight;
  h.style.transition = 'height 0.3s ease-out, opacity 0.25s ease-out';
  h.style.height = `${h.scrollHeight}px`;
  h.style.opacity = '1';
}
function collapseAfterEnter(el: Element) {
  const h = el as HTMLElement;
  h.style.height = '';
  h.style.overflow = '';
  h.style.transition = '';
}
function collapseLeave(el: Element) {
  const h = el as HTMLElement;
  h.style.overflow = 'hidden';
  h.style.height = `${h.scrollHeight}px`;
  void h.offsetHeight;
  h.style.transition = 'height 0.25s ease-in, opacity 0.2s ease-in';
  h.style.height = '0';
  h.style.opacity = '0';
}
function collapseAfterLeave(el: Element) {
  const h = el as HTMLElement;
  h.style.height = '';
  h.style.overflow = '';
  h.style.transition = '';
  h.style.opacity = '';
}

const filters = reactive({
  keyword: '',
  status: '',
});

const pagination = reactive({
  page: 1,
  page_size: 20,
  total: 0,
});

// ─── 按批次分组 ───
const batchGroups = computed<BatchGroup[]>(() => {
  const map = new Map<string, BatchGroup>();
  for (const r of records.value) {
    const key = r.batch_no || `_single_${r.order_id}`;
    if (!map.has(key)) {
      map.set(key, {
        batch_no: r.batch_no || '',
        display_name: r.display_name || r.username || '',
        orders: [],
        total_ordered: 0,
        total_paid: 0,
        total_refunded: 0,
        remaining: 0,
        target_type: r.target_type,
        username: r.username || '',
      });
    }
    const g = map.get(key)!;
    g.orders.push(r);
    g.total_ordered += Number(r.ordered_quantity) || 0;
    g.total_paid += Number(r.actual_paid_amount) || 0;
    g.total_refunded += Number(r.refund_amount_total) || 0;
  }
  for (const g of map.values()) {
    g.remaining = Math.max(g.total_paid - g.total_refunded, 0);
  }
  return [...map.values()];
});

const summary = computed(() => {
  const requested = records.value.filter((item) =>
    ['refund_requested', 'stopping'].includes(item.order_status),
  ).length;
  const calculating = records.value.filter(
    (item) => item.order_status === 'refund_calculating',
  ).length;
  const refundedAmount = records.value.reduce(
    (total, item) => total + Number(item.refund_amount_total || 0),
    0,
  );

  return {
    calculating,
    requested,
    refundedAmount,
    total: pagination.total,
    batchCount: batchGroups.value.length,
  };
});

const canReviewRefund = computed(() =>
  (userStore.userInfo?.roles ?? []).some((role) => ['admin', 'super'].includes(role)),
);

const pendingBatches = ref<Array<{ batch_no: string; count: number; user: string }>>([]);

async function loadPendingBatches() {
  try {
    const statuses = ['refund_requested', 'refund_calculating', 'stopping'];
    const results = await Promise.all(
      statuses.map((s) => getRefundRecordsApi({ status: s, page: 1, page_size: 500 })),
    );
    const allPending = results.flatMap((r) => r.items);
    const map = new Map<string, { count: number; user: string }>();
    for (const r of allPending) {
      if (!r.batch_no) continue;
      const existing = map.get(r.batch_no);
      if (existing) {
        existing.count++;
      } else {
        map.set(r.batch_no, {
          count: 1,
          user: r.display_name || r.username || '',
        });
      }
    }
    pendingBatches.value = [...map.entries()].map(([batchNo, info]) => ({
      batch_no: batchNo,
      count: info.count,
      user: info.user,
    }));
  } catch {
    pendingBatches.value = [];
  }
}

function formatMoney(value?: number) {
  return `￥ ${(Number(value) || 0).toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatDateTime(value?: null | string) {
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

function statusLabel(status: string) {
  const map: Record<string, string> = {
    completed: '订单完成',
    failed: '订单失败',
    manual_review: '人工处理',
    repair_review: '待补单',
    running: '进行中',
    refund_calculating: '退款中',
    refund_approved: '退款通过',
    refund_rejected: '退款拒绝',
    refund_requested: '退款中',
    stopping: '停止中',
  };
  return map[status] || status || '-';
}

function statusTagType(status: string) {
  if (status === 'refund_calculating') {
    return 'warning';
  }
  if (status === 'refund_approved') {
    return 'success';
  }
  if (status === 'refund_rejected' || status === 'failed') {
    return 'danger';
  }
  if (status === 'completed') {
    return 'success';
  }
  if (status === 'refund_requested' || status === 'stopping') {
    return 'primary';
  }
  return 'info';
}

function canReviewStatus(status: string) {
  return ['refund_requested', 'refund_calculating', 'stopping'].includes(status);
}

function batchHasPending(group: BatchGroup) {
  return group.orders.some((o) => canReviewStatus(o.order_status));
}

function toggleExpand(batchNo: string) {
  if (expandedBatches.value.has(batchNo)) {
    expandedBatches.value.delete(batchNo);
  } else {
    expandedBatches.value.add(batchNo);
  }
}

async function batchApproveByBatchNo(batchNo: string) {
  batchApprovingNo.value = batchNo;
  try {
    const result = await batchApproveRefundsApi({ batch_no: batchNo });
    ElMessage.success(
      `批量退款完成：共 ${result.total} 条，成功 ${result.succeeded} 条${result.failed > 0 ? `，失败 ${result.failed} 条` : ''}`,
    );
    await loadRecords();
  } catch {
    ElMessage.error('批量退款失败');
  } finally {
    batchApprovingNo.value = undefined;
  }
}

async function batchRejectByBatchNo(batchNo: string) {
  batchRejectingNo.value = batchNo;
  try {
    const result = await batchRejectRefundsApi({ batch_no: batchNo });
    ElMessage.success(
      `批量拒绝完成：共 ${result.total} 条，成功 ${result.succeeded} 条${result.failed > 0 ? `，失败 ${result.failed} 条` : ''}`,
    );
    await loadRecords();
  } catch {
    ElMessage.error('批量拒绝失败');
  } finally {
    batchRejectingNo.value = undefined;
  }
}

async function handleBatchFullRefund(group: BatchGroup) {
  if (group.remaining <= 0) {
    ElMessage.warning('该批次已全额退款');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `<div style="line-height:1.8">
        <div><b>批次号：</b>${group.batch_no}</div>
        <div><b>订单数：</b>${group.orders.length} 条</div>
        <div><b>总付款：</b><span style="color:#409eff">${formatMoney(group.total_paid)}</span></div>
        <div><b>已退款：</b><span style="color:#e6a23c">${formatMoney(group.total_refunded)}</span></div>
        <div style="margin-top:6px;padding-top:6px;border-top:1px solid #eee">
          <b>本次退款：</b><span style="color:#f56c6c;font-size:16px;font-weight:700">${formatMoney(group.remaining)}</span>
        </div>
      </div>`,
      '批次全额退款',
      {
        confirmButtonText: '确认退款',
        cancelButtonText: '取消',
        dangerouslyUseHTMLString: true,
        type: 'warning',
      },
    );
  } catch {
    return;
  }

  fullRefundingBatchNo.value = group.batch_no;
  try {
    const result = await fullRefundBatchApi(group.batch_no);
    if (result.total_refunded > 0) {
      ElMessage.success(
        `批次全额退款完成：共 ${result.total} 条，成功 ${result.succeeded} 条，退款 ${formatMoney(result.total_refunded)}`,
      );
    } else {
      ElMessage.info('该批次无可退金额');
    }
    await loadRecords();
  } catch {
    ElMessage.error('批次全额退款失败');
  } finally {
    fullRefundingBatchNo.value = undefined;
  }
}

async function handleFullRefund(row: OrderApi.RefundRecord) {
  const paid = Number(row.actual_paid_amount) || 0;
  const refunded = Number(row.refund_amount_total) || 0;
  const remaining = Math.max(paid - refunded, 0);

  if (remaining <= 0) {
    ElMessage.warning('该订单已全额退款，无需再退');
    return;
  }

  try {
    await ElMessageBox.confirm(
      `<div style="line-height:1.8">
        <div><b>订单号：</b>${row.order_no}</div>
        <div><b>实付金额：</b><span style="color:#409eff">${formatMoney(paid)}</span></div>
        <div><b>已退金额：</b><span style="color:#e6a23c">${formatMoney(refunded)}</span></div>
        <div style="margin-top:6px;padding-top:6px;border-top:1px solid #eee">
          <b>本次退款：</b><span style="color:#f56c6c;font-size:16px;font-weight:700">${formatMoney(remaining)}</span>
        </div>
      </div>`,
      '售后全额退款',
      {
        confirmButtonText: '确认退款',
        cancelButtonText: '取消',
        dangerouslyUseHTMLString: true,
        type: 'warning',
      },
    );
  } catch {
    return;
  }

  fullRefundingOrderId.value = row.order_id;
  try {
    const result = await fullRefundOrderApi(row.order_id);
    if (result.refund_amount > 0) {
      ElMessage.success(`已退款 ${formatMoney(result.refund_amount)}，退后余额 ${formatMoney(result.after_balance)}`);
    } else {
      ElMessage.info(result.message || '无需退款');
    }
    await loadRecords();
  } catch {
    ElMessage.error('全额退款失败');
  } finally {
    fullRefundingOrderId.value = undefined;
  }
}

async function reviewRefund(record: OrderApi.RefundRecord, approved: boolean) {
  reviewingOrderId.value = record.order_id;
  try {
    const result = await reviewOrderRefundApi(record.order_id, {
      approved,
      reason: approved ? '管理员审核通过' : '管理员审核拒绝',
    });
    ElMessage.success(
      approved && Number(result.refunded_amount || 0) > 0
        ? `已退款 ${formatMoney(result.refunded_amount)}`
        : approved
          ? '没有可退金额，已标记为不可退'
          : '已拒绝退款申请',
    );
    await loadRecords();
  } finally {
    reviewingOrderId.value = undefined;
  }
}

async function loadRecords() {
  loading.value = true;
  try {
    const result = await getRefundRecordsApi({
      keyword: filters.keyword.trim() || undefined,
      page: pagination.page,
      page_size: pagination.page_size,
      status: filters.status || undefined,
    });
    records.value = result.items;
    pagination.total = result.total;
  } finally {
    loading.value = false;
  }
  loadPendingBatches();
}

function searchRecords() {
  pagination.page = 1;
  loadRecords();
}

function resetFilters() {
  filters.keyword = '';
  filters.status = '';
  pagination.page = 1;
  loadRecords();
}

function handlePageChange(page: number) {
  pagination.page = page;
  loadRecords();
}

function handlePageSizeChange(pageSize: number) {
  pagination.page = 1;
  pagination.page_size = pageSize;
  loadRecords();
}

onMounted(loadRecords);
</script>

<template>
  <div class="refund-page">
    <section class="page-head">
      <div class="page-head-text">
        <span class="eyebrow">Refund</span>
        <h1>退款记录</h1>
        <p>按批次展示退款订单，支持批次全额退款和单条售后退款。</p>
      </div>
      <button class="head-btn" :disabled="loading" @click="loadRecords">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </section>

    <section class="summary-grid">
      <div class="stat-card">
        <div class="stat-icon stat-icon--total">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z" /><path fill-rule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clip-rule="evenodd" /></svg>
        </div>
        <div class="stat-body">
          <span>退款批次</span>
          <strong>{{ summary.total.toLocaleString('zh-CN') }}</strong>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon stat-icon--requested">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd" /></svg>
        </div>
        <div class="stat-body">
          <span>待审核</span>
          <strong>{{ summary.requested }}</strong>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon stat-icon--calc">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M11 17a1 1 0 001.447.894l4-2A1 1 0 0017 15V9.236a1 1 0 00-1.447-.894l-4 2a1 1 0 00-.553.894V17zM15.211 6.276a1 1 0 000-1.788l-4.764-2.382a1 1 0 00-.894 0L4.789 4.488a1 1 0 000 1.788l4.764 2.382a1 1 0 00.894 0l4.764-2.382zM4.447 8.342A1 1 0 003 9.236V15a1 1 0 00.553.894l4 2A1 1 0 009 17v-5.764a1 1 0 00-.553-.894l-4-2z" /></svg>
        </div>
        <div class="stat-body">
          <span>当前订单数</span>
          <strong>{{ records.length }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--highlight">
        <div class="stat-icon stat-icon--refunded">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 4a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd" /></svg>
        </div>
        <div class="stat-body">
          <span>已退金额</span>
          <strong class="money-highlight">{{ formatMoney(summary.refundedAmount) }}</strong>
        </div>
      </div>
    </section>

    <!-- 待审核批次快捷操作 -->
    <section
      v-if="canReviewRefund && pendingBatches.length > 0"
      class="batch-approve-panel"
    >
      <div class="batch-approve-title">
        <span>待审核批次</span>
        <small>以下批次有退款待审核，可一键通过整个批次</small>
      </div>
      <div class="batch-approve-list">
        <div
          v-for="batch in pendingBatches"
          :key="batch.batch_no"
          class="batch-approve-item"
        >
          <div class="batch-approve-info">
            <span class="batch-no">{{ batch.batch_no }}</span>
            <span class="batch-meta">{{ batch.user }} / {{ batch.count }} 条待审核</span>
          </div>
          <div class="batch-approve-actions">
            <ElPopconfirm
              :title="`确认通过批次 ${batch.batch_no} 的全部 ${batch.count} 条退款申请？`"
              confirm-button-text="全部通过"
              cancel-button-text="取消"
              width="360"
              @confirm="batchApproveByBatchNo(batch.batch_no)"
            >
              <template #reference>
                <ElButton
                  :loading="batchApprovingNo === batch.batch_no"
                  size="small"
                  type="primary"
                >
                  一键通过 ({{ batch.count }})
                </ElButton>
              </template>
            </ElPopconfirm>
            <ElPopconfirm
              :title="`确认拒绝批次 ${batch.batch_no} 的全部 ${batch.count} 条退款申请？`"
              confirm-button-text="全部拒绝"
              cancel-button-text="取消"
              width="360"
              @confirm="batchRejectByBatchNo(batch.batch_no)"
            >
              <template #reference>
                <ElButton
                  :loading="batchRejectingNo === batch.batch_no"
                  size="small"
                  type="danger"
                >
                  一键拒绝 ({{ batch.count }})
                </ElButton>
              </template>
            </ElPopconfirm>
          </div>
        </div>
      </div>
    </section>

    <!-- 按批次分组列表 -->
    <section class="record-panel">
      <div class="filter-bar">
        <ElInput
          v-model="filters.keyword"
          clearable
          placeholder="搜索订单号、批次、链接、笔记ID、作者"
          @keyup.enter="searchRecords"
        />
        <ElSelect v-model="filters.status" placeholder="全部状态">
          <ElOption label="全部状态" value="" />
          <ElOption label="退款中" value="refund_requested" />
          <ElOption label="退款中" value="refund_calculating" />
          <ElOption label="停止中" value="stopping" />
          <ElOption label="退款通过" value="refund_approved" />
          <ElOption label="退款拒绝" value="refund_rejected" />
          <ElOption label="已完成" value="completed" />
          <ElOption label="进行中" value="running" />
        </ElSelect>
        <ElButton type="primary" @click="searchRecords">查询</ElButton>
        <ElButton @click="resetFilters">重置</ElButton>
      </div>

      <div v-loading="loading" class="batch-list">
        <div v-if="!loading && batchGroups.length === 0" class="empty-hint">暂无退款记录</div>

        <div
          v-for="group in batchGroups"
          :key="group.batch_no || '_none'"
          class="batch-card"
        >
          <!-- 批次头部 -->
          <div class="batch-head" @click="toggleExpand(group.batch_no)">
            <div class="batch-head-left">
              <span class="expand-icon" :class="{ 'expand-icon--open': expandedBatches.has(group.batch_no) }">▶</span>
              <div class="batch-head-info">
                <div class="batch-head-top">
                  <strong class="batch-no-text">{{ group.batch_no || '无批次' }}</strong>
                  <ElTag size="small" effect="plain">{{ group.orders.length }} 条</ElTag>
                  <span class="batch-type-chip">{{ targetTypeLabel(group.target_type) }}</span>
                </div>
                <span class="batch-head-user">{{ group.display_name }}</span>
              </div>
            </div>
            <div class="batch-head-right" @click.stop>
              <div class="batch-amounts">
                <div class="ba-row">
                  <span class="ba-label">总付款</span>
                  <strong class="ba-value">{{ formatMoney(group.total_paid) }}</strong>
                </div>
                <div class="ba-row">
                  <span class="ba-label">已退</span>
                  <strong class="ba-value ba-value--refunded">{{ formatMoney(group.total_refunded) }}</strong>
                </div>
                <div class="ba-row" v-if="group.remaining > 0">
                  <span class="ba-label">可退</span>
                  <strong class="ba-value ba-value--remaining">{{ formatMoney(group.remaining) }}</strong>
                </div>
              </div>
              <div v-if="canReviewRefund" class="batch-head-actions">
                <button
                  v-if="group.batch_no"
                  class="rv-btn rv-btn--full-refund"
                  :disabled="fullRefundingBatchNo === group.batch_no || group.remaining <= 0"
                  @click="handleBatchFullRefund(group)"
                >
                  {{ fullRefundingBatchNo === group.batch_no ? '退款中…' : '批次全额退款' }}
                </button>
              </div>
            </div>
          </div>

          <!-- 展开的订单列表 -->
          <Transition
            @enter="collapseEnter"
            @after-enter="collapseAfterEnter"
            @leave="collapseLeave"
            @after-leave="collapseAfterLeave"
          >
          <div v-if="expandedBatches.has(group.batch_no)" class="batch-body">
            <div
              v-for="row in group.orders"
              :key="row.order_id"
              class="order-row"
            >
              <div class="order-row-left">
                <div class="order-row-no">
                  <span class="order-no-text">{{ row.order_no }}</span>
                </div>
                <div class="order-row-note">
                  <img v-if="row.avatar_url" :src="row.avatar_url" class="note-avatar" alt="" />
                  <div v-else class="note-avatar-ph">{{ (row.author_name || '?')[0] }}</div>
                  <div class="note-info">
                    <span class="note-title">{{ row.title || row.note_id || '-' }}</span>
                    <span class="note-author">{{ row.author_name || '-' }}</span>
                  </div>
                </div>
                <span class="order-qty-chip">{{ row.ordered_quantity.toLocaleString('zh-CN') }} 个</span>
              </div>
              <div class="order-row-right">
                <div class="order-money">
                  <span class="om-paid">{{ formatMoney(row.actual_paid_amount) }}</span>
                  <span class="om-refunded" v-if="Number(row.refund_amount_total) > 0">已退 {{ formatMoney(row.refund_amount_total) }}</span>
                </div>
                <ElTag :type="statusTagType(row.order_status)" effect="plain" size="small">
                  {{ statusLabel(row.order_status) }}
                </ElTag>
                <div v-if="canReviewRefund" class="order-row-actions">
                  <template v-if="canReviewStatus(row.order_status)">
                    <ElPopconfirm
                      title="确认通过并退款到余额？"
                      confirm-button-text="通过"
                      cancel-button-text="取消"
                      @confirm="reviewRefund(row, true)"
                    >
                      <template #reference>
                        <button class="rv-btn rv-btn--approve rv-btn--sm" :disabled="reviewingOrderId === row.order_id">通过</button>
                      </template>
                    </ElPopconfirm>
                    <ElPopconfirm
                      title="确认拒绝？"
                      confirm-button-text="拒绝"
                      cancel-button-text="取消"
                      @confirm="reviewRefund(row, false)"
                    >
                      <template #reference>
                        <button class="rv-btn rv-btn--reject rv-btn--sm" :disabled="reviewingOrderId === row.order_id">拒绝</button>
                      </template>
                    </ElPopconfirm>
                  </template>
                </div>
              </div>
            </div>
          </div>
          </Transition>
        </div>
      </div>

      <div class="pagination-bar">
        <ElPagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.page_size"
          :page-sizes="[20, 50, 100, 200]"
          :total="pagination.total"
          background
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="handlePageChange"
          @size-change="handlePageSizeChange"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.refund-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 20px;
  color: var(--el-text-color-primary);
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

.page-head h1 {
  margin: 2px 0 0;
  font-size: 22px;
  font-weight: 700;
}

.page-head p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
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

.head-btn:hover:not(:disabled) {
  background: var(--el-color-primary);
  color: #fff;
}

.head-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---- summary cards ---- */
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 20px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
  transition: border-color 0.2s, box-shadow 0.2s;
}

.stat-card:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
}

.stat-card--highlight {
  border-color: var(--el-color-warning-light-5);
  background: var(--el-color-warning-light-9);
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

.stat-icon--total { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.stat-icon--requested { background: var(--el-color-info-light-8); color: var(--el-color-info); }
.stat-icon--calc { background: var(--el-color-warning-light-8); color: var(--el-color-warning); }
.stat-icon--refunded { background: var(--el-color-success-light-8); color: var(--el-color-success); }

.stat-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-body span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.stat-body strong {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
}

.money-highlight {
  color: var(--el-color-warning);
}

/* ---- batch approve ---- */
.batch-approve-panel {
  padding: 16px 20px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.batch-approve-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.batch-approve-title > span { font-size: 15px; font-weight: 600; }
.batch-approve-title > small { font-size: 12px; color: var(--el-text-color-secondary); }

.batch-approve-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.batch-approve-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}

.batch-approve-actions { display: flex; gap: 8px; }

.batch-approve-info { display: flex; flex-direction: column; gap: 2px; }

.batch-no {
  font-size: 13px;
  font-weight: 600;
  font-family: Consolas, monospace;
}

.batch-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ---- record panel ---- */
.record-panel {
  padding: 18px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.filter-bar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 160px auto auto;
  gap: 10px;
  margin-bottom: 16px;
}

.empty-hint {
  text-align: center;
  padding: 60px 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

/* ---- batch list ---- */
.batch-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.batch-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.15s;
}

.batch-card:hover {
  border-color: var(--el-color-primary-light-5);
}

/* ---- batch head ---- */
.batch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  cursor: pointer;
  transition: background 0.15s;
}

.batch-head:hover {
  background: var(--el-fill-color-lighter);
}

.batch-head-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.expand-icon {
  font-size: 10px;
  color: var(--el-text-color-secondary);
  transition: transform 0.2s;
  flex-shrink: 0;
}

.expand-icon--open {
  transform: rotate(90deg);
}

.batch-head-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.batch-head-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.batch-no-text {
  font-size: 14px;
  font-weight: 600;
  font-family: Consolas, monospace;
  color: var(--el-color-primary);
}

.batch-type-chip {
  padding: 1px 8px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  font-size: 11px;
  color: var(--el-text-color-regular);
}

.batch-head-user {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.batch-head-right {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}

.batch-amounts {
  display: flex;
  gap: 16px;
}

.ba-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.ba-label {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.ba-value {
  font-size: 14px;
  font-weight: 600;
  font-family: Consolas, monospace;
}

.ba-value--refunded {
  color: var(--el-color-warning);
}

.ba-value--remaining {
  color: var(--el-color-danger);
}

.batch-head-actions {
  display: flex;
  gap: 6px;
}

/* ---- batch body (expanded orders) ---- */
.batch-body {
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-blank);
}

.order-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 18px 10px 42px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
  transition: background 0.1s;
}

.order-row:last-child {
  border-bottom: none;
}

.order-row:hover {
  background: var(--el-fill-color-lighter);
}

.order-row-left {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
  min-width: 0;
}

.order-row-no {
  min-width: 180px;
  max-width: 220px;
}

.order-no-text {
  font-size: 12px;
  font-family: Consolas, monospace;
  color: var(--el-text-color-regular);
}

.order-row-note {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  max-width: 260px;
}

.note-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.note-avatar-ph {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.note-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.note-title {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-author {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.order-qty-chip {
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  font-size: 11px;
  color: var(--el-text-color-regular);
  white-space: nowrap;
  flex-shrink: 0;
}

.order-row-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
}

.order-money {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  min-width: 90px;
}

.om-paid {
  font-size: 13px;
  font-weight: 600;
  font-family: Consolas, monospace;
}

.om-refunded {
  font-size: 11px;
  color: var(--el-color-warning);
}

.order-row-actions {
  display: flex;
  gap: 4px;
}

/* ---- buttons ---- */
.rv-btn {
  padding: 5px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.15s;
  white-space: nowrap;
}

.rv-btn--sm {
  padding: 3px 10px;
  font-size: 11px;
}

.rv-btn--approve {
  border-color: var(--el-color-success-light-5);
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.rv-btn--approve:hover:not(:disabled) {
  background: var(--el-color-success);
  color: #fff;
}

.rv-btn--reject {
  border-color: var(--el-color-danger-light-5);
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.rv-btn--reject:hover:not(:disabled) {
  background: var(--el-color-danger);
  color: #fff;
}

.rv-btn--full-refund {
  border-color: var(--el-color-warning-light-5);
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.rv-btn--full-refund:hover:not(:disabled) {
  background: var(--el-color-warning);
  color: #fff;
}

.rv-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

/* ---- responsive ---- */
@media (max-width: 1200px) {
  .batch-head {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }

  .batch-head-right {
    flex-wrap: wrap;
  }

  .order-row {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding-left: 18px;
  }

  .order-row-right {
    justify-content: flex-end;
    flex-wrap: wrap;
  }
}

@media (max-width: 900px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .filter-bar {
    grid-template-columns: 1fr 140px;
  }

  .batch-amounts {
    flex-wrap: wrap;
    gap: 8px;
  }
}

@media (max-width: 640px) {
  .refund-page {
    padding: 12px;
  }

  .summary-grid,
  .filter-bar {
    grid-template-columns: 1fr;
  }

  .batch-approve-list {
    flex-direction: column;
  }
}
</style>
