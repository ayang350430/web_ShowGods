<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, ref } from 'vue';

import {
  ElButton,
  ElEmpty,
  ElMessage,
  ElPagination,
  ElTag,
} from 'element-plus';

import {
  getBatchLinkCheckRecordsApi,
  getProblemLinkRecordsApi,
} from '#/api';

const loading = ref(false);
const checkRecords = ref<OrderApi.ProblemLinkRecord[]>([]);
const expandedBatches = ref(new Set<string>());
const selectedBatch = ref<string>('');

function normalizeCheckRecordAsProblem(
  record: OrderApi.BatchLinkCheckRecord,
): OrderApi.ProblemLinkRecord | undefined {
  if (record.valid) return undefined;
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

const batchGroups = computed(() => {
  const map = new Map<string, OrderApi.ProblemLinkRecord[]>();
  for (const record of checkRecords.value) {
    const group = map.get(record.check_batch_no) ?? [];
    group.push(record);
    map.set(record.check_batch_no, group);
  }
  return [...map.entries()]
    .map(([batchNo, items]) => {
      const sorted = items.toSorted((a, b) => Number(a.line_no) - Number(b.line_no));
      return {
        amount: sorted.reduce((t, i) => t + Number(i.payable_amount || 0), 0),
        batchNo,
        failedCount: sorted.filter((i) => !i.valid).length,
        records: sorted,
        successCount: sorted.filter((i) => i.valid).length,
        time: sorted[0]?.created_at || '',
        total: sorted.length,
      };
    })
    .toSorted((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
});

const pagination = ref({ page: 1, page_size: 10 });

const pagedGroups = computed(() => {
  const start = (pagination.value.page - 1) * pagination.value.page_size;
  return batchGroups.value.slice(start, start + pagination.value.page_size);
});

const selectedGroupRecords = computed(() =>
  batchGroups.value.find((g) => g.batchNo === selectedBatch.value)?.records ?? [],
);

const summary = computed(() => ({
  totalBatches: batchGroups.value.length,
  totalLinks: checkRecords.value.length,
  totalFailed: checkRecords.value.filter((r) => !r.valid).length,
}));

function formatDateTime(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatMoney(value?: number) {
  return `${(Number(value) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toggleBatch(batchNo: string) {
  if (expandedBatches.value.has(batchNo)) {
    expandedBatches.value.delete(batchNo);
  } else {
    expandedBatches.value.add(batchNo);
  }
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

function copyTextFallback(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  document.body.append(ta);
  ta.select();
  try { return document.execCommand('copy'); } finally { ta.remove(); }
}

async function copyBatchLinks(records: OrderApi.ProblemLinkRecord[]) {
  if (records.length === 0) return;
  const text = records.map((r) => r.raw).join('\n');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else if (!copyTextFallback(text)) {
      throw new Error('fail');
    }
    ElMessage.success(`已复制 ${records.length} 条链接`);
  } catch {
    if (copyTextFallback(text)) {
      ElMessage.success(`已复制 ${records.length} 条链接`);
    } else {
      ElMessage.error('复制失败');
    }
  }
}

async function loadRecords() {
  loading.value = true;
  try {
    const [problemRecords, linkCheckRecords] = await Promise.all([
      getProblemLinkRecordsApi(),
      getBatchLinkCheckRecordsApi(),
    ]);
    const failedChecks = problemRecords.length === 0
      ? linkCheckRecords.map(normalizeCheckRecordAsProblem).filter((r): r is OrderApi.ProblemLinkRecord => Boolean(r))
      : [];
    const dedupeMap = new Map<string, OrderApi.ProblemLinkRecord>();
    for (const record of [...failedChecks, ...problemRecords]) {
      const key = `${record.check_batch_no}-${record.line_no}-${record.raw}`;
      dedupeMap.set(key, { ...record, valid: false });
    }
    checkRecords.value = [...dedupeMap.values()];
  } finally {
    loading.value = false;
  }
}

onMounted(() => { loadRecords(); });
</script>

<template>
  <div class="check-page">
    <!-- 头部 -->
    <section class="page-head">
      <div class="head-left">
        <span class="eyebrow">CHECK</span>
        <h2>链接检测记录</h2>
        <p class="head-desc">批量下单前的链接检测结果，展示无效或有问题的链接。</p>
      </div>
      <ElButton type="primary" @click="loadRecords">刷新</ElButton>
    </section>

    <!-- 统计 -->
    <section class="summary-bar">
      <div class="summary-card">
        <span class="summary-label">检测批次</span>
        <strong>{{ summary.totalBatches }}</strong>
      </div>
      <div class="summary-card">
        <span class="summary-label">总链接数</span>
        <strong>{{ summary.totalLinks }}</strong>
      </div>
      <div class="summary-card">
        <span class="summary-label">问题链接</span>
        <strong class="text-danger">{{ summary.totalFailed }}</strong>
      </div>
    </section>

    <!-- 详情视图 -->
    <section v-if="selectedBatch" class="detail-panel">
      <div class="detail-head">
        <div>
          <ElButton size="small" @click="selectedBatch = ''">返回列表</ElButton>
          <strong style="margin-left: 12px">{{ selectedBatch }}</strong>
        </div>
        <ElButton size="small" @click="copyBatchLinks(selectedGroupRecords)">
          复制全部链接
        </ElButton>
      </div>
      <div class="link-list">
        <div
          v-for="record in selectedGroupRecords"
          :key="`${record.line_no}-${record.raw}`"
          class="link-row"
        >
          <span class="link-line">#{{ record.line_no }}</span>
          <div class="link-body">
            <span class="link-raw">{{ record.raw }}</span>
            <span v-if="record.errors.length > 0" class="link-errors">
              {{ record.errors.join('、') }}
            </span>
          </div>
          <ElTag v-if="record.title" size="small" type="info" disable-transitions>
            {{ record.title }}
          </ElTag>
        </div>
      </div>
    </section>

    <!-- 批次列表 -->
    <section v-else v-loading="loading" class="batch-list-panel">
      <ElEmpty v-if="batchGroups.length === 0 && !loading" description="暂无检测记录" />
      <div v-for="group in pagedGroups" :key="group.batchNo" class="batch-card">
        <div class="batch-header" @click="toggleBatch(group.batchNo)">
          <div class="batch-info">
            <div class="batch-title-row">
              <strong
                class="batch-no-link"
                @click.stop="selectedBatch = group.batchNo"
              >{{ group.batchNo }}</strong>
              <ElTag size="small" type="warning" disable-transitions>问题链接</ElTag>
              <ElTag size="small" type="info" disable-transitions>{{ group.total }} 条</ElTag>
            </div>
            <span class="batch-time">检测时间：{{ formatDateTime(group.time) }}</span>
          </div>
          <div class="batch-stats">
            <div class="batch-stat">
              <span>总数</span>
              <strong>{{ group.total }}</strong>
            </div>
            <div class="batch-stat">
              <span>通过</span>
              <strong>{{ group.successCount }}</strong>
            </div>
            <div class="batch-stat">
              <span>放弃</span>
              <strong class="text-danger">{{ group.failedCount }}</strong>
            </div>
            <div class="batch-stat">
              <span>预估金额</span>
              <strong>{{ formatMoney(group.amount) }}</strong>
            </div>
          </div>
          <span class="expand-arrow" :class="{ rotated: expandedBatches.has(group.batchNo) }">
            ›
          </span>
        </div>
        <Transition
          @enter="collapseEnter"
          @after-enter="collapseAfterEnter"
          @leave="collapseLeave"
          @after-leave="collapseAfterLeave"
        >
          <div v-if="expandedBatches.has(group.batchNo)" class="batch-body">
            <div class="batch-body-head">
              <span>共 {{ group.records.length }} 条链接</span>
              <ElButton size="small" @click.stop="copyBatchLinks(group.records)">复制全部</ElButton>
            </div>
            <div
              v-for="record in group.records"
              :key="`${record.line_no}-${record.raw}`"
              class="link-row"
            >
              <span class="link-line">#{{ record.line_no }}</span>
              <div class="link-body">
                <span class="link-raw">{{ record.raw }}</span>
                <span v-if="record.errors.length > 0" class="link-errors">
                  {{ record.errors.join('、') }}
                </span>
              </div>
              <span v-if="record.title" class="link-title">{{ record.title }}</span>
            </div>
          </div>
        </Transition>
      </div>

      <div v-if="batchGroups.length > pagination.page_size" class="pagination-bar">
        <ElPagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.page_size"
          :page-sizes="[10, 20, 50]"
          :total="batchGroups.length"
          background
          layout="total, sizes, prev, pager, next"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.check-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 20px;
}

/* ---- head ---- */
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.eyebrow {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--el-color-warning);
}

.page-head h2 { margin: 4px 0 6px; font-size: 22px; font-weight: 700; }
.head-desc { color: var(--el-text-color-secondary); font-size: 13px; margin: 0; }

/* ---- summary ---- */
.summary-bar {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.summary-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px 20px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: var(--el-bg-color);
}

.summary-label { font-size: 12px; color: var(--el-text-color-secondary); }
.summary-card strong { font-size: 22px; font-weight: 700; }
.text-danger { color: var(--el-color-danger) !important; }

/* ---- batch list ---- */
.batch-list-panel {
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
  padding: 16px;
}

.batch-card {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.2s;
}

.batch-card + .batch-card { margin-top: 10px; }

.batch-card:hover { border-color: var(--el-border-color); }

.batch-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  cursor: pointer;
  transition: background 0.15s;
}

.batch-header:hover { background: var(--el-fill-color-light); }

.batch-info { flex: 1; min-width: 0; }

.batch-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.batch-no-link {
  cursor: pointer;
  color: var(--el-color-primary);
  transition: color 0.15s;
}
.batch-no-link:hover { text-decoration: underline; }

.batch-time {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.batch-stats {
  display: flex;
  gap: 24px;
  flex-shrink: 0;
}

.batch-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 60px;
}

.batch-stat span { font-size: 11px; color: var(--el-text-color-secondary); }
.batch-stat strong { font-size: 15px; font-weight: 600; }

.expand-arrow {
  font-size: 18px;
  color: var(--el-text-color-secondary);
  transition: transform 0.25s;
  flex-shrink: 0;
}

.expand-arrow.rotated { transform: rotate(90deg); }

/* ---- batch body ---- */
.batch-body { padding: 0 18px 14px; }

.batch-body-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0 10px;
  border-top: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.link-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  transition: background 0.15s;
}

.link-row:hover { background: var(--el-fill-color-light); }

.link-line {
  flex-shrink: 0;
  width: 36px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-family: 'SF Mono', 'Consolas', monospace;
  padding-top: 2px;
}

.link-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }

.link-raw {
  word-break: break-all;
  font-family: 'SF Mono', 'Consolas', monospace;
  font-size: 12px;
  color: var(--el-text-color-primary);
}

.link-errors {
  font-size: 12px;
  color: var(--el-color-danger);
}

.link-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
  flex-shrink: 0;
}

/* ---- detail ---- */
.detail-panel {
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
  padding: 16px 20px;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.link-list { display: flex; flex-direction: column; }

/* ---- pagination ---- */
.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  margin-top: 12px;
}

@media (max-width: 768px) {
  .summary-bar { grid-template-columns: 1fr; }
  .batch-stats { flex-wrap: wrap; gap: 12px; }
}
</style>
