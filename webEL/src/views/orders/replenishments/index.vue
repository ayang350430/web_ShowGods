<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, reactive, ref } from 'vue';

import {
  ElButton,
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
  approveReplenishmentRequestApi,
  getReplenishmentRequestsApi,
} from '#/api';

const loading = ref(false);
const approvingId = ref<number>();
const records = ref<OrderApi.ReplenishmentRequest[]>([]);

const filters = reactive({
  status: 'pending',
});

const pagination = reactive({
  page: 1,
  page_size: 10,
  total: 0,
});

const summary = computed(() => ({
  pending: records.value.filter((item) => item.status === 'pending').length,
  quantity: records.value.reduce(
    (total, item) => total + Number(item.pending_quantity || 0),
    0,
  ),
  total: pagination.total,
}));

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

function statusLabel(status: string) {
  const map: Record<string, string> = {
    approved: '已同意',
    failed: '补单失败',
    pending: '待同意',
  };
  return map[status] || status || '-';
}

function statusTagType(status: string) {
  if (status === 'approved') {
    return 'success';
  }
  if (status === 'failed') {
    return 'danger';
  }
  return 'warning';
}

async function approveRequest(record: OrderApi.ReplenishmentRequest) {
  approvingId.value = record.id;
  try {
    const result = await approveReplenishmentRequestApi(record.id);
    ElMessage.success(
      `已同意补单 ${result.result.replenished_count} 条，补量 ${result.result.total_replenish_quantity}`,
    );
    await loadRecords();
  } catch (error: any) {
    ElMessage.error(error?.message || '同意补单失败，请稍后重试');
  } finally {
    approvingId.value = undefined;
  }
}

async function loadRecords() {
  loading.value = true;
  try {
    const result = await getReplenishmentRequestsApi({
      page: pagination.page,
      page_size: pagination.page_size,
      status: filters.status,
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
  <div class="replenishment-page">
    <section class="page-head">
      <div class="head-text">
        <span class="eyebrow">Replenishment</span>
        <h1>补单列表</h1>
        <p>用户提交补单申请后，管理员在这里同意，同意后才会发送上游补单。</p>
      </div>
      <button class="head-btn" :disabled="loading" @click="loadRecords">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </section>

    <section class="summary-grid">
      <div class="stat-card stat-card--primary">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" /><path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>申请数</span>
          <strong>{{ summary.total }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--warning">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>当前待同意</span>
          <strong>{{ summary.pending }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--success">
        <div class="stat-icon"><svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" /></svg></div>
        <div class="stat-body">
          <span>待补数量</span>
          <strong>{{ summary.quantity.toLocaleString('zh-CN') }}</strong>
        </div>
      </div>
    </section>

    <section class="record-panel">
      <div class="filter-bar">
        <ElSelect v-model="filters.status" placeholder="全部状态">
          <ElOption label="待同意" value="pending" />
          <ElOption label="已同意" value="approved" />
          <ElOption label="补单失败" value="failed" />
          <ElOption label="全部状态" value="all" />
        </ElSelect>
        <ElButton type="primary" @click="searchRecords">查询</ElButton>
      </div>

      <ElTable
        v-loading="loading"
        :data="records"
        empty-text="暂无补单申请"
        row-key="id"
      >
        <ElTableColumn label="批次" min-width="220">
          <template #default="{ row }">
            <div class="main-cell">
              <strong>{{ row.batch_no }}</strong>
              <span>{{ row.batch_uuid }}</span>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="用户" min-width="150">
          <template #default="{ row }">
            <div class="main-cell">
              <strong>{{ row.real_name || row.username }}</strong>
              <span>{{ row.username }} / ID {{ row.user_id }}</span>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="待补" min-width="140">
          <template #default="{ row }">
            <div class="main-cell">
              <strong>{{ row.pending_quantity.toLocaleString('zh-CN') }}</strong>
              <span>{{ row.pending_order_count }} 条订单</span>
            </div>
          </template>
        </ElTableColumn>
        <ElTableColumn label="原因说明" min-width="260">
          <template #default="{ row }">
            <span class="reason-text">{{ row.reason_message || '-' }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn label="申请时间" min-width="170">
          <template #default="{ row }">
            {{ formatDateTime(row.requested_at) }}
          </template>
        </ElTableColumn>
        <ElTableColumn label="状态" width="110" align="center">
          <template #default="{ row }">
            <ElTag :type="statusTagType(row.status)" effect="plain" size="small">
              {{ statusLabel(row.status) }}
            </ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn label="操作" width="150" align="center">
          <template #default="{ row }">
            <ElPopconfirm
              v-if="row.status === 'pending'"
              title="同意后会立即向上游提交差额补单，确认继续？"
              confirm-button-text="同意补单"
              cancel-button-text="取消"
              @confirm="approveRequest(row)"
            >
              <template #reference>
                <ElButton
                  :loading="approvingId === row.id"
                  size="small"
                  type="success"
                >
                  同意补单
                </ElButton>
              </template>
            </ElPopconfirm>
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
.replenishment-page {
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

.page-head h1 { margin: 2px 0 0; font-size: 22px; font-weight: 700; }
.page-head p { margin: 4px 0 0; font-size: 13px; color: var(--el-text-color-secondary); }

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
  grid-template-columns: repeat(3, minmax(0, 1fr));
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
.stat-card--warning .stat-icon { background: var(--el-color-warning-light-8); color: var(--el-color-warning); }
.stat-card--success .stat-icon { background: var(--el-color-success-light-8); color: var(--el-color-success); }

.stat-body { display: flex; flex-direction: column; gap: 4px; }
.stat-body span { font-size: 12px; color: var(--el-text-color-secondary); }
.stat-body strong { font-size: 22px; font-weight: 700; line-height: 1.1; }

/* ---- record panel ---- */
.record-panel {
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
  margin-bottom: 16px;
}

.filter-bar :deep(.el-select) {
  width: 180px;
}

/* ---- table ---- */
:deep(.el-table) {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: var(--el-fill-color-light);
}
:deep(.el-table th.el-table__cell) { background: var(--el-fill-color-light); }

.main-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.3;
}

.main-cell strong {
  font-size: 13px;
  font-family: Consolas, 'SF Mono', monospace;
}

.main-cell span,
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.reason-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
}

@media (max-width: 900px) {
  .replenishment-page { padding: 12px; }
  .page-head { align-items: flex-start; flex-direction: column; }
  .summary-grid { grid-template-columns: 1fr; }
}
</style>

