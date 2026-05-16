<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, ref } from 'vue';

import { createIconifyIcon } from '@vben/icons';

import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElDrawer,
  ElInput,
  ElMessage,
  ElOption,
  ElRadioButton,
  ElRadioGroup,
  ElSelect,
  ElTag,
} from 'element-plus';

import {
  checkBackendConnectionApi,
  getBatchLinkCheckRecordsApi,
  getBatchOrderRecordsApi,
  getProblemLinkRecordsApi,
  previewBatchOrderApi,
  previewBatchOrderSilentApi,
  saveProblemLinkRecordsApi,
  submitBatchOrderApi,
} from '#/api';

const AlertIcon = createIconifyIcon('lucide:triangle-alert');
const CheckIcon = createIconifyIcon('lucide:circle-check');
const InfoIcon = createIconifyIcon('lucide:info');
const LinkIcon = createIconifyIcon('lucide:link');
const RefreshIcon = createIconifyIcon('lucide:refresh-cw');

const content = ref('');
const agreePolicy = ref(false);
const checkingConnection = ref(false);
const connectionOk = ref<boolean | undefined>();
const connectionMessage = ref('尚未检测');
const preview = ref<OrderApi.BatchOrderPreview>();
const previewing = ref(false);
const removedDrawerVisible = ref(false);
const orderRecords = ref<OrderApi.BatchOrderRecord[]>([]);
const orderRecordTotal = ref(0);
const selectedDrawerBatchKey = ref('');
const orderDrawerKeyword = ref('');
const orderDrawerStatus = ref<'all' | 'failed' | 'success'>('all');
const removedProblemLinks = ref<OrderApi.ProblemLinkRecord[]>([]);
const recordKeyword = ref('');
const recordStatusFilter = ref<'all' | 'failed' | 'success'>('all');
const selectedCheckRecordId = ref<number>();
const selectedCheckBatchNo = ref('');
const latestPreviewBatchNo = ref('');
const submitting = ref(false);
const targetType = ref<'impression' | 'like' | 'view'>('view');

const parsedLines = computed(() =>
  content.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean),
);

const canSubmit = computed(
  () =>
    Boolean(preview.value?.can_submit) &&
    agreePolicy.value &&
    connectionOk.value === true,
);

const statusType = computed(() => {
  if (connectionOk.value === true) {
    return 'success';
  }
  if (connectionOk.value === false) {
    return 'danger';
  }
  return 'warning';
});

const selectedOrderBatch = computed(() =>
  selectedDrawerBatch.value?.type === 'order'
    ? selectedDrawerBatch.value.record
    : undefined,
);

const selectedProblemBatch = computed(() =>
  selectedDrawerBatch.value?.type === 'problem'
    ? selectedDrawerBatch.value
    : undefined,
);

const visibleOrderDrawerItems = computed(() => {
  const keyword = orderDrawerKeyword.value.trim().toLowerCase();
  return (selectedOrderBatch.value?.orders ?? []).filter((order) => {
    const statusMatched =
      orderDrawerStatus.value === 'all' ||
      (orderDrawerStatus.value === 'success' && order.order_status === 'completed') ||
      (orderDrawerStatus.value === 'failed' && order.order_status === 'failed');
    if (!statusMatched) {
      return false;
    }
    if (!keyword) {
      return true;
    }

    return [
      order.order_no,
      order.note_id,
      order.note_url,
      order.source_note_url,
      order.order_status,
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword);
  });
});

const checkBatchGroups = computed(() => {
  const map = new Map<string, OrderApi.ProblemLinkRecord[]>();
  for (const record of removedProblemLinks.value) {
    const group = map.get(record.check_batch_no) ?? [];
    group.push(record);
    map.set(record.check_batch_no, group);
  }

  return [...map.entries()].map(([batchNo, records]) => {
    const sortedRecords = records.toSorted(
      (a, b) => Number(a.line_no) - Number(b.line_no),
    );

    return {
      batchNo,
      failedCount: sortedRecords.filter((record) => !record.valid).length,
      records: sortedRecords,
      successCount: sortedRecords.filter((record) => record.valid).length,
      time: sortedRecords[0]?.created_at || '',
      total: sortedRecords.length,
    };
  });
});

const drawerBatches = computed(() => {
  const orderBatches = orderRecords.value.map((record) => ({
    amount: Number(record.estimated_amount) || 0,
    batchNo: record.batch_no,
    failedCount: Number(record.failed_count) || 0,
    key: `order-${record.id}`,
    label: `${record.batch_no} / 确认提交 / ${formatDateTime(record.submitted_at || record.created_at)}`,
    record,
    status: record.status,
    successCount: Number(record.succeeded_count) || 0,
    time: record.submitted_at || record.created_at,
    total: Number(record.total_count) || 0,
    type: 'order' as const,
  }));

  const problemBatches = checkBatchGroups.value.map((group) => ({
    amount: group.records.reduce(
      (total, record) => total + Number(record.payable_amount || 0),
      0,
    ),
    batchNo: group.batchNo,
    failedCount: group.failedCount,
    key: `problem-${group.batchNo}`,
    label: `${group.batchNo} / 问题链接 / ${formatDateTime(group.time)}`,
    records: group.records,
    status: group.failedCount > 0 ? 'failed' : 'completed',
    successCount: group.successCount,
    time: group.time,
    total: group.total,
    type: 'problem' as const,
  }));

  return [...orderBatches, ...problemBatches].toSorted(
    (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime(),
  );
});

const selectedDrawerBatch = computed(() => {
  if (!selectedDrawerBatchKey.value) {
    return drawerBatches.value[0];
  }

  return drawerBatches.value.find(
    (record) => record.key === selectedDrawerBatchKey.value,
  );
});

const visibleProblemDrawerItems = computed(() => {
  const keyword = orderDrawerKeyword.value.trim().toLowerCase();
  return (selectedProblemBatch.value?.records ?? []).filter((record) => {
    const statusMatched =
      orderDrawerStatus.value === 'all' ||
      (orderDrawerStatus.value === 'success' && record.valid) ||
      (orderDrawerStatus.value === 'failed' && !record.valid);
    if (!statusMatched) {
      return false;
    }
    if (!keyword) {
      return true;
    }

    return [
      record.raw,
      record.note_id,
      record.note_url,
      record.resolved_note_url,
      record.title,
      record.author_name,
      record.errors.join(' '),
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword);
  });
});

const selectedCheckBatch = computed(() => {
  if (!selectedCheckBatchNo.value) {
    return checkBatchGroups.value[0];
  }

  return checkBatchGroups.value.find(
    (group) => group.batchNo === selectedCheckBatchNo.value,
  );
});

const visibleCheckRecords = computed(() => {
  const keyword = recordKeyword.value.trim().toLowerCase();

  return (selectedCheckBatch.value?.records ?? []).filter((record) => {
    const statusMatched =
      recordStatusFilter.value === 'all' ||
      (recordStatusFilter.value === 'success' && record.valid) ||
      (recordStatusFilter.value === 'failed' && !record.valid);
    if (!statusMatched) {
      return false;
    }
    if (!keyword) {
      return true;
    }

    return [
      record.raw,
      record.note_id,
      record.title,
      record.author_name,
      record.errors.join(' '),
    ]
      .join(' ')
      .toLowerCase()
      .includes(keyword);
  });
});

function formatMoney(value?: number) {
  return `￥ ${(Number(value) || 0).toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

function formatDateTime(value?: string) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function orderRecordStatusLabel(status: string) {
  const statusMap: Record<string, string> = {
    completed: '已完成',
    failed: '失败',
    pending: '待处理',
    processing: '处理中',
  };
  return statusMap[status] || status || '-';
}

function fillExample() {
  content.value = [
    'https://www.xiaohongshu.com/explore/demo-note-001 100',
    'https://xhslink.com/abcdEF 300',
    'https://www.xiaohongshu.com/discovery/item/demo-note-002 500',
  ].join('\n');
}

function syncSelectedDrawerBatch(preferredKey?: string) {
  const key = preferredKey || selectedDrawerBatchKey.value;
  if (key && drawerBatches.value.some((record) => record.key === key)) {
    selectedDrawerBatchKey.value = key;
    return;
  }
  selectedDrawerBatchKey.value = drawerBatches.value[0]?.key ?? '';
}

function copyTextWithFallback(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand('copy');
  } finally {
    textarea.remove();
  }
}

function normalizeCheckRecordAsProblem(
  record: OrderApi.BatchLinkCheckRecord,
): OrderApi.ProblemLinkRecord | undefined {
  if (record.valid) {
    return undefined;
  }

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

async function loadProblemLinkRecords() {
  try {
    const [problemResult, checkResult] = await Promise.allSettled([
      getProblemLinkRecordsApi(),
      getBatchLinkCheckRecordsApi(),
    ]);
    const problemRecords =
      problemResult.status === 'fulfilled' ? problemResult.value : [];
    const failedCheckRecords =
      problemRecords.length === 0 && checkResult.status === 'fulfilled'
        ? checkResult.value
            .map(normalizeCheckRecordAsProblem)
            .filter((record): record is OrderApi.ProblemLinkRecord =>
              Boolean(record),
            )
        : [];
    const dedupeMap = new Map<string, OrderApi.ProblemLinkRecord>();
    for (const record of [...failedCheckRecords, ...problemRecords]) {
      const key = `${record.check_batch_no}-${record.line_no}-${record.raw}`;
      dedupeMap.set(key, {
        ...record,
        valid: false,
      });
    }
    removedProblemLinks.value = [...dedupeMap.values()];
    if (
      removedProblemLinks.value.length > 0 &&
      !checkBatchGroups.value.some(
        (group) => group.batchNo === selectedCheckBatchNo.value,
      )
    ) {
      selectedCheckBatchNo.value =
        (latestPreviewBatchNo.value &&
        checkBatchGroups.value.some(
          (group) => group.batchNo === latestPreviewBatchNo.value,
        )
          ? latestPreviewBatchNo.value
          : checkBatchGroups.value[0]?.batchNo) ?? '';
    }
    if (
      selectedCheckRecordId.value &&
      !visibleCheckRecords.value.some(
        (record) => record.id === selectedCheckRecordId.value,
      )
    ) {
      selectedCheckRecordId.value = undefined;
    }
    syncSelectedDrawerBatch();
  } catch {
    ElMessage.error('校验记录读取失败');
  }
}

async function copySelectedProblemBatchLinks() {
  const recordsToCopy = selectedProblemBatch.value?.records ?? [];
  if (recordsToCopy.length === 0) {
    ElMessage.warning('暂无可复制的问题链接');
    return;
  }

  const copyText = recordsToCopy.map((record) => record.raw).join('\n');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(copyText);
    } else if (!copyTextWithFallback(copyText)) {
      throw new Error('Clipboard fallback failed');
    }
    ElMessage.success(`已复制 ${recordsToCopy.length} 条问题链接`);
  } catch {
    if (copyTextWithFallback(copyText)) {
      ElMessage.success(`已复制 ${recordsToCopy.length} 条问题链接`);
      return;
    }
    ElMessage.error('复制失败，浏览器未授权剪贴板');
  }
}

async function loadOrderRecords(
  preferredBatchNo = '',
  options: { silent?: boolean; skipStatusSync?: boolean } = {},
) {
  try {
    const result = await getBatchOrderRecordsApi(
      {
        page: 1,
        page_size: 100,
        ...(options.skipStatusSync ? { skip_status_sync: 1 as const } : {}),
      },
      { silent: options.silent },
    );
    orderRecords.value = result.items;
    orderRecordTotal.value = result.total;
    if (preferredBatchNo) {
      const preferredRecord = orderRecords.value.find(
        (record) => record.batch_no === preferredBatchNo,
      );
      syncSelectedDrawerBatch(
        preferredRecord ? `order-${preferredRecord.id}` : undefined,
      );
      return;
    }
    syncSelectedDrawerBatch();
  } catch {
    orderRecords.value = [];
    orderRecordTotal.value = 0;
  }
}

function openOrderRecords() {
  removedDrawerVisible.value = true;
  orderDrawerKeyword.value = '';
  orderDrawerStatus.value = 'all';
  loadOrderRecords();
  loadProblemLinkRecords();
}

async function removeProblemLinks() {
  previewing.value = true;
  try {
    preview.value = await previewBatchOrderSilentApi({
      content: content.value,
      target_type: targetType.value,
    });
  } finally {
    previewing.value = false;
  }

  const invalidItems = preview.value.items.filter((item) => !item.valid);
  if (invalidItems.length === 0) {
    ElMessage.warning('暂无检测出问题的链接');
    return;
  }
  if (invalidItems.length >= parsedLines.value.length) {
    ElMessage.warning('当前校验结果全部为问题链接，已停止一键删除，请先检查接口或链接');
    return;
  }

  let saveResult: OrderApi.SaveProblemLinkRecordsResult;
  try {
    saveResult = await saveProblemLinkRecordsApi({
      check_batch_no: preview.value.check_batch_no,
      records: invalidItems.map((item) => ({
        author_name: item.author_name,
        avatar_url: item.avatar_url,
        errors: item.errors,
        line_no: item.line_no,
        note_id: item.note_id,
        note_url: item.note_url,
        ordered_quantity: item.ordered_quantity,
        payable_amount: item.payable_amount,
        raw: item.raw,
        resolved_note_url: item.resolved_note_url,
        title: item.title,
      })),
      target_type: targetType.value,
    });
  } catch {
    ElMessage.error('问题链接记录入库失败，已停止删除');
    return;
  }

  const invalidKeys = new Set(
    invalidItems.map((item) => `${item.line_no}::${item.raw.trim()}`),
  );
  const savedBatchNo = saveResult.check_batch_no || preview.value.check_batch_no;
  const now = new Date().toISOString();
  const localProblemRecords: OrderApi.ProblemLinkRecord[] = invalidItems.map(
    (item, index) => ({
      author_name: item.author_name,
      avatar_url: item.avatar_url,
      check_batch_no: savedBatchNo,
      created_at: now,
      errors: item.errors,
      id: -Date.now() - index,
      line_no: item.line_no,
      note_id: item.note_id,
      note_url: item.note_url,
      ordered_quantity: item.ordered_quantity,
      payable_amount: item.payable_amount,
      raw: item.raw,
      resolved_note_url: item.resolved_note_url,
      target_type: targetType.value,
      title: item.title,
      valid: false,
    }),
  );
  removedProblemLinks.value = [
    ...localProblemRecords,
    ...removedProblemLinks.value.filter(
      (record) => record.check_batch_no !== savedBatchNo,
    ),
  ];

  const sourceLines = content.value.split(/\r?\n/);
  content.value = sourceLines
    .filter((line, index) => !invalidKeys.has(`${index + 1}::${line.trim()}`))
    .join('\n')
    .trim();
  await loadProblemLinkRecords();
  if (
    !removedProblemLinks.value.some(
      (record) => record.check_batch_no === savedBatchNo,
    )
  ) {
    removedProblemLinks.value = [
      ...localProblemRecords,
      ...removedProblemLinks.value,
    ];
  }
  syncSelectedDrawerBatch(`problem-${savedBatchNo}`);
  preview.value = undefined;
  ElMessage.success(`已删除 ${invalidItems.length} 条问题链接，已入库 ${saveResult.saved_count} 条`);
}

async function checkConnection(showSuccess = false) {
  checkingConnection.value = true;
  try {
    const response = await checkBackendConnectionApi();
    const healthStatus =
      response.status === 'ok' ||
      (response as unknown as { data?: OrderApi.HealthResult }).data?.status ===
        'ok';
    connectionOk.value = healthStatus;
    connectionMessage.value = connectionOk.value
      ? '连接正常'
      : '连接异常';
    if (showSuccess && connectionOk.value) {
      ElMessage.success('后端连接检测通过');
    }
    if (!connectionOk.value) {
      ElMessage.error('后端连接检测未通过，请检查服务状态');
    }
  } catch {
    connectionOk.value = false;
    connectionMessage.value = '连接失败';
    ElMessage.error('连接检测失败：无法访问后端服务');
  } finally {
    checkingConnection.value = false;
  }
}

async function validateContent() {
  previewing.value = true;
  try {
    const result = await previewBatchOrderApi({
      content: content.value,
      target_type: targetType.value,
    });
    console.log('[Batch Preview] response', result);
    preview.value = result;
    latestPreviewBatchNo.value = preview.value.check_batch_no;
    selectedCheckBatchNo.value = preview.value.check_batch_no;
    if (preview.value.invalid_count > 0 || preview.value.warnings.length > 0) {
      ElMessage.warning('预校验完成，请处理页面提示后再提交');
      return;
    }
    ElMessage.success('预校验通过');
  } catch (error) {
    console.error('[Batch Preview] error', error);
    throw error;
  } finally {
    previewing.value = false;
  }
}

async function submitOrder() {
  if (connectionOk.value !== true) {
    await checkConnection();
  }
  if (connectionOk.value !== true) {
    return;
  }

  submitting.value = true;
  try {
    const result = await submitBatchOrderApi(
      {
        agree_policy: agreePolicy.value,
        content: content.value,
        target_type: targetType.value,
      },
      { silent: true },
    );
    await loadOrderRecords(result.batch_no, { silent: true, skipStatusSync: true });
    ElMessage.success(`提交成功：${result.batch_no}`);
    content.value = '';
    preview.value = undefined;
    agreePolicy.value = false;
    latestPreviewBatchNo.value = '';
  } finally {
    submitting.value = false;
  }
}

function clearContent() {
  content.value = '';
  preview.value = undefined;
  agreePolicy.value = false;
}

onMounted(() => {
  checkConnection();
  loadOrderRecords();
  loadProblemLinkRecords();
});
</script>

<template>
  <div class="batch-order-page">
    <section
      class="connection-card"
      :class="{ danger: connectionOk === false, success: connectionOk === true }"
    >
      <div class="connection-main">
        <component :is="connectionOk === false ? AlertIcon : LinkIcon" />
        <div>
          <strong>连接检测</strong>
          <span>{{ connectionMessage }}</span>
        </div>
      </div>
      <ElButton :loading="checkingConnection" @click="checkConnection(true)">
        <component :is="RefreshIcon" class="button-icon" />
        重新检测
      </ElButton>
    </section>

    <div class="order-layout">
      <section class="panel input-panel">
        <div class="panel-head">
          <div>
            <h2>批量内容输入</h2>
            <p>格式：链接 + 数量，支持空格或 Tab 分隔。</p>
          </div>
          <ElRadioGroup v-model="targetType" size="small" @change="validateContent">
            <ElRadioButton label="view">阅读</ElRadioButton>
            <ElRadioButton label="like">点赞</ElRadioButton>
            <ElRadioButton label="impression">曝光</ElRadioButton>
          </ElRadioGroup>
        </div>

        <label class="field-label">
          批量内容（{{ targetType === 'view' ? '阅读' : '曝光' }}）
          <span>已输入 {{ parsedLines.length }} 行</span>
        </label>
        <textarea
          v-model="content"
          class="batch-textarea"
          placeholder="示例：https://xhslink.com/xxxxxx 100（仅阅读下单）"
        />

        <div class="actions">
          <ElButton :loading="previewing" @click="validateContent">手动预校验</ElButton>
          <ElButton @click="fillExample">填充示例</ElButton>
          <ElButton :disabled="!preview?.invalid_count" @click="removeProblemLinks">
            一键删除问题链接并记录
          </ElButton>
          <ElButton @click="openOrderRecords">
            下单记录（{{ orderRecordTotal }} 批）
          </ElButton>
          <ElButton @click="clearContent">清空</ElButton>
          <ElButton
            type="primary"
            :disabled="!canSubmit || submitting"
            @click="submitOrder"
          >
            确认提交{{ targetType === 'view' ? '阅读' : '曝光' }}
          </ElButton>
        </div>

        <ElAlert
          class="risk-alert"
          :closable="false"
          show-icon
          type="info"
          title="有封控"
          description="价格上涨，下单自行查看价格"
        />

        <ElCheckbox v-model="agreePolicy">
          我已阅读并确认上述公告内容
        </ElCheckbox>

        <div class="submit-state" :class="{ danger: !canSubmit }">
          <ElTag :type="canSubmit ? 'success' : 'warning'" size="small">
            {{ canSubmit ? '可提交' : '当前不可提交' }}
          </ElTag>
          <span v-if="connectionOk === false">连接检测失败，请先恢复后端服务</span>
          <span v-else-if="!content">请先输入批量下单内容</span>
          <span v-else-if="preview?.warnings.length">{{ preview.warnings[0] }}</span>
          <span v-else-if="!agreePolicy">请确认公告内容</span>
          <span v-else>校验通过，可以提交</span>
        </div>

        <div v-if="preview?.items.length" class="result-list">
          <div
            v-for="item in preview.items"
            :key="item.line_no"
            class="result-row"
            :class="{ invalid: !item.valid }"
          >
            <span>#{{ item.line_no }}</span>
            <div class="note-avatar">
              <img v-if="item.avatar_url" :src="item.avatar_url" alt="" />
              <span v-else>{{ item.note_id.slice(0, 2).toUpperCase() || 'ID' }}</span>
            </div>
            <div class="note-info">
              <strong>
                {{ item.title || item.note_id || '未解析到笔记ID' }}
                <small v-if="item.cache_hit">缓存</small>
              </strong>
              <span v-if="item.author_name">
                {{ item.author_name }} / {{ item.note_id }}
              </span>
              <a v-if="item.note_url" :href="item.note_url" target="_blank">
                {{ item.note_url }}
              </a>
            </div>
            <em>{{ item.ordered_quantity.toLocaleString('zh-CN') }}</em>
            <small>
              {{ item.valid ? formatMoney(item.payable_amount) : item.errors.join('、') }}
            </small>
          </div>
        </div>

      </section>

      <aside class="panel settlement-panel">
        <h2>结算与余额</h2>
        <div class="settlement-body">
          <template v-if="preview">
            <div class="amount-main">
              <span>预计扣费</span>
              <strong>{{ formatMoney(preview.total_amount) }}</strong>
            </div>
            <div class="settlement-grid">
              <div>
                <span>有效行</span>
                <strong>{{ preview.valid_count }}</strong>
              </div>
              <div>
                <span>失败行</span>
                <strong :class="{ red: preview.invalid_count > 0 }">
                  {{ preview.invalid_count }}
                </strong>
              </div>
              <div>
                <span>可用余额</span>
                <strong>{{ formatMoney(preview.available_balance) }}</strong>
              </div>
              <div>
                <span>单价</span>
                <strong>{{ formatMoney(preview.discounted_unit_price) }}</strong>
              </div>
            </div>
            <div v-if="preview.warnings.length" class="warning-box">
              <component :is="AlertIcon" />
              <span>{{ preview.warnings.join('；') }}</span>
            </div>
          </template>
          <p v-else>
            输入有效内容后会自动预校验，金额以服务端计算为准。
          </p>
        </div>

        <div class="connection-summary" :class="statusType">
          <component :is="connectionOk ? CheckIcon : InfoIcon" />
          <span>{{ connectionMessage }}</span>
        </div>
      </aside>
    </div>

    <ElDrawer
      v-model="removedDrawerVisible"
      append-to-body
      class="problem-record-drawer"
      direction="rtl"
      size="560px"
      title="下单记录"
    >
      <div v-if="drawerBatches.length" class="order-record-drawer-list">
        <div class="drawer-actions">
          <ElSelect
            v-model="selectedDrawerBatchKey"
            class="batch-select"
            placeholder="选择批次"
          >
            <ElOption
              v-for="record in drawerBatches"
              :key="record.key"
              :label="record.label"
              :value="record.key"
            />
          </ElSelect>
        </div>
        <article
          v-if="selectedOrderBatch"
          class="order-record-drawer-row order-batch-card"
        >
          <div class="order-record-drawer-head">
            <strong>{{ selectedOrderBatch.batch_no }}</strong>
            <div class="drawer-title-tags">
              <ElTag size="small" type="primary">确认提交</ElTag>
              <ElTag size="small">
              {{ orderRecordStatusLabel(selectedOrderBatch.status) }}
            </ElTag>
            </div>
          </div>
          <div class="order-record-drawer-meta">
            <span>
              提交时间：{{
                formatDateTime(
                  selectedOrderBatch.submitted_at || selectedOrderBatch.created_at,
                )
              }}
            </span>
            <span>订单数：{{ selectedOrderBatch.total_count }}</span>
            <span>金额：{{ formatMoney(selectedOrderBatch.estimated_amount) }}</span>
          </div>
          <div class="batch-summary-tags">
            <ElTag size="small" type="success">
              成功 {{ selectedOrderBatch.succeeded_count }}
            </ElTag>
            <ElTag size="small" type="danger">
              失败 {{ selectedOrderBatch.failed_count }}
            </ElTag>
            <ElTag size="small">总数 {{ selectedOrderBatch.total_count }}</ElTag>
          </div>
          <div class="record-filters">
            <ElInput
              v-model="orderDrawerKeyword"
              clearable
              placeholder="搜索链接、订单号、笔记ID"
            />
            <ElSelect v-model="orderDrawerStatus" class="status-select">
              <ElOption label="全部" value="all" />
              <ElOption label="成功" value="success" />
              <ElOption label="失败" value="failed" />
            </ElSelect>
          </div>
          <div class="order-record-drawer-items">
            <div
              v-for="order in visibleOrderDrawerItems"
              :key="order.id"
              class="order-record-drawer-item"
              :class="{
                failed: order.order_status === 'failed',
                success: order.order_status === 'completed',
              }"
            >
              <div>
                <span>{{ order.order_no }}</span>
                <small>订单ID：{{ order.id }}</small>
                <em>{{ order.source_note_url || order.note_url || '-' }}</em>
              </div>
              <strong>{{ order.ordered_quantity.toLocaleString('zh-CN') }}</strong>
              <ElTag
                class="order-status-tag"
                size="small"
                :type="
                  order.order_status === 'failed'
                    ? 'danger'
                    : order.order_status === 'completed'
                      ? 'success'
                      : 'warning'
                "
              >
                {{
                  order.order_status === 'failed'
                    ? '失败'
                    : order.order_status === 'completed'
                      ? '成功'
                      : '进行中'
                }}
              </ElTag>
            </div>
            <div
              v-if="visibleOrderDrawerItems.length === 0"
              class="empty-records compact"
            >
              暂无匹配的下单记录
            </div>
          </div>
        </article>

        <article
          v-else-if="selectedProblemBatch"
          class="order-record-drawer-row problem-batch-card"
        >
          <div class="order-record-drawer-head">
            <strong>{{ selectedProblemBatch.batchNo }}</strong>
            <div class="drawer-title-tags">
              <ElTag size="small" type="warning">问题链接</ElTag>
              <ElTag size="small" type="danger">放弃</ElTag>
              <ElButton
                size="small"
                type="primary"
                @click="copySelectedProblemBatchLinks"
              >
                一键复制
              </ElButton>
            </div>
          </div>
          <div class="order-record-drawer-meta">
            <span>检测时间：{{ formatDateTime(selectedProblemBatch.time) }}</span>
            <span>检测数：{{ selectedProblemBatch.total }}</span>
            <span>预估金额：{{ formatMoney(selectedProblemBatch.amount) }}</span>
          </div>
          <div class="batch-summary-tags">
            <ElTag size="small" type="success">
              通过 {{ selectedProblemBatch.successCount }}
            </ElTag>
            <ElTag size="small" type="danger">
              放弃 {{ selectedProblemBatch.failedCount }}
            </ElTag>
            <ElTag size="small">总数 {{ selectedProblemBatch.total }}</ElTag>
          </div>
          <ElButton
            class="copy-problem-links-button"
            type="primary"
            @click="copySelectedProblemBatchLinks"
          >
            一键复制问题记录链接
          </ElButton>
          <div class="record-filters">
            <ElInput
              v-model="orderDrawerKeyword"
              clearable
              placeholder="搜索链接、标题、作者、笔记ID"
            />
            <ElSelect v-model="orderDrawerStatus" class="status-select">
              <ElOption label="全部" value="all" />
              <ElOption label="成功" value="success" />
              <ElOption label="放弃" value="failed" />
            </ElSelect>
          </div>
          <div class="order-record-drawer-items">
            <div
              v-for="record in visibleProblemDrawerItems"
              :key="record.id"
              class="order-record-drawer-item problem-link-item"
              :class="{ failed: !record.valid, success: record.valid }"
            >
              <div>
                <span>{{ record.title || record.note_id || '未解析到笔记ID' }}</span>
                <em>{{ record.raw }}</em>
              </div>
              <strong>{{ record.ordered_quantity.toLocaleString('zh-CN') }}</strong>
              <ElTag
                class="order-status-tag"
                size="small"
                :type="record.valid ? 'success' : 'danger'"
              >
                {{ record.valid ? '成功' : '放弃' }}
              </ElTag>
            </div>
            <div
              v-if="visibleProblemDrawerItems.length === 0"
              class="empty-records compact"
            >
              暂无匹配的问题链接记录
            </div>
          </div>
        </article>
      </div>
      <div v-else class="empty-records">暂无下单记录</div>
    </ElDrawer>
  </div>
</template>

<style scoped>
.batch-order-page {
  min-height: 100%;
  padding: 16px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-primary);
}

.connection-card,
.panel {
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.connection-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  padding: 14px 18px;
}

.connection-card.danger {
  border-color: var(--el-color-danger);
  background: color-mix(in srgb, var(--el-color-danger) 10%, var(--el-bg-color));
}

.connection-card.success {
  border-color: var(--el-color-success);
}

.connection-main,
.actions,
.submit-state,
.result-row,
.connection-summary,
.warning-box {
  display: flex;
  align-items: center;
}

.connection-main {
  gap: 10px;
}

.connection-main svg,
.connection-summary svg,
.warning-box svg {
  width: 20px;
  height: 20px;
}

.connection-card.danger .connection-main svg,
.connection-card.danger .connection-main strong,
.submit-state.danger,
.red {
  color: var(--el-color-danger);
}

.connection-main strong,
.connection-main span {
  display: block;
}

.connection-main span {
  color: var(--el-text-color-secondary);
}

.button-icon {
  width: 15px;
  height: 15px;
  margin-right: 6px;
}

.order-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 420px;
  gap: 64px;
}

.panel {
  padding: 26px 32px;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.panel h2 {
  margin: 0 0 10px;
  font-size: 20px;
}

.panel p,
.field-label,
.result-row small,
.settlement-grid span,
.amount-main span {
  color: var(--el-text-color-secondary);
}

.field-label {
  display: block;
  margin: 28px 0 10px;
  font-weight: 650;
}

.field-label span {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-weight: 400;
}

.batch-textarea {
  width: 100%;
  min-height: 276px;
  padding: 14px;
  resize: vertical;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  outline: none;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font: inherit;
}

.batch-textarea:focus {
  border-color: var(--el-color-primary);
}

.actions {
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.risk-alert {
  margin: 14px 0 10px;
}

.submit-state {
  gap: 10px;
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-fill-color-blank);
}

.result-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.result-row {
  grid-template-columns: 48px 42px minmax(0, 1fr) 90px 180px;
  display: grid;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.result-row.invalid {
  border-color: var(--el-color-danger);
  background: color-mix(in srgb, var(--el-color-danger) 8%, var(--el-bg-color));
}

.result-row strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-weight: 650;
}

.note-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.note-info {
  min-width: 0;
}

.note-info a {
  display: block;
  overflow: hidden;
  margin-top: 2px;
  color: var(--el-text-color-secondary);
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-info span {
  display: block;
  overflow: hidden;
  margin-top: 2px;
  color: var(--el-text-color-regular);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-info strong small {
  margin-left: 8px;
  color: var(--el-color-success);
  font-weight: 400;
}

.note-info a:hover {
  color: var(--el-color-primary);
}

.removed-records {
  display: grid;
  gap: 10px;
}

.drawer-actions,
.removed-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.drawer-actions {
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.batch-select {
  min-width: 0;
  flex: 1;
}

.order-record-drawer-list {
  display: grid;
  gap: 12px;
}

.order-record-drawer-row {
  padding: 12px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.problem-batch-card {
  border-color: var(--el-color-warning-light-5);
  background: color-mix(in srgb, var(--el-color-warning) 5%, var(--el-bg-color));
}

.order-record-drawer-head,
.order-record-drawer-meta,
.order-record-drawer-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.order-record-drawer-head {
  justify-content: space-between;
}

.drawer-title-tags {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
}

.order-record-drawer-head strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-record-drawer-meta {
  flex-wrap: wrap;
  margin-top: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.order-record-drawer-items {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.order-record-drawer-item {
  align-items: center;
  padding: 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.order-record-drawer-item.success {
  border-color: var(--el-color-success-light-5);
  background: color-mix(in srgb, var(--el-color-success) 7%, var(--el-bg-color));
}

.order-record-drawer-item.failed {
  border-color: var(--el-color-danger-light-5);
  background: color-mix(in srgb, var(--el-color-danger) 7%, var(--el-bg-color));
}

.order-record-drawer-item > div {
  min-width: 0;
  flex: 1;
}

.order-record-drawer-item span,
.order-record-drawer-item small,
.order-record-drawer-item em {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-record-drawer-item small {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
}

.order-record-drawer-item em {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-style: normal;
}

.order-record-drawer-item strong {
  white-space: nowrap;
}

.order-status-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 24px;
  padding: 0;
  line-height: 24px;
  text-align: center;
}

.order-status-tag :deep(.el-tag__content) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
}

.batch-summary {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.batch-summary-main,
.batch-summary-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.order-record-drawer-row .batch-summary-tags {
  margin-top: 12px;
}

.copy-problem-links-button {
  width: 100%;
  margin-top: 12px;
}

.batch-summary-main {
  justify-content: space-between;
}

.batch-summary-main span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.record-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 120px;
  gap: 10px;
  margin-top: 20px;
  margin-bottom: 12px;
}

.status-select {
  width: 120px;
}

.removed-row {
  padding: 12px;
  border: 1px solid var(--el-color-danger-light-5);
  border-radius: 8px;
  background: color-mix(in srgb, var(--el-color-danger) 7%, var(--el-bg-color));
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.removed-row.success {
  border-color: var(--el-color-success-light-5);
  background: color-mix(in srgb, var(--el-color-success) 7%, var(--el-bg-color));
}

.removed-row.active {
  border-color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 12%, var(--el-bg-color));
}

.removed-row strong {
  display: block;
  overflow: hidden;
  margin-top: 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.removed-row em {
  display: block;
  margin-top: 6px;
  color: var(--el-color-danger);
  font-style: normal;
}

.removed-row em.success {
  color: var(--el-color-success);
}

.removed-row time {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.empty-records {
  padding: 32px 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.empty-records.compact {
  padding: 16px 12px;
}

.settlement-panel {
  align-self: start;
  padding: 0;
  overflow: hidden;
}

.settlement-panel h2 {
  padding: 22px 26px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.settlement-body {
  padding: 24px 26px;
}

.amount-main strong {
  display: block;
  margin-top: 8px;
  font-size: 32px;
}

.settlement-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 18px;
}

.settlement-grid strong,
.settlement-grid span {
  display: block;
}

.warning-box {
  gap: 8px;
  margin-top: 18px;
  padding: 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--el-color-warning) 14%, var(--el-bg-color));
  color: var(--el-color-warning);
}

.connection-summary {
  gap: 8px;
  margin: 0 26px 24px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.connection-summary.danger {
  color: var(--el-color-danger);
}

.connection-summary.success {
  color: var(--el-color-success);
}

@media (max-width: 1180px) {
  .order-layout {
    grid-template-columns: 1fr;
    gap: 16px;
  }
}

@media (max-width: 720px) {
  .batch-order-page {
    padding: 12px;
  }

  .panel {
    padding: 18px;
  }

  .connection-card,
  .panel-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .result-row {
    grid-template-columns: 1fr;
  }

  .removed-row {
    grid-template-columns: 1fr;
  }

  .record-filters {
    grid-template-columns: 1fr;
  }

  .status-select {
    width: 100%;
  }
}
</style>
