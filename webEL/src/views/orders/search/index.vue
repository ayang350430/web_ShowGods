<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, ref } from 'vue';

import { ElButton, ElDatePicker, ElMessage, ElTag } from 'element-plus';

import { searchBatchOrdersApi } from '#/api';

const content = ref('');
const dateRange = ref<[string, string] | undefined>();
const loading = ref(false);
const result = ref<OrderApi.BatchOrderSearchResult>();

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

function serviceLabel(type: string) {
  const map: Record<string, string> = {
    impression: '曝光服务',
    like: '点赞服务',
    view: '阅读服务',
  };
  return map[type] || type || '-';
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    completed: '订单完成',
    failed: '订单失败',
    manual_review: '待审核',
    refund_approved: '已退款',
    refund_rejected: '处理中',
    refund_requested: '退款中',
    repair_review: '待补单',
    running: '进行中',
  };
  return map[status] || status || '-';
}

function statusTagType(status: string) {
  if (status === 'completed') {
    return 'success';
  }
  if (['failed', 'manual_review'].includes(status)) {
    return 'danger';
  }
  if (['refund_approved', 'refund_requested', 'repair_review'].includes(status)) {
    return 'warning';
  }
  return 'primary';
}

async function searchOrders() {
  if (!content.value.trim()) {
    ElMessage.warning('请输入要查询的链接');
    return;
  }
  loading.value = true;
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
</script>

<template>
  <div class="batch-search-page">
    <section class="search-panel">
      <div class="panel-title">
        <div>
          <h2>批量订单查找</h2>
          <p>输入链接后查询所有匹配的下单记录。</p>
        </div>
        <div class="action-row">
          <ElDatePicker
            v-model="dateRange"
            end-placeholder="结束日期"
            range-separator="至"
            start-placeholder="开始日期"
            type="daterange"
            value-format="YYYY-MM-DD"
          />
          <ElButton :loading="loading" type="primary" @click="searchOrders">
            查询
          </ElButton>
        </div>
      </div>

      <div class="input-label">
        <strong>批量内容（查询）</strong>
        <span>已输入 {{ lineCount }} 行</span>
      </div>
      <textarea
        v-model="content"
        class="batch-textarea"
        placeholder="示例：https://xhslink.com/xxxxxx"
        spellcheck="false"
      />
    </section>

    <section v-if="result" class="result-panel">
      <div class="result-head">
        <strong>查询结果</strong>
        <span>
          输入 {{ result.total_count }} 条，找到 {{ result.matched_count }} 条订单
        </span>
      </div>

      <div v-if="invalidLinks.length > 0" class="invalid-box">
        <strong>无效链接</strong>
        <span
          v-for="item in invalidLinks"
          :key="`${item.line_no}-${item.raw}`"
        >
          #{{ item.line_no }} {{ item.raw }}：{{ item.errors.join('、') }}
        </span>
      </div>

      <div v-if="orders.length > 0" class="order-list">
        <article v-for="order in orders" :key="order.id" class="order-row">
          <div class="image-box">
            <img v-if="order.avatar_url" :src="order.avatar_url" alt="" />
            <span v-else>{{ serviceLabel(order.target_type).slice(0, 2) }}</span>
          </div>
          <div class="main-info">
            <div class="meta-line">
              <span>订单编号：{{ order.order_no }}</span>
              <span>订单ID：{{ order.id }}</span>
              <span>订单创建时间：{{ formatDateTime(order.created_at) }}</span>
            </div>
            <strong>{{ order.title || order.note_id }}</strong>
            <small>{{ order.author_name || '-' }} / {{ order.note_id }}</small>
            <em>{{ order.source_note_url || order.note_url }}</em>
          </div>
          <div class="service-info">
            <strong>{{ serviceLabel(order.target_type) }}</strong>
            <span>批次：{{ order.batch_no }}</span>
            <span>匹配：{{ order.matched_input || '-' }}</span>
          </div>
          <div class="quantity-info">
            <strong>{{ order.ordered_quantity.toLocaleString('zh-CN') }}</strong>
            <span>{{ order.completed_quantity.toLocaleString('zh-CN') }} 已完成</span>
          </div>
          <div class="status-info">
            <ElTag :type="statusTagType(order.order_status)" effect="plain">
              {{ statusLabel(order.order_status) }}
            </ElTag>
          </div>
          <div class="amount-info">
            <strong>￥ {{ Number(order.actual_paid_amount || 0).toFixed(2) }}</strong>
          </div>
        </article>
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

.search-panel,
.result-panel {
  padding: 24px 32px;
  background: hsl(var(--card));
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
}

.panel-title,
.result-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.panel-title h2 {
  margin: 0 0 6px;
  font-size: 22px;
}

.panel-title p,
.result-head span,
.input-label span,
.main-info small,
.main-info em,
.service-info span,
.quantity-info span {
  color: var(--el-text-color-secondary);
}

.input-label {
  display: flex;
  gap: 18px;
  align-items: center;
  margin-bottom: 10px;
}

.batch-textarea {
  width: 100%;
  min-height: 275px;
  padding: 16px;
  color: hsl(var(--foreground));
  resize: vertical;
  background: transparent;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  outline: none;
}

.batch-textarea:focus {
  border-color: var(--el-color-primary);
}

.action-row {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: flex-end;
  width: min(520px, 45vw);
  padding-top: 2px;
  margin-left: auto;
}

.action-row :deep(.el-date-editor) {
  flex: 1;
  min-width: 360px;
  max-width: 440px;
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
  gap: 12px;
}

.order-row {
  display: grid;
  grid-template-columns: 96px minmax(260px, 1fr) 250px 120px 110px 130px;
  gap: 18px;
  align-items: center;
  padding: 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
}

.image-box {
  display: grid;
  width: 96px;
  height: 96px;
  place-items: center;
  overflow: hidden;
  color: var(--el-color-primary);
  font-weight: 700;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.image-box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.main-info,
.service-info,
.quantity-info,
.status-info,
.amount-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.main-info strong,
.main-info small,
.main-info em,
.service-info span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-line {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.empty-result {
  padding: 40px 0;
  color: var(--el-text-color-secondary);
  text-align: center;
}

@media (max-width: 1200px) {
  .order-row {
    grid-template-columns: 80px 1fr;
  }
}

@media (max-width: 900px) {
  .panel-title {
    flex-direction: column;
  }

  .action-row {
    justify-content: flex-start;
    width: 100%;
    margin-left: 0;
  }

  .action-row :deep(.el-date-editor) {
    min-width: 0;
    max-width: none;
  }
}
</style>
