<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, reactive, ref } from 'vue';

import { useUserStore } from '@vben/stores';

import {
  ElButton,
  ElDialog,
  ElInput,
  ElMessage,
  ElOption,
  ElPagination,
  ElPopconfirm,
  ElSelect,
  ElTable,
  ElTableColumn,
  ElTag,
} from 'element-plus';

import {
  batchApproveRefundsApi,
  getRefundRecordsApi,
  reviewOrderRefundApi,
} from '#/api';

const loading = ref(false);
const records = ref<OrderApi.RefundRecord[]>([]);
const reviewingOrderId = ref<number>();
const batchApprovingNo = ref<string>();
const userStore = useUserStore();

const filters = reactive({
  keyword: '',
  status: '',
});

const pagination = reactive({
  page: 1,
  page_size: 10,
  total: 0,
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

const detailVisible = ref(false);
const detailBatchNo = ref('');
const detailLoading = ref(false);
const detailRecords = ref<OrderApi.RefundRecord[]>([]);

async function viewBatchDetail(batchNo: string) {
  detailBatchNo.value = batchNo;
  detailVisible.value = true;
  detailLoading.value = true;
  try {
    const result = await getRefundRecordsApi({
      keyword: batchNo,
      page: 1,
      page_size: 200,
    });
    detailRecords.value = result.items;
  } catch {
    detailRecords.value = [];
  } finally {
    detailLoading.value = false;
  }
}

const detailSummary = computed(() => {
  const paid = detailRecords.value.reduce((s, r) => s + Number(r.actual_paid_amount || 0), 0);
  const refunded = detailRecords.value.reduce((s, r) => s + Number(r.refund_amount_total || 0), 0);
  return { paid, refunded, count: detailRecords.value.length };
});

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
      <div>
        <h1>退款记录</h1>
        <p>查看单条订单的申请退款状态、退款金额和处理时间。</p>
      </div>
      <ElButton :loading="loading" type="primary" @click="loadRecords">
        刷新
      </ElButton>
    </section>

    <section class="summary-grid">
      <div>
        <span>退款记录</span>
        <strong>{{ summary.total.toLocaleString('zh-CN') }}</strong>
      </div>
      <div>
        <span>已申请</span>
        <strong>{{ summary.requested }}</strong>
      </div>
      <div>
        <span>计算中</span>
        <strong>{{ summary.calculating }}</strong>
      </div>
      <div>
        <span>已退金额</span>
        <strong>{{ formatMoney(summary.refundedAmount) }}</strong>
      </div>
    </section>

    <!-- 批量操作区域 -->
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
            <span class="batch-no batch-no-link" @click="viewBatchDetail(batch.batch_no)">{{ batch.batch_no }}</span>
            <span class="batch-meta">{{ batch.user }} / {{ batch.count }} 条待审核</span>
          </div>
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
        </div>
      </div>
    </section>

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
        </ElSelect>
        <ElButton type="primary" @click="searchRecords">查询</ElButton>
        <ElButton @click="resetFilters">重置</ElButton>
      </div>

      <ElTable
        v-loading="loading"
        :data="records"
        row-key="order_id"
        empty-text="暂无退款记录"
      >
        <ElTableColumn label="订单信息" min-width="260">
          <template #default="{ row }">
            <div class="main-cell">
              <strong>{{ row.order_no }}</strong>
              <span>批次：{{ row.batch_no || '-' }}</span>
              <small>{{ row.display_name }} / {{ row.username }}</small>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="笔记" min-width="280">
          <template #default="{ row }">
            <div class="note-cell">
              <img
                v-if="row.avatar_url"
                :src="row.avatar_url"
                alt="avatar"
              />
              <div>
                <strong>{{ row.title || row.note_id || '-' }}</strong>
                <span>{{ row.author_name || '-' }}</span>
                <small>{{ row.note_url }}</small>
              </div>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="业务" width="80" align="center">
          <template #default="{ row }">
            {{ targetTypeLabel(row.target_type) }}
          </template>
        </ElTableColumn>
        <ElTableColumn label="数量" width="90" align="right">
          <template #default="{ row }">
            {{ row.ordered_quantity.toLocaleString('zh-CN') }}
          </template>
        </ElTableColumn>
        <ElTableColumn label="付款/退款" min-width="160">
          <template #default="{ row }">
            <div class="amount-cell">
              <strong>{{ formatMoney(row.actual_paid_amount) }}</strong>
              <span>已退 {{ formatMoney(row.refund_amount_total) }}</span>
              <span v-if="row.after_available_amount !== null">
                退后余额 {{ formatMoney(row.after_available_amount) }}
              </span>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="申请时间" width="170" align="center">
          <template #default="{ row }">
            {{ formatDateTime(row.refund_requested_at) }}
          </template>
        </ElTableColumn>
        <ElTableColumn label="状态" width="110" align="center">
          <template #default="{ row }">
            <ElTag :type="statusTagType(row.order_status)" effect="plain" size="small">
              {{ statusLabel(row.order_status) }}
            </ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn
          v-if="canReviewRefund"
          label="审核"
          width="160"
          align="center"
          fixed="right"
        >
          <template #default="{ row }">
            <div v-if="canReviewStatus(row.order_status)" class="review-actions">
              <ElPopconfirm
                title="确认审核通过并退款到用户余额？"
                confirm-button-text="通过"
                cancel-button-text="取消"
                @confirm="reviewRefund(row, true)"
              >
                <template #reference>
                  <ElButton
                    :loading="reviewingOrderId === row.order_id"
                    size="small"
                    type="success"
                  >
                    通过
                  </ElButton>
                </template>
              </ElPopconfirm>
              <ElPopconfirm
                title="确认拒绝这条退款申请？"
                confirm-button-text="拒绝"
                cancel-button-text="取消"
                @confirm="reviewRefund(row, false)"
              >
                <template #reference>
                  <ElButton
                    :disabled="reviewingOrderId === row.order_id"
                    size="small"
                    type="danger"
                  >
                    拒绝
                  </ElButton>
                </template>
              </ElPopconfirm>
            </div>
            <span v-else class="muted">已处理</span>
          </template>
        </ElTableColumn>
      </ElTable>

      <div class="pagination-bar">
        <ElPagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.page_size"
          :page-sizes="[10, 20, 50, 100]"
          :total="pagination.total"
          background
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="handlePageChange"
          @size-change="handlePageSizeChange"
        />
      </div>
    </section>

    <!-- 批次详情弹窗 -->
    <ElDialog
      v-model="detailVisible"
      width="720px"
      destroy-on-close
      :show-close="true"
      class="batch-detail-dialog"
    >
      <template #header>
        <div class="detail-header">
          <div class="detail-header-top">
            <h3>{{ detailBatchNo }}</h3>
            <ElTag size="small" effect="plain">{{ detailSummary.count }} 条订单</ElTag>
          </div>
          <div class="detail-header-stats">
            <div class="stat-chip">
              <span>付款合计</span>
              <strong>{{ formatMoney(detailSummary.paid) }}</strong>
            </div>
            <div class="stat-chip">
              <span>退款合计</span>
              <strong class="refund-amount">{{ formatMoney(detailSummary.refunded) }}</strong>
            </div>
          </div>
        </div>
      </template>
      <div v-loading="detailLoading" class="detail-list">
        <div v-if="!detailLoading && detailRecords.length === 0" class="detail-empty">暂无记录</div>
        <div
          v-for="item in detailRecords"
          :key="item.order_id"
          class="detail-card"
        >
          <div class="detail-card-left">
            <img v-if="item.avatar_url" :src="item.avatar_url" alt="" class="detail-avatar" />
            <div v-else class="detail-avatar-placeholder">{{ (item.author_name || '?')[0] }}</div>
            <div class="detail-card-info">
              <div class="detail-card-title">{{ item.title || item.note_id || '-' }}</div>
              <div class="detail-card-meta">
                <span>{{ item.author_name || '-' }}</span>
                <span class="dot">·</span>
                <span>{{ targetTypeLabel(item.target_type) }}</span>
                <span class="dot">·</span>
                <span>{{ item.ordered_quantity.toLocaleString('zh-CN') }} 个</span>
              </div>
              <div class="detail-card-sub">{{ item.order_no }}</div>
            </div>
          </div>
          <div class="detail-card-right">
            <div class="detail-card-amounts">
              <span class="paid">{{ formatMoney(item.actual_paid_amount) }}</span>
              <span v-if="Number(item.refund_amount_total || 0) > 0" class="refunded">
                退 {{ formatMoney(item.refund_amount_total) }}
              </span>
            </div>
            <ElTag :type="statusTagType(item.order_status)" effect="plain" size="small">
              {{ statusLabel(item.order_status) }}
            </ElTag>
            <div class="detail-card-time">{{ formatDateTime(item.refund_requested_at) }}</div>
          </div>
        </div>
      </div>
    </ElDialog>
  </div>
</template>

<style scoped>
.refund-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 20px;
  color: hsl(var(--foreground));
  background: hsl(var(--background));
}

.page-head,
.record-panel,
.batch-approve-panel,
.summary-grid > div {
  border: 1px solid hsl(var(--border));
  border-radius: 8px;
  background: hsl(var(--card));
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
}

.page-head h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
}

.page-head p,
.main-cell span,
.main-cell small,
.note-cell span,
.note-cell small,
.amount-cell span {
  color: hsl(var(--muted-foreground));
}

.muted {
  color: hsl(var(--muted-foreground));
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.summary-grid > div {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 92px;
  padding: 18px;
}

.summary-grid strong {
  font-size: 24px;
}

/* --- 批量操作区域 --- */
.batch-approve-panel {
  padding: 16px 20px;
}

.batch-approve-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.batch-approve-title > span {
  font-size: 15px;
  font-weight: 600;
}

.batch-approve-title > small {
  font-size: 12px;
  color: hsl(var(--muted-foreground));
}

.batch-approve-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.batch-approve-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border: 1px solid hsl(var(--border));
  border-radius: 6px;
  background: hsl(var(--accent) / 0.35);
}

.batch-approve-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.batch-no {
  font-size: 13px;
  font-weight: 600;
  font-family: var(--font-family-mono, monospace);
  color: hsl(var(--foreground));
}

.batch-no-link {
  color: hsl(var(--primary));
  cursor: pointer;
  transition: opacity 0.15s;
}

.batch-no-link:hover {
  opacity: 0.75;
  text-decoration: underline;
}

.batch-meta {
  font-size: 12px;
  color: hsl(var(--muted-foreground));
}

/* --- 记录面板 --- */
.record-panel {
  padding: 16px;
}

.filter-bar {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 160px auto auto;
  gap: 10px;
  margin-bottom: 16px;
}

.main-cell,
.amount-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.main-cell strong {
  font-size: 13px;
}

.main-cell span,
.main-cell small {
  font-size: 12px;
}

.review-actions {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.note-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.note-cell img {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.note-cell > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.note-cell strong {
  font-size: 13px;
}

.note-cell span {
  font-size: 12px;
}

.note-cell strong,
.note-cell small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-cell small {
  font-size: 11px;
}

.amount-cell strong {
  font-size: 13px;
}

.amount-cell span {
  font-size: 12px;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

@media (max-width: 1100px) {
  .summary-grid,
  .filter-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .refund-page {
    padding: 12px;
  }

  .page-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .summary-grid,
  .filter-bar {
    grid-template-columns: 1fr;
  }

  .batch-approve-list {
    flex-direction: column;
  }
}

/* --- 批次详情弹窗 --- */
.detail-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail-header-top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.detail-header-top h3 {
  font-size: 16px;
  font-weight: 600;
  font-family: var(--font-family-mono, monospace);
  margin: 0;
}

.detail-header-stats {
  display: flex;
  gap: 16px;
}

.stat-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 8px;
  background: hsl(var(--accent) / 0.5);
  font-size: 13px;
}

.stat-chip span {
  color: hsl(var(--muted-foreground));
}

.stat-chip strong {
  font-weight: 600;
  color: hsl(var(--foreground));
}

.stat-chip .refund-amount {
  color: #e6a23c;
}

.detail-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 480px;
  overflow-y: auto;
  padding: 2px 0;
}

.detail-empty {
  text-align: center;
  padding: 40px 0;
  color: hsl(var(--muted-foreground));
  font-size: 14px;
}

.detail-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid hsl(var(--border));
  background: hsl(var(--card, var(--background)));
  transition: border-color 0.15s, box-shadow 0.15s;
}

.detail-card:hover {
  border-color: hsl(var(--primary) / 0.3);
  box-shadow: 0 1px 4px hsl(var(--primary) / 0.06);
}

.detail-card-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
}

.detail-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.detail-avatar-placeholder {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: hsl(var(--primary) / 0.1);
  color: hsl(var(--primary));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  flex-shrink: 0;
}

.detail-card-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.detail-card-title {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: hsl(var(--foreground));
}

.detail-card-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: hsl(var(--muted-foreground));
}

.detail-card-meta .dot {
  opacity: 0.4;
}

.detail-card-sub {
  font-size: 11px;
  font-family: var(--font-family-mono, monospace);
  color: hsl(var(--muted-foreground) / 0.7);
}

.detail-card-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}

.detail-card-amounts {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.detail-card-amounts .paid {
  font-size: 14px;
  font-weight: 600;
  color: hsl(var(--foreground));
}

.detail-card-amounts .refunded {
  font-size: 11px;
  color: #e6a23c;
}

.detail-card-time {
  font-size: 11px;
  color: hsl(var(--muted-foreground) / 0.7);
}
</style>
