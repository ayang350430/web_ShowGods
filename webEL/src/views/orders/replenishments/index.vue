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
      <div>
        <h1>补单列表</h1>
        <p>用户提交补单申请后，管理员在这里同意，同意后才会发送上游补单。</p>
      </div>
      <ElButton :loading="loading" type="primary" @click="loadRecords">
        刷新
      </ElButton>
    </section>

    <section class="summary-grid">
      <div>
        <span>申请数</span>
        <strong>{{ summary.total }}</strong>
      </div>
      <div>
        <span>当前待同意</span>
        <strong>{{ summary.pending }}</strong>
      </div>
      <div>
        <span>待补数量</span>
        <strong>{{ summary.quantity.toLocaleString('zh-CN') }}</strong>
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
.muted {
  color: hsl(var(--muted-foreground));
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.summary-grid > div {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 88px;
  padding: 18px;
}

.summary-grid strong {
  font-size: 24px;
}

.record-panel {
  padding: 16px;
}

.filter-bar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}

.filter-bar :deep(.el-select) {
  width: 180px;
}

.main-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

@media (max-width: 900px) {
  .page-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .summary-grid {
    grid-template-columns: 1fr;
  }
}
</style>

