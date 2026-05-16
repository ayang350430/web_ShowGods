<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, reactive, ref } from 'vue';

import { useUserStore } from '@vben/stores';

import {
  ElButton,
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

import { getRefundRecordsApi, reviewOrderRefundApi } from '#/api';

const loading = ref(false);
const records = ref<OrderApi.RefundRecord[]>([]);
const reviewingOrderId = ref<number>();
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
  if (status === 'refund_rejected') {
    return 'danger';
  }
  if (status === 'refund_requested' || status === 'stopping') {
    return 'primary';
  }
  return 'info';
}

function canReviewStatus(status: string) {
  return ['refund_requested', 'refund_calculating', 'stopping'].includes(status);
}

async function reviewRefund(record: OrderApi.RefundRecord, approved: boolean) {
  reviewingOrderId.value = record.order_id;
  try {
    const result = await reviewOrderRefundApi(record.order_id, {
      approved,
      reason: approved ? '管理员审核通过' : '管理员审核拒绝',
    });
    ElMessage.success(
      approved
        ? `已退款 ${formatMoney(result.refunded_amount)}`
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
        <ElTableColumn label="订单信息" min-width="240">
          <template #default="{ row }">
            <div class="main-cell">
              <strong>{{ row.order_no }}</strong>
              <span>批次：{{ row.batch_no || '-' }}</span>
              <small>{{ row.display_name }} / {{ row.username }}</small>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="笔记" min-width="260">
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
        <ElTableColumn label="业务" width="100">
          <template #default="{ row }">
            {{ targetTypeLabel(row.target_type) }}
          </template>
        </ElTableColumn>
        <ElTableColumn label="数量" width="110">
          <template #default="{ row }">
            {{ row.ordered_quantity.toLocaleString('zh-CN') }}
          </template>
        </ElTableColumn>
        <ElTableColumn label="付款/退款" min-width="150">
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
        <ElTableColumn label="申请时间" min-width="170">
          <template #default="{ row }">
            {{ formatDateTime(row.refund_requested_at) }}
          </template>
        </ElTableColumn>
        <ElTableColumn label="状态" width="130" align="center">
          <template #default="{ row }">
            <ElTag :type="statusTagType(row.order_status)" effect="plain" size="small">
              {{ statusLabel(row.order_status) }}
            </ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn
          v-if="canReviewRefund"
          label="审核"
          width="170"
          align="center"
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
  gap: 6px;
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
  width: 38px;
  height: 38px;
  border-radius: 50%;
  object-fit: cover;
}

.note-cell > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.note-cell strong,
.note-cell small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
}
</style>
