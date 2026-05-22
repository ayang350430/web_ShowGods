<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, ref } from 'vue';

import {
  ElButton,
  ElDatePicker,
  ElMessage,
  ElMessageBox,
  ElTag,
} from 'element-plus';

import { requestOrderRefundApi, searchBatchOrdersApi } from '#/api';

const content = ref('');
const dateRange = ref<[string, string] | undefined>();
const loading = ref(false);
const result = ref<OrderApi.BatchOrderSearchResult>();
const expandedIds = ref(new Set<number>());
const refundLoadingId = ref<number>();

const lineCount = computed(() =>
  content.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length,
);

const orders = computed(() => result.value?.items ?? []);
const invalidLinks = computed(() =>
  (result.value?.links ?? []).filter((item) => !item.valid),
);

function formatDateTime(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatMoney(value?: number) {
  return `￥ ${(Number(value) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function serviceLabel(type: string) {
  const map: Record<string, string> = { impression: '曝光', like: '点赞', view: '阅读' };
  return map[type] || type || '-';
}

function serviceTagType(type: string) {
  if (type === 'view') return 'primary';
  if (type === 'like') return 'danger';
  return 'warning';
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    completed: '订单完成',
    failed: '订单失败',
    manual_review: '人工处理',
    refund_approved: '退款已通过',
    refund_calculating: '退款计算中',
    refund_rejected: '退款已拒绝',
    refund_requested: '退款中',
    repair_review: '需要补单',
    running: '进行中',
    stopping: '停止中',
  };
  return map[status] || status || '-';
}

function statusTagType(status: string) {
  if (status === 'completed') return 'success';
  if (['failed', 'manual_review'].includes(status)) return 'danger';
  if (['refund_approved', 'refund_requested', 'repair_review'].includes(status)) return 'warning';
  return 'primary';
}

function displayStatusLabel(order: OrderApi.BatchOrderRecordItem) {
  if (order.order_status === 'running' && order.external_status === 'completed') return '上游完成';
  return statusLabel(order.order_status);
}

function externalStatusLabel(status: string) {
  const map: Record<string, string> = { completed: '已完成', failed: '失败', pending: '等待中', running: '进行中', stopped: '已停止', stopping: '停止中' };
  return map[status] || status || '-';
}

function refundLabel(order: OrderApi.BatchOrderRecordItem) {
  if (order.order_status === 'refund_approved') return '已退款';
  if (order.order_status === 'refund_rejected') return '退款已拒绝';
  if (['refund_calculating', 'stopping'].includes(order.order_status)) return '退款中';
  if (order.refund_amount > 0) return '已退款';
  if (order.order_status === 'failed' && Number(order.actual_paid_amount || 0) <= 0) return '已退款';
  if (['refund_requested', 'refund_calculating'].includes(order.order_status)) return '退款中';
  return '无退款';
}

function canRequestRefund(order: OrderApi.BatchOrderRecordItem) {
  const blocked = ['failed', 'refund_approved', 'refund_calculating', 'refund_rejected', 'refund_requested', 'stopping'];
  if (blocked.includes(order.order_status)) return false;
  if (Number(order.refund_amount || 0) > 0) return false;
  return true;
}

function toggleExpand(id: number) {
  if (expandedIds.value.has(id)) {
    expandedIds.value.delete(id);
  } else {
    expandedIds.value.add(id);
  }
}

function expandEnter(el: Element) {
  const h = el as HTMLElement;
  h.style.overflow = 'hidden';
  h.style.height = '0';
  h.style.opacity = '0';
  void h.offsetHeight;
  h.style.transition = 'height 0.3s ease-out, opacity 0.25s ease-out';
  h.style.height = `${h.scrollHeight}px`;
  h.style.opacity = '1';
}
function expandAfterEnter(el: Element) {
  const h = el as HTMLElement;
  h.style.height = '';
  h.style.overflow = '';
  h.style.transition = '';
}
function expandLeave(el: Element) {
  const h = el as HTMLElement;
  h.style.overflow = 'hidden';
  h.style.height = `${h.scrollHeight}px`;
  void h.offsetHeight;
  h.style.transition = 'height 0.25s ease-in, opacity 0.2s ease-in';
  h.style.height = '0';
  h.style.opacity = '0';
}
function expandAfterLeave(el: Element) {
  const h = el as HTMLElement;
  h.style.height = '';
  h.style.overflow = '';
  h.style.transition = '';
  h.style.opacity = '';
}

async function searchOrders() {
  if (!content.value.trim()) {
    ElMessage.warning('请输入要查询的链接');
    return;
  }
  loading.value = true;
  expandedIds.value.clear();
  try {
    result.value = await searchBatchOrdersApi({
      content: content.value,
      end_date: dateRange.value?.[1],
      start_date: dateRange.value?.[0],
    });
    ElMessage.success(`查询完成，找到 ${result.value.matched_count} 条订单`);
  } catch (error: any) {
    ElMessage.error(error?.message || '查询失败，请稍后重试');
  } finally {
    loading.value = false;
  }
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
    await searchOrders();
  } catch (error: any) {
    ElMessage.error(error?.message || '退款申请失败');
  } finally {
    refundLoadingId.value = undefined;
  }
}
</script>

<template>
  <div class="batch-search-page">
    <!-- 页面头部 -->
    <section class="page-head">
      <div class="head-left">
        <span class="eyebrow">SEARCH</span>
        <h2>批量订单查找</h2>
        <p class="head-desc">输入链接后查询所有匹配的下单记录，支持批量查找和日期筛选。</p>
      </div>
    </section>

    <!-- 搜索区域 -->
    <section class="search-panel">
      <div class="search-toolbar">
        <div class="input-label">
          <strong>批量内容（查询）</strong>
          <ElTag v-if="lineCount > 0" size="small" type="info" disable-transitions>{{ lineCount }} 行</ElTag>
        </div>
        <div class="toolbar-right">
          <ElDatePicker
            v-model="dateRange"
            end-placeholder="结束日期"
            range-separator="至"
            start-placeholder="开始日期"
            type="daterange"
            value-format="YYYY-MM-DD"
            style="width: 260px"
            clearable
          />
          <ElButton :loading="loading" type="primary" @click="searchOrders">
            查询
          </ElButton>
        </div>
      </div>
      <textarea
        v-model="content"
        class="batch-textarea"
        placeholder="每行一条链接，例如：&#10;https://xhslink.com/xxxxxx&#10;https://www.xiaohongshu.com/explore/xxxxxx"
        spellcheck="false"
        @keydown.ctrl.enter="searchOrders"
      />
      <div class="textarea-hint">
        按 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 快速查询
      </div>
    </section>

    <!-- 查询结果 -->
    <section v-if="result" class="result-panel">
      <div class="result-head">
        <div class="result-title">
          <strong>查询结果</strong>
          <ElTag size="small" type="success" disable-transitions>{{ result.matched_count }} 条匹配</ElTag>
        </div>
        <span class="result-meta">
          输入 {{ result.total_count }} 条链接，找到 {{ result.matched_count }} 条订单
          <template v-if="invalidLinks.length > 0">
            ，{{ invalidLinks.length }} 条无效
          </template>
        </span>
      </div>

      <div v-if="invalidLinks.length > 0" class="invalid-box">
        <strong>无效链接</strong>
        <span v-for="item in invalidLinks" :key="`${item.line_no}-${item.raw}`">
          #{{ item.line_no }} {{ item.raw }}：{{ item.errors.join('、') }}
        </span>
      </div>

      <div v-if="orders.length > 0" class="order-list">
        <div v-for="order in orders" :key="order.id" class="order-card">
          <article class="order-row" @click="toggleExpand(order.id)">
            <div class="row-top">
              <div class="product-cell">
                <div class="product-thumb">
                  <img v-if="order.avatar_url" :src="order.avatar_url" alt="" />
                  <span v-else>{{ serviceLabel(order.target_type).slice(0, 1) }}</span>
                </div>
                <div class="product-text">
                  <div class="order-meta">
                    <span>订单编号：{{ order.order_no }}</span>
                    <span>订单创建时间：{{ formatDateTime(order.created_at) }}</span>
                  </div>
                  <strong>{{ order.title || order.note_id }}</strong>
                  <span class="author-line">{{ order.author_name || '-' }} / {{ order.note_id }}</span>
                  <span class="link-line">{{ order.source_note_url || order.note_url }}</span>
                </div>
              </div>
              <div class="tag-cell">
                <span class="tag-head">{{ serviceLabel(order.target_type) }}服务</span>
                <span>订单ID：{{ order.id }}</span>
                <span>批次：{{ order.batch_no }}</span>
                <span>匹配：{{ order.matched_input || '-' }}</span>
              </div>
              <div class="num-cell">
                <span class="num-label">单价</span>
                <strong>{{ formatMoney(order.actual_paid_amount || order.payable_amount) }}</strong>
              </div>
              <div class="num-cell">
                <span class="num-label">数量</span>
                <strong>{{ order.ordered_quantity.toLocaleString('zh-CN') }}</strong>
                <span class="num-sub">{{ (order.completed_quantity || 0).toLocaleString('zh-CN') }} 已完成</span>
              </div>
              <div class="status-cell">
                <ElTag :type="statusTagType(order.order_status)" effect="plain" size="small">
                  {{ displayStatusLabel(order) }}
                </ElTag>
              </div>
              <div class="num-cell">
                <span class="num-label">售后退款</span>
                <span class="refund-text" :class="{ 'has-refund': Number(order.refund_amount) > 0 }">{{ refundLabel(order) }}</span>
              </div>
              <div class="num-cell num-right">
                <span class="num-label">实际付款金额</span>
                <strong class="amount-text">{{ formatMoney(order.actual_paid_amount || order.payable_amount) }}</strong>
              </div>
              <span class="row-expand-arrow" :class="{ rotated: expandedIds.has(order.id) }">▾</span>
            </div>
          </article>

          <Transition @enter="expandEnter" @after-enter="expandAfterEnter" @leave="expandLeave" @after-leave="expandAfterLeave">
          <div v-if="expandedIds.has(order.id)" class="expand-panel">
            <div class="exp-section">
              <div class="exp-section-title">基本信息</div>
              <div class="exp-grid">
                <div class="exp-cell">
                  <span class="exp-label">订单编号</span>
                  <span class="exp-value mono">{{ order.order_no }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">订单ID</span>
                  <span class="exp-value mono">{{ order.id }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">服务类型</span>
                  <span class="exp-value">
                    <ElTag size="small" :type="serviceTagType(order.target_type)" disable-transitions>{{ serviceLabel(order.target_type) }}</ElTag>
                  </span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">订单状态</span>
                  <span class="exp-value">
                    <ElTag size="small" :type="statusTagType(order.order_status)" disable-transitions>{{ displayStatusLabel(order) }}</ElTag>
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
                  <span class="exp-value mono">{{ order.note_id || '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">博主ID</span>
                  <span class="exp-value mono">{{ order.author_id || '-' }}</span>
                </div>
                <div class="exp-cell exp-wide">
                  <span class="exp-label">原始链接</span>
                  <a v-if="order.source_note_url" class="exp-link" :href="order.source_note_url" target="_blank" @click.stop>{{ order.source_note_url }}</a>
                  <span v-else class="exp-value">-</span>
                </div>
                <div class="exp-cell exp-wide">
                  <span class="exp-label">解析链接</span>
                  <a v-if="order.note_url" class="exp-link" :href="order.note_url" target="_blank" @click.stop>{{ order.note_url }}</a>
                  <span v-else class="exp-value">-</span>
                </div>
              </div>
            </div>

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

            <div class="exp-section">
              <div class="exp-section-title">外部任务</div>
              <div class="exp-grid">
                <div class="exp-cell">
                  <span class="exp-label">外部任务ID</span>
                  <span class="exp-value mono">{{ order.external_task_id || '-' }}</span>
                </div>
                <div class="exp-cell">
                  <span class="exp-label">外部状态</span>
                  <span class="exp-value">{{ externalStatusLabel(order.external_status) }}</span>
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

            <div v-if="canRequestRefund(order)" class="expand-actions">
              <ElButton
                type="danger"
                :loading="refundLoadingId === order.id"
                @click.stop="handleRequestRefund(order)"
              >
                申请退款
              </ElButton>
            </div>
          </div>
          </Transition>
        </div>
      </div>

      <div v-else class="empty-result">没有找到匹配订单</div>
    </section>
  </div>
</template>

<style scoped>
.batch-search-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 20px;
  color: hsl(var(--foreground));
}

/* ---- 页面头部 ---- */
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
  color: var(--el-color-primary);
}

.page-head h2 {
  margin: 4px 0 6px;
  font-size: 22px;
  font-weight: 700;
}

.head-desc {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin: 0;
}

/* ---- 搜索面板 ---- */
.search-panel,
.result-panel {
  padding: 20px 24px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
}

.search-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.input-label {
  display: flex;
  gap: 10px;
  align-items: center;
}

.input-label strong {
  font-size: 14px;
}

.toolbar-right {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-shrink: 0;
}

.batch-textarea {
  width: 100%;
  min-height: 200px;
  padding: 14px 16px;
  font-size: 13px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  line-height: 1.7;
  color: hsl(var(--foreground));
  resize: vertical;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.batch-textarea:focus {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 3px var(--el-color-primary-light-8);
}

.textarea-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  text-align: right;
}

.textarea-hint kbd {
  display: inline-block;
  padding: 1px 5px;
  font-size: 11px;
  font-family: inherit;
  line-height: 1.4;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: 3px;
}

/* ---- 结果面板 ---- */
.result-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.result-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.result-title strong {
  font-size: 16px;
}

.result-meta {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}


.invalid-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  margin-bottom: 16px;
  color: var(--el-color-danger);
  background: var(--el-color-danger-light-9);
  border: 1px solid var(--el-color-danger-light-5);
  border-radius: 8px;
}

.order-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.order-card {
  border: 1px solid var(--el-border-color-light);
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.order-card:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.04);
}

.order-row {
  cursor: pointer;
}

.row-top {
  display: grid;
  grid-template-columns: minmax(320px, 2fr) minmax(160px, 1fr) 90px 90px 90px 90px 120px 28px;
  gap: 14px;
  align-items: center;
  padding: 16px 18px;
}

/* ---- 商品信息 ---- */
.product-cell {
  display: flex;
  gap: 14px;
  align-items: center;
  min-width: 0;
}

.product-thumb {
  width: 80px;
  height: 80px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--el-fill-color-light);
  display: grid;
  place-items: center;
  color: var(--el-color-primary);
  font-weight: 700;
  font-size: 20px;
}

.product-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.product-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.order-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.product-text > strong {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.author-line {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-line {
  font-size: 12px;
  font-family: Consolas, 'SF Mono', monospace;
  color: var(--el-color-primary-light-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 标签列 ---- */
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

/* ---- 数值列 ---- */
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

/* ---- 状态列 ---- */
.status-cell {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* ---- 退款文本 ---- */
.refund-text {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.refund-text.has-refund {
  color: var(--el-color-warning);
  font-weight: 600;
}

/* ---- 展开箭头 ---- */
.row-expand-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-placeholder);
  font-size: 14px;
  transition: transform 0.25s;
}

.row-expand-arrow.rotated {
  transform: rotate(180deg);
  color: var(--el-color-primary);
}

/* Expand panel */
.expand-panel {
  padding: 0 20px 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-blank);
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

.exp-stat-num.text-primary { color: var(--el-color-primary); }
.exp-stat-num.text-success { color: var(--el-color-success); }
.exp-stat-num.text-warning { color: var(--el-color-warning); }

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

.empty-result {
  padding: 40px 0;
  color: var(--el-text-color-secondary);
  text-align: center;
}

@media (max-width: 1200px) {
  .row-top {
    grid-template-columns: 1fr;
    gap: 10px;
  }
}

@media (max-width: 900px) {
  .search-toolbar {
    flex-direction: column;
    align-items: flex-start;
  }

  .toolbar-right {
    width: 100%;
  }

  .result-head {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
