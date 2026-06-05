<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import {
  ElAvatar,
  ElButton,
  ElMessage,
  ElOption,
  ElPagination,
  ElPopconfirm,
  ElSelect,
  ElTag,
} from 'element-plus';

import {
  approveReplenishmentRequestApi,
  getReplenishmentRequestsApi,
} from '#/api';

const router = useRouter();

function goToOrder(batchId: number, batchNo: string, orderNo: string) {
  router.push({
    name: 'OrderRecords',
    query: { batch_id: String(batchId), batch_no: batchNo, order_no: orderNo },
  });
}

const loading = ref(false);
const approvingId = ref<number>();
const records = ref<OrderApi.ReplenishmentRequest[]>([]);
const expandedIds = ref<Set<number>>(new Set());
const brokenAvatars = ref(new Set<number>());

function avatarVisible(order: OrderApi.ReplenishmentOrderDetail) {
  return Boolean(order.avatar_url) && !brokenAvatars.value.has(order.order_id);
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

function toggleExpand(id: number) {
  const next = new Set(expandedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIds.value = next;
}

const filters = reactive({
  status: 'all',
});

const pagination = reactive({
  page: 1,
  page_size: 20,
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

const pendingRecords = computed(() =>
  records.value.filter((item) => item.status === 'pending'),
);

function formatShortDateTime(value?: null | string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortenBatchNo(batchNo: string) {
  const text = String(batchNo || '').trim();
  if (text.length <= 22) return text;
  return `${text.slice(0, 10)}…${text.slice(-8)}`;
}

function userDisplayName(row: OrderApi.ReplenishmentRequest) {
  return row.real_name || row.username || '-';
}

function userInitial(row: OrderApi.ReplenishmentRequest) {
  const name = userDisplayName(row).trim();
  return name[0]?.toUpperCase() || '?';
}

function userAvatarColor(userId: number) {
  const palette = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#626aef', '#909399'];
  return palette[userId % palette.length];
}

function targetTypeLabel(type: string) {
  if (type === 'impression') return '曝光';
  if (type === 'like') return '点赞';
  return '阅读';
}

function orderAuthorInitial(order: OrderApi.ReplenishmentOrderDetail) {
  const name = order.author_name?.trim();
  if (name) return name[0]?.toUpperCase() || '?';
  return targetTypeLabel(order.target_type)[0] || '?';
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    approved: '已同意',
    cancelled: '已取消',
    created: '已创建',
    failed: '补单失败',
    pending: '待同意',
    processing: '补单中',
    rejected: '已拒绝',
    success: '已完成',
  };
  return map[status] || status || '-';
}

function batchStatusClass(status: string) {
  if (status === 'pending') return 'batch-badge--pending';
  if (status === 'processing') return 'batch-badge--processing';
  if (status === 'approved' || status === 'success') return 'batch-badge--done';
  if (status === 'failed' || status === 'rejected') return 'batch-badge--failed';
  return 'batch-badge--default';
}

async function approveRequest(record: OrderApi.ReplenishmentRequest) {
  approvingId.value = record.id;
  try {
    await approveReplenishmentRequestApi(record.id);
    ElMessage.success('已同意补单，正在后台执行中…');
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

function resetFilters() {
  filters.status = 'all';
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
        <div class="stat-icon">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" /><path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd" /></svg>
        </div>
        <div class="stat-body">
          <span>申请数</span>
          <strong>{{ summary.total }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--warning">
        <div class="stat-icon">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd" /></svg>
        </div>
        <div class="stat-body">
          <span>当前待同意</span>
          <strong>{{ summary.pending }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--success">
        <div class="stat-icon">
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" /></svg>
        </div>
        <div class="stat-body">
          <span>待补数量</span>
          <strong>{{ summary.quantity.toLocaleString('zh-CN') }}</strong>
        </div>
      </div>
    </section>

    <section class="record-panel" v-loading="loading">
      <div class="filter-bar">
        <ElSelect v-model="filters.status" class="status-select">
          <ElOption label="全部状态" value="all" />
          <ElOption label="待同意" value="pending" />
          <ElOption label="补单中" value="processing" />
          <ElOption label="已同意" value="approved" />
          <ElOption label="已完成" value="success" />
          <ElOption label="补单失败" value="failed" />
          <ElOption label="已拒绝" value="rejected" />
        </ElSelect>
        <ElButton type="primary" @click="searchRecords">查询</ElButton>
        <ElButton @click="resetFilters">重置</ElButton>
        <span class="filter-count">共 {{ pagination.total }} 条</span>
      </div>

      <div v-if="pendingRecords.length > 0" class="pending-strip">
        <span class="pending-strip-label">待同意 {{ pendingRecords.length }} 条</span>
        <div class="pending-strip-list">
          <button
            v-for="row in pendingRecords"
            :key="row.id"
            class="pending-chip"
            type="button"
            @click="toggleExpand(row.id)"
          >
            <code :title="row.batch_no">{{ shortenBatchNo(row.batch_no) }}</code>
            <span>{{ userDisplayName(row) }}</span>
            <em>待补 {{ row.pending_quantity.toLocaleString('zh-CN') }}</em>
          </button>
        </div>
      </div>

      <div v-if="!loading && records.length === 0" class="empty-hint">
        <p>暂无补单申请</p>
        <small>调整筛选条件后重试</small>
      </div>

      <div v-else class="batch-list">
        <div
          v-for="row in records"
          :key="row.id"
          class="batch-card"
          :class="{
            'batch-card--expanded': expandedIds.has(row.id),
            'batch-card--pending': row.status === 'pending',
          }"
        >
          <div class="batch-head" @click="toggleExpand(row.id)">
            <span class="expand-arrow" :class="{ open: expandedIds.has(row.id) }">›</span>
            <ElAvatar :size="36" :style="{ background: userAvatarColor(row.user_id) }">
              {{ userInitial(row) }}
            </ElAvatar>
            <div class="batch-main">
              <div class="batch-top">
                <span class="batch-badge" :class="batchStatusClass(row.status)">
                  {{ statusLabel(row.status) }}
                </span>
                <ElTag size="small" effect="plain">{{ row.pending_order_count }} 单</ElTag>
              </div>
              <span class="batch-no-text" :title="row.batch_no">{{ shortenBatchNo(row.batch_no) }}</span>
              <div class="batch-sub">
                <span>{{ userDisplayName(row) }}</span>
                <span>{{ formatShortDateTime(row.requested_at) }}</span>
              </div>
            </div>
            <div class="batch-side" @click.stop>
              <div class="batch-stat-row">
                <span>待补 <strong class="text-warning">{{ row.pending_quantity.toLocaleString('zh-CN') }}</strong></span>
                <span v-if="row.estimated_amount">预估 <strong>{{ row.estimated_amount.toFixed(2) }}</strong></span>
              </div>
              <ElPopconfirm
                v-if="row.status === 'pending'"
                title="同意后会立即向上游提交差额补单，确认继续？"
                confirm-button-text="同意补单"
                cancel-button-text="取消"
                @confirm="approveRequest(row)"
              >
                <template #reference>
                  <button
                    class="rp-btn rp-btn--approve rp-btn--sm"
                    :disabled="approvingId === row.id"
                  >
                    {{ approvingId === row.id ? '提交中…' : '同意补单' }}
                  </button>
                </template>
              </ElPopconfirm>
              <span v-else class="handled-text">{{ formatShortDateTime(row.reviewed_at) || '已处理' }}</span>
            </div>
          </div>

          <Transition
            @enter="collapseEnter"
            @after-enter="collapseAfterEnter"
            @leave="collapseLeave"
            @after-leave="collapseAfterLeave"
          >
            <div v-if="expandedIds.has(row.id) && row.orders?.length" class="batch-body">
              <article
                v-for="od in row.orders"
                :key="od.order_id"
                class="order-row"
                @click="goToOrder(row.batch_id, row.batch_no, od.order_no)"
              >
                <div class="order-thumb">
                  <img
                    v-if="avatarVisible(od)"
                    :src="od.avatar_url"
                    alt=""
                    referrerpolicy="no-referrer"
                    @error="onAvatarError(od.order_id)"
                  />
                  <span v-else>{{ orderAuthorInitial(od) }}</span>
                </div>
                <div class="order-row-main">
                  <div class="order-row-title">
                    <strong>{{ od.title || od.note_id || '未命名笔记' }}</strong>
                    <ElTag size="small" effect="plain">{{ targetTypeLabel(od.target_type) }}</ElTag>
                  </div>
                  <div class="order-author-row">
                    <span class="order-author-name">{{ od.author_name || '未知博主' }}</span>
                    <span v-if="od.note_id" class="order-note-id">{{ od.note_id }}</span>
                  </div>
                  <a
                    v-if="od.note_url"
                    class="order-link"
                    :href="od.note_url"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="od.note_url"
                    @click.stop
                  >{{ od.note_url }}</a>
                  <p v-else class="order-link order-link--empty">暂无链接</p>
                  <p class="order-meta">{{ od.order_no }}</p>
                </div>
                <div class="order-row-side">
                  <div class="qty-grid">
                    <span><em>下单</em>{{ od.ordered_quantity.toLocaleString('zh-CN') }}</span>
                    <span><em>实际</em>{{ od.actual_quantity.toLocaleString('zh-CN') }}</span>
                    <span class="qty-shortage"><em>差额</em>{{ od.shortage_quantity.toLocaleString('zh-CN') }}</span>
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
  min-height: calc(100dvh - 88px);
  padding: 20px;
  box-sizing: border-box;
  color: var(--el-text-color-primary);
}

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

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.stat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  flex-shrink: 0;
}

.stat-card--primary .stat-icon {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}

.stat-card--warning .stat-icon {
  background: var(--el-color-warning-light-8);
  color: var(--el-color-warning);
}

.stat-card--success .stat-icon {
  background: var(--el-color-success-light-8);
  color: var(--el-color-success);
}

.stat-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
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

.record-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
}

.status-select {
  width: 160px;
}

.filter-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.pending-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: 10px;
  background: color-mix(in srgb, var(--el-color-warning) 6%, var(--el-bg-color));
}

.pending-strip-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--el-color-warning);
  white-space: nowrap;
}

.pending-strip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pending-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 999px;
  background: var(--el-bg-color);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.12s;
}

.pending-chip:hover {
  border-color: var(--el-color-primary-light-5);
}

.pending-chip code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
}

.pending-chip em {
  font-style: normal;
  color: var(--el-color-warning);
  font-weight: 600;
}

.batch-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.batch-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
  overflow: hidden;
  transition: border-color 0.12s;
}

.batch-card--pending {
  border-color: var(--el-color-warning-light-5);
}

.batch-card--expanded {
  border-color: var(--el-color-primary-light-5);
}

.batch-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}

.batch-head:hover {
  background: var(--el-fill-color-light);
}

.expand-arrow {
  width: 16px;
  flex-shrink: 0;
  font-size: 18px;
  line-height: 36px;
  color: var(--el-text-color-placeholder);
  transition: transform 0.2s, color 0.2s;
}

.expand-arrow.open {
  transform: rotate(90deg);
  color: var(--el-color-primary);
}

.batch-main {
  flex: 1;
  min-width: 0;
}

.batch-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.batch-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}

.batch-badge--pending {
  background: var(--el-color-warning-light-8);
  color: var(--el-color-warning);
}

.batch-badge--processing {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}

.batch-badge--done {
  background: var(--el-color-success-light-8);
  color: var(--el-color-success);
}

.batch-badge--failed {
  background: var(--el-color-danger-light-8);
  color: var(--el-color-danger);
}

.batch-badge--default {
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
}

.batch-no-text {
  display: block;
  margin-top: 4px;
  font-size: 13px;
  font-family: ui-monospace, Consolas, monospace;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-sub {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.batch-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

.batch-stat-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.batch-stat-row strong {
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-text-color-primary);
}

.text-warning {
  color: var(--el-color-warning) !important;
}

.handled-text {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.batch-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-light);
}

.order-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}

.order-row:hover {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
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

.order-row-side {
  flex-shrink: 0;
}

.qty-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.qty-grid span {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.qty-grid em {
  font-style: normal;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  min-width: 28px;
}

.qty-shortage {
  font-weight: 700;
  color: var(--el-color-warning);
}

.rp-btn {
  padding: 5px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid;
  transition: all 0.15s;
  white-space: nowrap;
}

.rp-btn--sm {
  padding: 4px 10px;
  font-size: 11px;
}

.rp-btn--approve {
  border-color: var(--el-color-success-light-5);
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.rp-btn--approve:hover:not(:disabled) {
  background: var(--el-color-success);
  color: #fff;
}

.rp-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.empty-hint {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 48px 16px;
  color: var(--el-text-color-secondary);
}

.empty-hint p {
  margin: 0;
  font-size: 14px;
}

.empty-hint small {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 12px;
  margin-top: auto;
}

@media (max-width: 900px) {
  .replenishment-page {
    padding: 12px;
  }

  .page-head {
    align-items: stretch;
    flex-direction: column;
  }

  .summary-grid {
    grid-template-columns: 1fr;
  }

  .batch-head {
    flex-wrap: wrap;
  }

  .batch-side {
    width: 100%;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
  }

  .filter-count {
    margin-left: 0;
    width: 100%;
  }
}
</style>
