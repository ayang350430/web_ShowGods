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
const brokenAvatars = ref(new Set<number>());

function avatarVisible(row: OrderApi.RefundRecord) {
  return Boolean(row.avatar_url) && !brokenAvatars.value.has(row.order_id);
}

function onAvatarError(orderId: number) {
  const next = new Set(brokenAvatars.value);
  next.add(orderId);
  brokenAvatars.value = next;
}

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

function orderNoteLink(row: OrderApi.RefundRecord) {
  return row.source_note_url || row.note_url || '';
}

function authorInitial(row: OrderApi.RefundRecord) {
  const name = row.author_name?.trim();
  if (name) return name[0]?.toUpperCase() || '?';
  return targetTypeLabel(row.target_type)[0] || '?';
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
    refunded: '已退款',
    repair_review: '待补单',
    running: '进行中',
    refund_calculating: '退款计算中',
    refund_approved: '已退款',
    refund_rejected: '退款拒绝',
    refund_requested: '退款待审',
    stopping: '停止中',
  };
  return map[status] || status || '-';
}

function formatShortDateTime(value?: null | string) {
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
  if (!batchNo || batchNo.length <= 24) {
    return batchNo || '无批次';
  }
  return `${batchNo.slice(0, 14)}…${batchNo.slice(-6)}`;
}

function batchHeadStatusLabel(group: BatchGroup) {
  if (batchHasPending(group)) {
    return '待审核';
  }
  if (group.remaining <= 0 && group.total_refunded > 0) {
    return '已退完';
  }
  if (group.total_refunded > 0) {
    return '部分退款';
  }
  return '可退款';
}

function batchHeadStatusClass(group: BatchGroup) {
  if (batchHasPending(group)) {
    return 'batch-badge--warning';
  }
  if (group.remaining <= 0 && group.total_refunded > 0) {
    return 'batch-badge--muted';
  }
  if (group.total_refunded > 0) {
    return 'batch-badge--primary';
  }
  return 'batch-badge--success';
}

function batchRefundProgress(group: BatchGroup) {
  if (group.total_paid <= 0) {
    return group.total_refunded > 0 ? 100 : 0;
  }
  return Math.min(100, Math.round((group.total_refunded / group.total_paid) * 100));
}

function syncDefaultExpanded() {
  if (expandedBatches.value.size > 0) {
    return;
  }
  for (const group of batchGroups.value) {
    if (batchHasPending(group)) {
      expandedBatches.value.add(group.batch_no);
    }
  }
  const first = batchGroups.value[0];
  if (expandedBatches.value.size === 0 && first) {
    expandedBatches.value.add(first.batch_no);
  }
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
    const { value: inputBatchNo } = await ElMessageBox.prompt(
      `<div style="line-height:1.8">
        <div><b>批次号：</b>${group.batch_no}</div>
        <div><b>订单数：</b>${group.orders.length} 条</div>
        <div><b>总付款：</b><span style="color:#409eff">${formatMoney(group.total_paid)}</span></div>
        <div><b>已退款：</b><span style="color:#e6a23c">${formatMoney(group.total_refunded)}</span></div>
        <div style="margin-top:6px;padding-top:6px;border-top:1px solid #eee">
          <b>本次退款：</b><span style="color:#f56c6c;font-size:16px;font-weight:700">${formatMoney(group.remaining)}</span>
        </div>
        <div style="margin-top:8px;color:#f56c6c;font-size:13px">请输入批次号确认退款</div>
      </div>`,
      '批次全额退款',
      {
        confirmButtonText: '确认退款',
        cancelButtonText: '取消',
        dangerouslyUseHTMLString: true,
        type: 'warning',
        inputPlaceholder: '请输入批次号',
        inputValidator: (val: string) => {
          if (!val || val.trim() !== group.batch_no) {
            return '批次号不匹配，请重新输入';
          }
          return true;
        },
      },
    );
    if (!inputBatchNo || inputBatchNo.trim() !== group.batch_no) {
      return;
    }
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
  syncDefaultExpanded();
}

function searchRecords() {
  pagination.page = 1;
  expandedBatches.value.clear();
  loadRecords();
}

function resetFilters() {
  filters.keyword = '';
  filters.status = '';
  pagination.page = 1;
  expandedBatches.value.clear();
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
      <div class="stat-card stat-card--primary">
        <div class="stat-icon stat-icon--total">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z" /><path fill-rule="evenodd" d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z" clip-rule="evenodd" /></svg>
        </div>
        <div class="stat-body">
          <span>本页批次</span>
          <strong>{{ summary.batchCount }}</strong>
        </div>
      </div>
      <div class="stat-card" :class="{ 'stat-card--alert': summary.requested > 0 }">
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
          <span>退款计算中</span>
          <strong>{{ summary.calculating }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--highlight">
        <div class="stat-icon stat-icon--refunded">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 4a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd" /></svg>
        </div>
        <div class="stat-body">
          <span>本页已退</span>
          <strong class="money-highlight">{{ formatMoney(summary.refundedAmount) }}</strong>
        </div>
      </div>
    </section>

    <!-- 按批次分组列表 -->
    <section class="record-panel" v-loading="loading">
      <div class="filter-bar">
        <ElInput
          v-model="filters.keyword"
          clearable
          placeholder="搜索订单号、批次、链接、笔记ID、作者"
          @keyup.enter="searchRecords"
        />
        <ElSelect v-model="filters.status" placeholder="全部状态">
          <ElOption label="全部状态" value="" />
          <ElOption label="退款待审" value="refund_requested" />
          <ElOption label="退款计算中" value="refund_calculating" />
          <ElOption label="停止中" value="stopping" />
          <ElOption label="已退款" value="refund_approved" />
          <ElOption label="退款拒绝" value="refund_rejected" />
          <ElOption label="已完成" value="completed" />
          <ElOption label="进行中" value="running" />
        </ElSelect>
        <ElButton type="primary" @click="searchRecords">查询</ElButton>
        <ElButton @click="resetFilters">重置</ElButton>
        <span class="filter-count">共 {{ pagination.total }} 条 / {{ batchGroups.length }} 批</span>
      </div>

      <div
        v-if="canReviewRefund && pendingBatches.length > 0"
        class="pending-strip"
      >
        <span class="pending-strip-label">待审核 {{ pendingBatches.length }} 批</span>
        <div class="pending-strip-list">
          <div
            v-for="batch in pendingBatches"
            :key="batch.batch_no"
            class="pending-chip"
          >
            <code :title="batch.batch_no">{{ shortenBatchNo(batch.batch_no) }}</code>
            <span>{{ batch.count }} 条</span>
            <ElPopconfirm
              :title="`确认通过批次 ${batch.batch_no} 的全部 ${batch.count} 条退款申请？`"
              confirm-button-text="全部通过"
              cancel-button-text="取消"
              width="360"
              @confirm="batchApproveByBatchNo(batch.batch_no)"
            >
              <template #reference>
                <button
                  class="rv-btn rv-btn--approve rv-btn--sm"
                  :disabled="batchApprovingNo === batch.batch_no"
                  @click.stop
                >
                  通过
                </button>
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
                <button
                  class="rv-btn rv-btn--reject rv-btn--sm"
                  :disabled="batchRejectingNo === batch.batch_no"
                  @click.stop
                >
                  拒绝
                </button>
              </template>
            </ElPopconfirm>
          </div>
        </div>
      </div>

      <div v-if="!loading && batchGroups.length === 0" class="empty-hint">
        <p>暂无退款记录</p>
        <small>调整筛选条件后重试</small>
      </div>

      <div v-else class="batch-list">
        <div
          v-for="group in batchGroups"
          :key="group.batch_no || '_none'"
          class="batch-card"
          :class="{ 'batch-card--expanded': expandedBatches.has(group.batch_no), 'batch-card--pending': batchHasPending(group) }"
        >
          <div
            class="batch-head"
            :style="{ '--progress': `${batchRefundProgress(group)}%` }"
            @click="toggleExpand(group.batch_no)"
          >
            <span class="expand-arrow" :class="{ open: expandedBatches.has(group.batch_no) }">›</span>
            <div class="batch-main">
              <div class="batch-top">
                <span class="batch-badge" :class="batchHeadStatusClass(group)">
                  {{ batchHeadStatusLabel(group) }}
                </span>
                <ElTag size="small" effect="plain">{{ group.orders.length }} 条</ElTag>
                <ElTag size="small" effect="plain" type="primary">{{ targetTypeLabel(group.target_type) }}</ElTag>
              </div>
              <span class="batch-no-text" :title="group.batch_no">{{ shortenBatchNo(group.batch_no) }}</span>
              <div class="batch-sub">
                <span v-if="group.display_name">{{ group.display_name }}</span>
                <span>{{ group.orders.length }} 单</span>
              </div>
            </div>
            <div class="batch-side">
              <div class="batch-money-row">
                <span>总付 <strong>{{ formatMoney(group.total_paid) }}</strong></span>
                <span>已退 <strong class="text-warning">{{ formatMoney(group.total_refunded) }}</strong></span>
                <span>可退 <strong :class="group.remaining > 0 ? 'text-danger' : ''">{{ formatMoney(group.remaining) }}</strong></span>
              </div>
              <button
                v-if="canReviewRefund && group.batch_no"
                class="rv-btn rv-btn--full-refund rv-btn--sm"
                :disabled="fullRefundingBatchNo === group.batch_no || group.remaining <= 0"
                @click.stop="handleBatchFullRefund(group)"
              >
                {{ fullRefundingBatchNo === group.batch_no ? '退款中…' : '全额退款' }}
              </button>
            </div>
          </div>

          <Transition
            @enter="collapseEnter"
            @after-enter="collapseAfterEnter"
            @leave="collapseLeave"
            @after-leave="collapseAfterLeave"
          >
            <div v-if="expandedBatches.has(group.batch_no)" class="batch-body">
              <article
                v-for="row in group.orders"
                :key="row.order_id"
                class="order-row"
                :class="{ 'order-row--pending': canReviewStatus(row.order_status) }"
              >
                <div class="order-thumb">
                  <img
                    v-if="avatarVisible(row)"
                    :src="row.avatar_url"
                    alt=""
                    referrerpolicy="no-referrer"
                    @error="onAvatarError(row.order_id)"
                  />
                  <span v-else>{{ authorInitial(row) }}</span>
                </div>
                <div class="order-row-main">
                  <div class="order-row-title">
                    <strong>{{ row.title || row.note_id || '未命名笔记' }}</strong>
                    <ElTag :type="statusTagType(row.order_status)" effect="plain" size="small">
                      {{ statusLabel(row.order_status) }}
                    </ElTag>
                  </div>
                  <div class="order-author-row">
                    <span class="order-author-name">{{ row.author_name || '未知博主' }}</span>
                    <span v-if="row.note_id" class="order-note-id">{{ row.note_id }}</span>
                  </div>
                  <a
                    v-if="orderNoteLink(row)"
                    class="order-link"
                    :href="orderNoteLink(row)"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="orderNoteLink(row)"
                    @click.stop
                  >{{ orderNoteLink(row) }}</a>
                  <p v-else class="order-link order-link--empty">暂无链接</p>
                  <p class="order-meta">{{ row.order_no }}</p>
                </div>
                <div class="order-row-side">
                  <span class="order-qty">{{ row.ordered_quantity.toLocaleString('zh-CN') }}</span>
                  <strong>{{ formatMoney(row.actual_paid_amount) }}</strong>
                  <span v-if="Number(row.refund_amount_total) > 0" class="order-refunded">
                    已退 {{ formatMoney(row.refund_amount_total) }}
                  </span>
                  <div v-if="canReviewRefund && canReviewStatus(row.order_status)" class="order-actions">
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
                  </div>
                </div>
              </article>
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
  gap: 12px;
  padding: 14px 16px;
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

.stat-card--primary .stat-icon--total { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.stat-card--alert {
  border-color: var(--el-color-warning-light-5);
  background: var(--el-color-warning-light-9);
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
  font-size: 20px;
  font-weight: 700;
  line-height: 1.1;
}

.money-highlight {
  color: var(--el-color-warning);
}

/* ---- record panel ---- */
.record-panel {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
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
  margin-bottom: 12px;
  flex-shrink: 0;
}

.filter-bar :deep(.el-input) {
  flex: 1;
  min-width: 200px;
}

.filter-bar :deep(.el-select) {
  width: 130px;
}

.filter-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.pending-strip {
  flex-shrink: 0;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: 10px;
  background: var(--el-color-warning-light-9);
}

.pending-strip-label {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-warning);
}

.pending-strip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pending-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  font-size: 12px;
}

.pending-chip code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
}

.pending-chip > span {
  color: var(--el-text-color-secondary);
}

.empty-hint {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--el-text-color-secondary);
}

.empty-hint p {
  margin: 0;
  font-size: 14px;
}

.empty-hint small {
  font-size: 12px;
  opacity: 0.85;
}

.text-warning { color: var(--el-color-warning); }
.text-danger { color: var(--el-color-danger); }

.batch-list {
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 4px;
}

.batch-card {
  flex-shrink: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  overflow: hidden;
  background: var(--el-bg-color);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.batch-card:hover {
  border-color: var(--el-color-primary-light-5);
}

.batch-card--expanded {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 2px 8px rgb(0 0 0 / 4%);
}

.batch-card--pending {
  border-color: var(--el-color-warning-light-5);
}

.batch-head {
  position: relative;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 12px 14px;
  cursor: pointer;
  overflow: hidden;
  transition: background 0.12s;
}

.batch-head::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--progress);
  background: color-mix(in srgb, var(--el-color-warning) 8%, transparent);
  content: '';
  pointer-events: none;
}

.batch-head > * {
  position: relative;
  z-index: 1;
}

.batch-head:hover {
  background: var(--el-fill-color-lighter);
}

.expand-arrow {
  font-size: 18px;
  line-height: 1;
  color: var(--el-text-color-secondary);
  transition: transform 0.2s;
}

.expand-arrow.open {
  transform: rotate(90deg);
  color: var(--el-color-primary);
}

.batch-main {
  min-width: 0;
}

.batch-top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
}

.batch-badge {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.batch-badge--warning {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.batch-badge--success {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.batch-badge--primary {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.batch-badge--muted {
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}

.batch-no-text {
  display: block;
  font-size: 13px;
  font-weight: 600;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}

.batch-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.batch-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

.batch-money-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px 12px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.batch-money-row strong {
  margin-left: 2px;
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

.batch-body {
  border-top: 1px solid var(--el-border-color-lighter);
  padding: 8px 10px 10px;
  background: var(--el-fill-color-blank);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.order-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  transition: border-color 0.12s;
}

.order-row:hover {
  border-color: var(--el-color-primary-light-5);
}

.order-row--pending {
  border-color: var(--el-color-warning-light-5);
  background: color-mix(in srgb, var(--el-color-warning) 4%, var(--el-bg-color));
}

.order-thumb {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--el-fill-color);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: var(--el-color-primary);
  flex-shrink: 0;
}

.order-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.order-row-main {
  flex: 1;
  min-width: 0;
}

.order-row-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.order-row-title strong {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.35;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

.order-meta {
  margin: 4px 0 0;
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-author-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  min-width: 0;
}

.order-author-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-note-id {
  flex-shrink: 0;
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-text-color-secondary);
}

.order-link {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-color-primary);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-link:hover {
  text-decoration: underline;
}

.order-link--empty {
  color: var(--el-text-color-placeholder);
  font-style: normal;
}

.order-row-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
  min-width: 88px;
}

.order-qty {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.order-row-side strong {
  font-size: 13px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.order-refunded {
  font-size: 11px;
  color: var(--el-color-warning);
  white-space: nowrap;
}

.order-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
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
  padding-top: 12px;
  flex-shrink: 0;
}

/* ---- responsive ---- */
@media (max-width: 1200px) {
  .batch-head {
    grid-template-columns: 24px minmax(0, 1fr);
  }

  .batch-side {
    grid-column: 2;
    align-items: stretch;
  }

  .batch-money-row {
    justify-content: flex-start;
  }

  .order-row {
    flex-wrap: wrap;
  }

  .order-row-side {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }
}

@media (max-width: 900px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .filter-count {
    width: 100%;
    margin-left: 0;
  }

  .filter-bar :deep(.el-select) {
    width: 100%;
  }
}

@media (max-width: 640px) {
  .refund-page {
    padding: 12px;
    min-height: calc(100dvh - 72px);
  }

  .summary-grid {
    grid-template-columns: 1fr;
  }

  .filter-bar :deep(.el-input) {
    min-width: 0;
    width: 100%;
  }

  .pending-chip {
    flex-wrap: wrap;
    width: 100%;
  }

  .order-row-title {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
