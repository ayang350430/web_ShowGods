<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, ref, watch } from 'vue';

import { createIconifyIcon } from '@vben/icons';

import {
  ElAlert,
  ElButton,
  ElCheckbox,
  ElDrawer,
  ElInput,
  ElMessage,
  ElMessageBox,
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
  getBatchOrdersApi,
  getProblemLinkRecordsApi,
  previewBatchOrderSilentApi,
  previewBatchOrderStreamApi,
  getOrderTypeStatusApi,
  saveProblemLinkRecordsApi,
  submitBatchOrderApi,
} from '#/api';

const vReveal = {
  mounted(el: HTMLElement) {
    el.classList.add('reveal-hidden');
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.classList.remove('reveal-hidden');
          el.classList.add('reveal-visible');
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
  },
};

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
const previewInputKey = ref('');
const previewing = ref(false);
const streamTotal = ref(0);
const streamResolved = ref(0);
const removedDrawerVisible = ref(false);
const orderRecords = ref<OrderApi.BatchOrderRecord[]>([]);
const orderRecordTotal = ref(0);
const batchOrdersCache = ref<Map<number, OrderApi.BatchOrderRecordItem[]>>(new Map());
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
const typeStatus = ref<OrderApi.OrderTypeStatus>();
const settlementLabels = {
  totalQuantity: '\u603b\u6570',
};

const parsedLines = computed(() =>
  content.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean),
);

const formatErrorCount = computed(() => {
  const lines = parsedLines.value;
  if (!lines.length) return 0;
  let errors = 0;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2 || !/^\d+$/.test(parts[parts.length - 1]!)) {
      errors++;
    }
  }
  return errors;
});

const typeDisabledMessage = computed(() => {
  if (!typeStatus.value) return '';
  const current = typeStatus.value[targetType.value];
  if (!current) return '';
  const label = { impression: '曝光', like: '点赞', view: '阅读' }[targetType.value];
  if (!current.global_enabled) return `${label}下单功能已被系统全局关闭，所有用户均无法提交${label}订单`;
  if (!current.user_enabled) return `${label}下单功能已被管理员对当前账号禁用`;
  return '';
});

function isTypeDisabled(type: 'impression' | 'like' | 'view') {
  if (!typeStatus.value) return false;
  const s = typeStatus.value[type];
  return !s.global_enabled || !s.user_enabled;
}

const canSubmit = computed(
  () =>
    Boolean(preview.value?.can_submit) &&
    agreePolicy.value &&
    connectionOk.value === true &&
    !typeDisabledMessage.value,
);

const invalidItemsSummary = computed(() => {
  const items = preview.value?.items ?? [];
  const invalidItems = items.filter((item) => !item.valid);
  if (!invalidItems.length) return null;
  const errorMap = new Map<string, { count: number; links: string[] }>();
  for (const item of invalidItems) {
    for (const err of item.errors) {
      const entry = errorMap.get(err) || { count: 0, links: [] };
      entry.count++;
      entry.links.push(item.raw || item.note_url || item.note_id || `#${item.line_no}`);
      errorMap.set(err, entry);
    }
  }
  return {
    count: invalidItems.length,
    groups: [...errorMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([reason, { count, links }]) => ({ count, links, reason })),
  };
});

const previewTotalQuantity = computed(() =>
  (preview.value?.items ?? [])
    .filter((item) => item.valid)
    .reduce((total, item) => total + Number(item.ordered_quantity || 0), 0),
);

const previewPriceText = computed(() => {
  const currentPreview = preview.value;
  if (!currentPreview) {
    return formatMoney(0, 4);
  }
  if (currentPreview.price_mode === 'quantity') {
    const baseQuantity = Math.max(Number(currentPreview.price_base_quantity) || 1, 1);
    return `${baseQuantity.toLocaleString('zh-CN')} \u4e2a / ${formatMoney(currentPreview.discounted_unit_price, 4)}`;
  }
  return formatMoney(currentPreview.discounted_unit_price, 4);
});

const currentInputKey = computed(() => `${targetType.value}::${content.value}`);

function getCurrentBatchContent() {
  const textareaValue = document.querySelector<HTMLTextAreaElement>('.batch-textarea')?.value;
  const value = textareaValue ?? content.value;
  if (value !== content.value) {
    content.value = value;
  }
  return value;
}

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
  const batchId = selectedOrderBatch.value?.id;
  const orders = (batchId ? batchOrdersCache.value.get(batchId) : undefined) ?? [];
  return orders.filter((order) => {
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

function formatMoney(value?: number, decimals = 2) {
  return `￥ ${(Number(value) || 0).toLocaleString('zh-CN', {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  })}`;
}

function formatMoneyParts(value?: number) {
  return {
    amount: (Number(value) || 0).toLocaleString('zh-CN', {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    }),
    symbol: '\u00a5',
  };
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
    refund_approved: '已退款',
    refund_calculating: '退款中',
    refund_rejected: '退款已拒绝',
    refund_requested: '退款中',
    stopping: '退款中',
  };
  return statusMap[status] || status || '-';
}

function isRefundedOrder(order: OrderApi.BatchOrderRecordItem) {
  return (
    order.order_status === 'refund_approved' ||
    Number(order.refund_amount || 0) > 0 ||
    Number((order as OrderApi.BatchOrderRecordItem & { refunded_quantity?: number })
      .refunded_quantity || 0) > 0
  );
}

function isRefundingOrder(order: OrderApi.BatchOrderRecordItem) {
  return ['refund_requested', 'refund_calculating', 'stopping'].includes(order.order_status);
}

function isRefundRejectedOrder(order: OrderApi.BatchOrderRecordItem) {
  return order.order_status === 'refund_rejected';
}

function hasRefundedOrder(record: OrderApi.BatchOrderRecord) {
  return (record.orders || []).some(isRefundedOrder);
}

function hasRefundingOrder(record: OrderApi.BatchOrderRecord) {
  return (record.orders || []).some(isRefundingOrder);
}

function hasRefundRejectedOrder(record: OrderApi.BatchOrderRecord) {
  return (record.orders || []).some(isRefundRejectedOrder);
}

function batchDisplayStatusLabel(record: OrderApi.BatchOrderRecord) {
  if (hasRefundedOrder(record)) {
    return '已退款';
  }
  if (hasRefundingOrder(record)) {
    return '退款中';
  }
  if (hasRefundRejectedOrder(record)) {
    return '退款已拒绝';
  }
  return orderRecordStatusLabel(record.status);
}

function orderDrawerStatusLabel(order: OrderApi.BatchOrderRecordItem) {
  if (isRefundedOrder(order)) {
    return '已退款';
  }
  if (isRefundingOrder(order)) {
    return '退款中';
  }
  if (isRefundRejectedOrder(order)) {
    return '退款已拒绝';
  }
  if (order.order_status === 'failed') {
    return '失败';
  }
  if (order.order_status === 'completed') {
    return '成功';
  }
  return '进行中';
}

function orderDrawerStatusTagType(order: OrderApi.BatchOrderRecordItem) {
  if (isRefundedOrder(order)) {
    return 'warning';
  }
  if (isRefundRejectedOrder(order) || order.order_status === 'failed') {
    return 'danger';
  }
  if (order.order_status === 'completed') {
    return 'success';
  }
  return 'warning';
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

async function copyAllProblemLinks() {
  const allInvalid = removedProblemLinks.value.filter((r) => !r.valid);
  if (allInvalid.length === 0) {
    ElMessage.warning('暂无问题链接可复制');
    return;
  }
  const unique = [...new Set(allInvalid.map((r) => r.raw))];
  const copyText = unique.join('\n');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(copyText);
    } else if (!copyTextWithFallback(copyText)) {
      throw new Error('Clipboard fallback failed');
    }
    ElMessage.success(`已复制 ${unique.length} 条问题链接`);
  } catch {
    if (copyTextWithFallback(copyText)) {
      ElMessage.success(`已复制 ${unique.length} 条问题链接`);
      return;
    }
    ElMessage.error('复制失败，浏览器未授权剪贴板');
  }
}

async function copyInvalidPreviewLinks() {
  const items = preview.value?.items ?? [];
  const invalidItems = items.filter((item) => !item.valid);
  if (invalidItems.length === 0) {
    ElMessage.warning('暂无问题链接可复制');
    return;
  }
  const links = [...new Set(invalidItems.map((item) => item.raw || item.note_url || item.note_id || '').filter(Boolean))];
  const copyText = links.join('\n');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(copyText);
    } else if (!copyTextWithFallback(copyText)) {
      throw new Error('Clipboard fallback failed');
    }
    ElMessage.success(`已复制 ${links.length} 条问题链接`);
  } catch {
    if (copyTextWithFallback(copyText)) {
      ElMessage.success(`已复制 ${links.length} 条问题链接`);
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
    batchOrdersCache.value.clear();
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
  const batchContent = getCurrentBatchContent();
  previewing.value = true;
  try {
    preview.value = await previewBatchOrderSilentApi({
      content: batchContent,
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
  removedDrawerVisible.value = true;
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
  // 先刷新类型开关状态
  await loadTypeStatus();
  if (typeDisabledMessage.value) {
    ElMessage.error(typeDisabledMessage.value);
    return;
  }
  const batchContent = getCurrentBatchContent();
  previewing.value = true;
  streamTotal.value = 0;
  streamResolved.value = 0;
  preview.value = {
    available_balance: 0,
    can_submit: false,
    check_batch_no: '',
    discount_rate: 0,
    discounted_unit_price: 0,
    invalid_count: 0,
    items: [],
    target_type: targetType.value,
    total_amount: 0,
    total_count: 0,
    unit_price: 0,
    valid_count: 0,
    warnings: [],
  } as OrderApi.BatchOrderPreview;
  try {
    const result = await previewBatchOrderStreamApi(
      { content: batchContent, target_type: targetType.value },
      {
        onStart: (info) => {
          streamTotal.value = info.total_count;
        },
        onItem: (item) => {
          streamResolved.value += 1;
          preview.value!.items.push(item);
        },
      },
    );
    preview.value = result;
    previewInputKey.value = currentInputKey.value;
    latestPreviewBatchNo.value = preview.value.check_batch_no;
    selectedCheckBatchNo.value = preview.value.check_batch_no;
    if (preview.value.invalid_count > 0 || preview.value.warnings.length > 0) {
      ElMessage.warning('预校验完成，请处理页面提示后再提交');
      return;
    }
    ElMessage.success('预校验通过');
  } catch (error: any) {
    console.error('[Batch Preview] error', error);
    ElMessage.error(error?.message || '预校验失败');
  } finally {
    previewing.value = false;
    streamTotal.value = 0;
    streamResolved.value = 0;
  }
}

async function submitOrder() {
  await loadTypeStatus();
  if (typeDisabledMessage.value) {
    ElMessage.error(typeDisabledMessage.value);
    return;
  }
  if (connectionOk.value !== true) {
    await checkConnection();
  }
  if (connectionOk.value !== true) {
    return;
  }

  const typeLabel = { impression: '曝光', like: '点赞', view: '阅读' }[targetType.value] || '';
  const confirmText = `确认下单${typeLabel}`;
  let userInput: { value: string } | undefined;
  try {
    userInput = await ElMessageBox.prompt(
      `即将提交 ${preview.value?.valid_count || 0} 条${typeLabel}订单，总计 ${(preview.value?.total_count || 0).toLocaleString('zh-CN')} 个，预计费用 ￥${(preview.value?.total_amount || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}。\n\n请输入「${confirmText}」以确认：`,
      '二次确认',
      {
        confirmButtonText: '确认提交',
        cancelButtonText: '取消',
        inputPattern: new RegExp(`^${confirmText}$`),
        inputErrorMessage: `请输入「${confirmText}」`,
        inputPlaceholder: confirmText,
        type: 'warning',
      },
    );
  } catch {
    return;
  }
  if (userInput?.value !== confirmText) return;

  submitting.value = true;
  try {
    const batchContent = getCurrentBatchContent();
    const result = await submitBatchOrderApi(
      {
        agree_policy: agreePolicy.value,
        content: batchContent,
        target_type: targetType.value,
      },
      { silent: true },
    );
    await loadOrderRecords(result.batch_no, { silent: true, skipStatusSync: true });
    ElMessage.success(`提交成功：${result.batch_no}`);
    content.value = '';
    preview.value = undefined;
    previewInputKey.value = '';
    agreePolicy.value = false;
    latestPreviewBatchNo.value = '';
  } finally {
    submitting.value = false;
  }
}

function clearContent() {
  content.value = '';
  preview.value = undefined;
  previewInputKey.value = '';
  agreePolicy.value = false;
}

watch(selectedOrderBatch, async (batch) => {
  if (!batch?.id || batchOrdersCache.value.has(batch.id)) return;
  try {
    const orders = await getBatchOrdersApi(batch.id, { silent: true });
    batchOrdersCache.value.set(batch.id, orders);
  } catch {
    batchOrdersCache.value.set(batch.id, []);
  }
}, { immediate: true });

watch(currentInputKey, (key) => {
  if (preview.value && previewInputKey.value && key !== previewInputKey.value) {
    preview.value = undefined;
    previewInputKey.value = '';
    latestPreviewBatchNo.value = '';
  }
});

async function loadTypeStatus() {
  try {
    typeStatus.value = await getOrderTypeStatusApi();
  } catch {
    // ignore
  }
}

onMounted(() => {
  checkConnection();
  loadTypeStatus();
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
            <ElRadioButton label="view">阅读<span v-if="isTypeDisabled('view')" class="type-off-dot" title="已关闭">●</span></ElRadioButton>
            <ElRadioButton label="like">点赞<span v-if="isTypeDisabled('like')" class="type-off-dot" title="已关闭">●</span></ElRadioButton>
            <ElRadioButton label="impression">曝光<span v-if="isTypeDisabled('impression')" class="type-off-dot" title="已关闭">●</span></ElRadioButton>
          </ElRadioGroup>
        </div>

        <ElAlert
          v-if="typeDisabledMessage"
          :title="typeDisabledMessage"
          type="error"
          show-icon
          :closable="false"
          class="type-disabled-alert"
        />

        <label class="field-label">
          批量内容（{{ { view: '阅读', like: '点赞', impression: '曝光' }[targetType] }}）
          <span>
            已输入 {{ parsedLines.length }} 行
            <span v-if="formatErrorCount > 0" style="color: var(--el-color-danger)">
              （{{ formatErrorCount }} 行格式有误，需要：链接 + 数量）
            </span>
          </span>
        </label>
        <textarea
          v-model="content"
          class="batch-textarea"
          placeholder="示例：https://xhslink.com/xxxxxx 100（仅阅读下单）"
        />

        <div class="actions">
          <ElButton :loading="previewing" @click="validateContent">
            {{ previewing && streamTotal > 0 ? `校验中 ${streamResolved}/${streamTotal}` : '手动预校验' }}
          </ElButton>
          <ElButton @click="fillExample">填充示例</ElButton>
          <ElButton :disabled="!preview?.invalid_count" @click="removeProblemLinks">
            一键删除问题链接并记录
          </ElButton>
          <ElButton @click="openOrderRecords">
            下单记录（{{ orderRecordTotal + checkBatchGroups.length }} 批）
          </ElButton>
          <ElButton @click="clearContent">清空</ElButton>
          <ElButton
            type="primary"
            :disabled="!canSubmit || submitting"
            :loading="submitting"
            @click="submitOrder"
          >
            {{ submitting ? '提交中...' : `确认提交${{ view: '阅读', like: '点赞', impression: '曝光' }[targetType]}` }}
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
          <span v-else-if="!preview">请先手动预校验</span>
          <span v-else-if="preview?.warnings.length">{{ preview.warnings[0] }}</span>
          <span v-else-if="!agreePolicy">请确认公告内容</span>
          <span v-else>校验通过，可以提交</span>
        </div>

        <div v-if="preview?.items.length" class="result-list">
          <div
            v-for="item in preview.items"
            v-reveal
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

      <div class="right-panels">
      <aside class="panel settlement-panel">
        <h2>结算与余额</h2>
        <div class="settlement-body">
          <div class="amount-main">
            <span>预计扣费</span>
            <strong class="amount-value">
              <span>{{ preview ? formatMoneyParts(preview.total_amount).symbol : '￥' }}</span>
              {{ preview ? formatMoneyParts(preview.total_amount).amount : '0.00' }}
            </strong>
            <small>
              {{ settlementLabels.totalQuantity }}
              {{ preview ? previewTotalQuantity.toLocaleString('zh-CN') : '0' }}
            </small>
          </div>
          <div class="settlement-grid">
            <div>
              <span>有效行</span>
              <strong>{{ preview ? preview.valid_count : 0 }}</strong>
            </div>
            <div>
              <span>失败行</span>
              <strong :class="{ red: preview && preview.invalid_count > 0 }">
                {{ preview ? preview.invalid_count : 0 }}
              </strong>
            </div>
            <div>
              <span>可用余额</span>
              <strong>{{ preview ? formatMoney(preview.available_balance) : formatMoney(0) }}</strong>
            </div>
            <div>
              <span>单价</span>
              <strong>{{ preview ? previewPriceText : '￥ 0.0000' }}</strong>
            </div>
          </div>
          <div v-if="preview && preview.warnings.length" class="warning-box">
            <component :is="AlertIcon" />
            <span>{{ preview.warnings.join('；') }}</span>
          </div>
        </div>

        <div class="connection-summary" :class="statusType">
          <component :is="connectionOk ? CheckIcon : InfoIcon" />
          <span>{{ connectionMessage }}</span>
        </div>
      </aside>

      <div v-if="invalidItemsSummary" class="invalid-panel">
        <div class="invalid-panel-head">
          <component :is="AlertIcon" />
          <strong>{{ invalidItemsSummary.count }} 条校验失败</strong>
          <ElButton
            size="small"
            type="warning"
            @click="copyInvalidPreviewLinks"
          >
            一键复制
          </ElButton>
        </div>
        <div v-for="(group, idx) in invalidItemsSummary.groups" :key="idx" class="invalid-group">
          <ElTag size="small" type="danger" effect="dark">
            {{ group.reason }}
          </ElTag>
          <span class="invalid-group-count">{{ group.count }} 条</span>
          <div class="invalid-group-links">
            <div
              v-for="(link, li) in group.links"
              :key="li"
              class="invalid-link-item"
            >
              <span class="invalid-link-no">{{ li + 1 }}</span>
              <span class="invalid-link-url">{{ link }}</span>
            </div>
          </div>
        </div>
        <div class="invalid-panel-tip">
          请修正问题链接或使用「一键删除问题链接并记录」移除后再提交
        </div>
      </div>
      </div>
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
          <ElButton
            v-if="removedProblemLinks.filter((r) => !r.valid).length > 0"
            size="small"
            type="warning"
            @click="copyAllProblemLinks"
          >
            一键复制所有问题链接
          </ElButton>
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
              {{ batchDisplayStatusLabel(selectedOrderBatch) }}
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
                refunded: isRefundedOrder(order),
                refunding: isRefundingOrder(order),
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
                :type="orderDrawerStatusTagType(order)"
              >
                {{ orderDrawerStatusLabel(order) }}
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
  padding: 24px;
  max-width: 1680px;
  margin: 0 auto;
  background:
    radial-gradient(circle at top left, color-mix(in srgb, var(--el-color-primary) 4%, transparent), transparent 30%),
    radial-gradient(circle at top right, color-mix(in srgb, var(--el-color-success) 3%, transparent), transparent 28%),
    linear-gradient(180deg, var(--el-fill-color-lighter), color-mix(in srgb, var(--el-bg-color) 92%, var(--el-fill-color-lighter)));
  color: var(--el-text-color-primary);
  position: relative;
}

.batch-order-page::before {
  content: '';
  position: fixed;
  inset: 0 auto auto 0;
  width: 100%;
  height: 4px;
  background: linear-gradient(90deg, var(--el-color-primary), color-mix(in srgb, var(--el-color-primary) 20%, var(--el-color-success)));
  opacity: 0.35;
  pointer-events: none;
}

.connection-card,
.panel {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 14px;
  background: var(--el-bg-color);
}

.connection-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
  padding: 18px 22px;
  box-shadow: 0 10px 30px rgb(15 23 42 / 4%);
  position: relative;
  overflow: hidden;
}

.connection-card::after {
  content: '';
  position: absolute;
  inset: auto 0 0 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--el-color-primary) 35%, transparent), transparent);
  opacity: 0.8;
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
  gap: 14px;
}

.connection-main svg,
.connection-summary svg,
.warning-box svg {
  width: 17px;
  height: 17px;
  padding: 7px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
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

.connection-main strong {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.connection-main span {
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1.4;
}

.button-icon {
  width: 15px;
  height: 15px;
  margin-right: 6px;
}

.order-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 396px;
  gap: 24px;
}

.panel {
  padding: 28px 30px;
  box-shadow: 0 12px 34px rgb(15 23 42 / 4%);
  position: relative;
  overflow: hidden;
}

.input-panel {
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--el-bg-color) 96%, var(--el-color-primary)), var(--el-bg-color) 28%),
    var(--el-bg-color);
}

.panel::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--el-color-primary) 70%, transparent), color-mix(in srgb, var(--el-color-success) 45%, transparent));
  opacity: 0.45;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.input-panel .panel-head {
  margin-bottom: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.type-disabled-alert {
  margin-bottom: 14px;
}

.type-off-dot {
  margin-left: 3px;
  color: var(--el-color-danger);
  font-size: 8px;
  vertical-align: super;
}

.panel h2 {
  margin: 0 0 10px;
  font-size: 17px;
  line-height: 1.25;
  letter-spacing: 0.01em;
  position: relative;
  padding-left: 12px;
}

.panel h2::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.2em;
  width: 3px;
  height: 0.9em;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--el-color-primary), color-mix(in srgb, var(--el-color-primary) 25%, var(--el-color-success)));
}

.panel p,
.field-label,
.result-row small,
.settlement-grid span,
.amount-main span {
  color: var(--el-text-color-secondary);
}

.panel p {
  font-size: 12px;
  line-height: 1.6;
}

.field-label {
  display: block;
  margin: 24px 0 10px;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.01em;
}

.field-label span {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-weight: 400;
}

.batch-textarea {
  width: 100%;
  min-height: 300px;
  padding: 18px 16px;
  resize: vertical;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  outline: none;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--el-fill-color-light) 82%, white), var(--el-bg-color));
  color: var(--el-text-color-primary);
  font-size: 14px;
  line-height: 1.7;
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  letter-spacing: 0.01em;
  font-variant-ligatures: none;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 60%);
}

.batch-textarea:focus {
  border-color: var(--el-color-primary);
  box-shadow:
    0 0 0 4px color-mix(in srgb, var(--el-color-primary) 10%, transparent),
    inset 0 1px 0 rgb(255 255 255 / 60%);
}

.actions {
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 16px;
}

.input-panel .actions {
  padding-top: 4px;
}

.actions :deep(.el-button) {
  border-radius: 999px;
  padding-inline: 16px;
  box-shadow: none;
}

.actions :deep(.el-button--primary) {
  background: linear-gradient(135deg, var(--el-color-primary), color-mix(in srgb, var(--el-color-primary) 78%, var(--el-color-success)));
  border-color: transparent;
}

.actions :deep(.el-button--primary:hover),
.actions :deep(.el-button--primary:focus-visible) {
  background: linear-gradient(135deg, color-mix(in srgb, var(--el-color-primary) 88%, white), color-mix(in srgb, var(--el-color-primary) 70%, var(--el-color-success)));
  border-color: transparent;
}

.actions :deep(.el-button--default),
.actions :deep(.el-button--info),
.actions :deep(.el-button--success),
.actions :deep(.el-button--warning),
.actions :deep(.el-button--danger) {
  min-height: 34px;
  font-weight: 600;
}

.risk-alert {
  margin: 18px 0 12px;
}

.submit-state {
  gap: 10px;
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  background: var(--el-fill-color-blank);
  font-size: 12px;
}

.submit-state :deep(.el-tag),
.drawer-title-tags :deep(.el-tag),
.batch-summary-tags :deep(.el-tag),
.invalid-panel :deep(.el-tag) {
  border-radius: 999px;
  border-color: color-mix(in srgb, currentColor 14%, var(--el-border-color-light));
  font-weight: 650;
  letter-spacing: 0.01em;
  box-shadow: none;
}

.drawer-title-tags :deep(.el-tag),
.batch-summary-tags :deep(.el-tag) {
  min-height: 26px;
  padding-inline: 10px;
}

.submit-state :deep(.el-tag) {
  min-height: 24px;
  padding-inline: 10px;
}

.invalid-panel {
  padding: 18px 18px 16px;
  border-radius: 14px;
  border: 1px solid var(--el-color-danger-light-5);
  background: var(--el-bg-color);
  box-shadow: 0 12px 32px rgb(15 23 42 / 6%);
  max-height: 420px;
  overflow-y: auto;
  position: relative;
}

.invalid-panel::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: linear-gradient(90deg, var(--el-color-danger), color-mix(in srgb, var(--el-color-danger) 30%, var(--el-color-warning)));
  opacity: 0.55;
}

.invalid-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  color: var(--el-color-danger);
  font-size: 13px;
}

.invalid-panel-head strong {
  font-weight: 600;
}

.invalid-group {
  margin-top: 16px;
}

.invalid-group :deep(.el-tag) {
  min-height: 24px;
  padding-inline: 10px;
}

.invalid-group-count {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.invalid-group-links {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.invalid-link-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
  font-size: 12px;
  line-height: 1.6;
}

.invalid-link-no {
  flex-shrink: 0;
  width: 20px;
  color: var(--el-text-color-placeholder);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.invalid-link-url {
  color: var(--el-text-color-regular);
  font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  word-break: break-all;
}

.invalid-panel-tip {
  margin-top: 16px;
  padding: 8px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--el-color-warning) 10%, transparent);
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.reveal-hidden {
  opacity: 0;
  transform: translateY(24px);
}

.reveal-visible {
  animation: reveal-in 0.6s ease-out forwards;
}

@keyframes reveal-in {
  from {
    opacity: 0;
    transform: translateY(24px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.result-list {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  max-height: 520px;
  overflow-y: auto;
  padding-right: 4px;
}

.result-row {
  grid-template-columns: 50px 44px minmax(0, 1fr) 88px 176px;
  display: grid;
  gap: 12px;
  padding: 13px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
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
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
  font-size: 10px;
  font-weight: 700;
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
  margin-bottom: 18px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.batch-select {
  min-width: 0;
  flex: 1;
}

.order-record-drawer-list {
  display: grid;
  gap: 16px;
}

.order-record-drawer-row {
  padding: 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
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
  margin-top: 12px;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1.6;
}

.order-record-drawer-items {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}

.order-record-drawer-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(40px, auto) minmax(64px, auto);
  align-items: center;
  width: 100%;
  box-sizing: border-box;
  padding: 12px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
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

.order-record-drawer-item.refunded,
.order-record-drawer-item.refunding {
  border-color: var(--el-color-warning-light-5);
  background: color-mix(in srgb, var(--el-color-warning) 12%, var(--el-bg-color));
}

.order-record-drawer-item > div {
  min-width: 0;
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
  min-width: 0;
  justify-self: end;
  white-space: nowrap;
}

.order-status-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  justify-self: end;
  min-width: 64px;
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
  margin-bottom: 16px;
  padding: 13px 14px;
  border-radius: 12px;
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
  padding: 40px 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.empty-records.compact {
  padding: 16px 12px;
}

.right-panels {
  display: flex;
  flex-direction: column;
  gap: 20px;
  align-self: start;
  position: sticky;
  top: 80px;
}

.settlement-panel {
  align-self: start;
  width: 100%;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  box-shadow: 0 10px 28px rgb(15 23 42 / 6%);
  border: 1px solid transparent;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--el-bg-color) 94%, var(--el-color-success)), var(--el-bg-color) 36%) padding-box,
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--el-color-primary) 72%, white),
      color-mix(in srgb, var(--el-color-success) 68%, white),
      color-mix(in srgb, var(--el-color-primary) 72%, white)
    ) border-box;
  background-repeat: no-repeat;
  background-size: auto, 240% 100%;
  background-position: 0 0, 0% 50%;
  animation: settlement-border-flow 7s linear infinite;
}

.settlement-panel h2 {
  padding: 22px 24px 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.settlement-panel h2::before {
  display: none;
}

.settlement-body {
  padding: 24px 24px 26px;
}

.amount-main {
  position: relative;
  padding: 22px 20px 18px;
  border: 1px solid color-mix(in srgb, var(--el-color-primary) 10%, var(--el-border-color-light));
  border-radius: 14px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--el-color-primary) 5%, transparent), transparent 58%),
    var(--el-fill-color-blank);
}

.amount-main::after {
  content: '';
  position: absolute;
  inset: auto 20px 15px 20px;
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--el-color-primary) 25%, transparent), transparent);
  opacity: 0.6;
}

.amount-main span {
  color: var(--el-text-color-secondary);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.amount-main strong {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 10px;
  color: var(--el-text-color-primary);
  font-size: 33px;
  line-height: 1;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}

.amount-main strong span {
  color: inherit;
  font-size: 25px;
  font-weight: 900;
}

.amount-main small {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 14px;
  padding: 4px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--el-color-primary) 8%, var(--el-fill-color-light));
  color: var(--el-color-primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.settlement-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}

.settlement-grid > div {
  min-width: 0;
  min-height: 70px;
  padding: 13px 14px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 14px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--el-fill-color-lighter) 90%, white), var(--el-fill-color-lighter));
}

.settlement-grid > div:first-child {
  background: linear-gradient(180deg, color-mix(in srgb, var(--el-color-success) 6%, var(--el-fill-color-lighter)), var(--el-fill-color-lighter));
}

.settlement-grid > div:nth-child(2) {
  background: linear-gradient(180deg, color-mix(in srgb, var(--el-color-danger) 6%, var(--el-fill-color-lighter)), var(--el-fill-color-lighter));
}

.settlement-grid > div:nth-child(3) {
  background: linear-gradient(180deg, color-mix(in srgb, var(--el-color-primary) 5%, var(--el-fill-color-lighter)), var(--el-fill-color-lighter));
}

.settlement-grid > div:nth-child(4) {
  background: linear-gradient(180deg, color-mix(in srgb, var(--el-color-warning) 5%, var(--el-fill-color-lighter)), var(--el-fill-color-lighter));
}

.settlement-grid strong,
.settlement-grid span {
  display: block;
}

.settlement-grid span {
  color: var(--el-text-color-secondary);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.settlement-grid strong {
  overflow-wrap: anywhere;
  margin-top: 5px;
  color: var(--el-text-color-primary);
  font-size: 14px;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}

.settlement-grid strong.red {
  color: var(--el-color-danger);
}

.warning-box {
  gap: 6px;
  margin-top: 14px;
  padding: 9px 11px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--el-color-warning) 7%, var(--el-bg-color));
  color: var(--el-color-warning);
  border: 1px solid color-mix(in srgb, var(--el-color-warning) 14%, var(--el-border-color-lighter));
  font-size: 12px;
  line-height: 1.45;
}

.connection-summary {
  gap: 6px;
  margin: 0 24px 24px;
  padding: 9px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--el-bg-color) 96%, currentColor);
  border: 1px solid color-mix(in srgb, currentColor 12%, var(--el-border-color-lighter));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 60%);
}

.connection-summary svg {
  color: currentColor;
}

.connection-summary span {
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.connection-summary.danger {
  color: var(--el-color-danger);
}

.connection-summary.success {
  color: var(--el-color-success);
}

@keyframes settlement-border-flow {
  0% {
    background-position: 0 0, 0% 50%;
  }

  50% {
    background-position: 0 0, 100% 50%;
  }

  100% {
    background-position: 0 0, 0% 50%;
  }
}

@media (max-width: 1180px) {
  .order-layout {
    grid-template-columns: 1fr;
    gap: 16px;
  }

  .right-panels {
    position: static;
  }
}

@media (max-width: 720px) {
  .batch-order-page {
    padding: 12px;
  }

  .panel {
    padding: 18px 16px;
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

  .order-record-drawer-item {
    grid-template-columns: minmax(0, 1fr) minmax(40px, auto);
  }

  .order-status-tag {
    grid-column: 1 / -1;
    justify-self: start;
  }
}
</style>
