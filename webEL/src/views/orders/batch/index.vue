<script setup lang="ts">
import type { OrderApi } from '#/api';

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { createIconifyIcon } from '@vben/icons';

import {
  ElButton,
  ElCheckbox,
  ElDrawer,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElTag,
} from 'element-plus';

import { useUserStore } from '@vben/stores';

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

const userStore = useUserStore();
const isAdmin = computed(() =>
  (userStore.userInfo?.roles ?? []).some((role: any) =>
    ['admin', 'super'].includes(typeof role === 'string' ? role : role?.value),
  ),
);

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
const EyeIcon = createIconifyIcon('lucide:eye');
const HeartIcon = createIconifyIcon('lucide:heart');
const InfoIcon = createIconifyIcon('lucide:info');
const LinkIcon = createIconifyIcon('lucide:link');
const RefreshIcon = createIconifyIcon('lucide:refresh-cw');
const SparklesIcon = createIconifyIcon('lucide:sparkles');
const ClipboardIcon = createIconifyIcon('lucide:clipboard-list');
const CopyIcon = createIconifyIcon('lucide:copy');
const SearchIcon = createIconifyIcon('lucide:search');

const typeOptions = [
  { label: '阅读', value: 'view' as const, icon: EyeIcon },
  { label: '点赞', value: 'like' as const, icon: HeartIcon },
  { label: '曝光', value: 'impression' as const, icon: SparklesIcon },
];

const typeLabelMap = { view: '阅读', like: '点赞', impression: '曝光' };

const WalletIcon = createIconifyIcon('lucide:wallet');
const ListIcon = createIconifyIcon('lucide:list-checks');

const submitHint = computed(() => {
  if (isAdmin.value) return '管理员账号不允许下单';
  if (connectionOk.value === false) return '连接异常，请先恢复后端服务';
  if (!content.value) return '请先输入批量内容';
  if (!preview.value) return '请先手动预校验';
  if (preview.value.warnings.length) return preview.value.warnings[0]!;
  if (!agreePolicy.value) return '请确认公告内容';
  if (canSubmit.value) return '校验通过，可以提交';
  return '当前不可提交';
});

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
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024);
const drawerSize = computed(() => (windowWidth.value <= 768 ? '100%' : '760px'));

function handleWindowResize() {
  windowWidth.value = window.innerWidth;
}
const orderRecords = ref<OrderApi.BatchOrderRecord[]>([]);
const orderRecordTotal = ref(0);
const batchOrdersCache = ref<Map<number, OrderApi.BatchOrderRecordItem[]>>(new Map());
const selectedDrawerBatchKey = ref('');
const orderDrawerKeyword = ref('');
const drawerBatchKeyword = ref('');
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
    !isAdmin.value &&
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
    label: `${record.batch_no} · ${formatShortDateTime(record.submitted_at || record.created_at)}`,
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
    label: `${group.batchNo} · ${formatShortDateTime(group.time)}`,
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

function formatShortDateTime(value?: string) {
  const full = formatDateTime(value);
  if (full === '-') return full;
  return full.slice(5, 16).replace(' ', ' · ');
}

function shortenBatchNo(batchNo: string) {
  if (batchNo.length <= 18) return batchNo;
  return `${batchNo.slice(0, 10)}…${batchNo.slice(-6)}`;
}

function drawerBatchStatus(batch: (typeof drawerBatches.value)[number]) {
  if (batch.type === 'order') {
    return {
      class: batchStatusPillClass(batch.record),
      label: batchDisplayStatusLabel(batch.record),
    };
  }
  return { class: 'pill--warning', label: '问题' };
}

const filteredDrawerBatches = computed(() => {
  const keyword = drawerBatchKeyword.value.trim().toLowerCase();
  if (!keyword) return drawerBatches.value;
  return drawerBatches.value.filter((batch) =>
    [batch.batchNo, batch.label, batch.type === 'order' ? batch.record.status : '']
      .join(' ')
      .toLowerCase()
      .includes(keyword),
  );
});
const drawerHero = computed(() => {
  const batch = selectedDrawerBatch.value;
  if (!batch) return null;

  if (batch.type === 'order') {
    return {
      amount: formatMoney(batch.amount),
      batchNo: batch.batchNo,
      failedCount: batch.failedCount,
      failedLabel: '失败',
      statusClass: batchStatusPillClass(batch.record),
      statusLabel: batchDisplayStatusLabel(batch.record),
      successCount: batch.successCount,
      successLabel: '成功',
      time: formatDateTime(batch.record.submitted_at || batch.record.created_at),
      total: batch.total,
      type: 'order' as const,
      typeLabel: '确认提交',
    };
  }

  return {
    amount: formatMoney(batch.amount),
    batchNo: batch.batchNo,
    failedCount: batch.failedCount,
    failedLabel: '放弃',
    statusClass: 'pill--danger',
    statusLabel: '问题批次',
    successCount: batch.successCount,
    successLabel: '通过',
    time: formatDateTime(batch.time),
    total: batch.total,
    type: 'problem' as const,
    typeLabel: '问题链接',
  };
});

const drawerListItems = computed(() => {
  if (selectedOrderBatch.value) {
    return visibleOrderDrawerItems.value.map((order) => ({
      id: order.id,
      avatar: order.avatar_url || '',
      author: order.author_name || '',
      link: order.source_note_url || order.note_url || '',
      linkRaw: false,
      noteId: order.note_id || '',
      noteTitle: order.title || '',
      qty: order.ordered_quantity,
      rowClass: [
        order.order_status === 'failed' ? 'is-failed' : '',
        isRefundedOrder(order) ? 'is-refunded' : '',
        isRefundingOrder(order) ? 'is-refunding' : '',
        order.order_status === 'completed' ? 'is-success' : '',
      ].filter(Boolean).join(' '),
      statusClass: orderDrawerStatusPillClass(order),
      statusLabel: orderDrawerStatusLabel(order),
      subtitle: order.author_name ? `${order.author_name} · ID ${order.id}` : `订单 ID ${order.id}`,
      title: order.order_no,
    }));
  }

  if (selectedProblemBatch.value) {
    return visibleProblemDrawerItems.value.map((record) => ({
      id: record.id,
      avatar: record.avatar_url || '',
      link: record.raw,
      linkRaw: true,
      noteId: record.note_id || '',
      noteTitle: record.title || record.note_id || '',
      qty: record.ordered_quantity,
      rowClass: record.valid ? 'is-success' : 'is-failed',
      statusClass: record.valid ? 'pill--success' : 'pill--danger',
      statusLabel: record.valid ? '成功' : '放弃',
      subtitle: record.author_name || '',
      title: record.raw,
    }));
  }

  return [];
});

const drawerStatusTabs = [
  { label: '全部', value: 'all' as const },
  { label: '成功', value: 'success' as const },
  { label: '失败', value: 'failed' as const },
];

const drawerFailedTabLabel = computed(() =>
  selectedProblemBatch.value ? '放弃' : '失败',
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
    refunded: '已退款',
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

function orderDrawerStatusPillClass(order: OrderApi.BatchOrderRecordItem) {
  if (isRefundedOrder(order)) return 'pill--warning';
  if (isRefundRejectedOrder(order) || order.order_status === 'failed') return 'pill--danger';
  if (order.order_status === 'completed') return 'pill--success';
  return 'pill--info';
}

function batchStatusPillClass(record: OrderApi.BatchOrderRecord) {
  if (hasRefundedOrder(record)) return 'pill--warning';
  if (hasRefundingOrder(record)) return 'pill--warning';
  if (hasRefundRejectedOrder(record)) return 'pill--danger';
  if (record.status === 'completed') return 'pill--success';
  if (record.status === 'failed') return 'pill--danger';
  return 'pill--info';
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
  drawerBatchKeyword.value = '';
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
  if (isAdmin.value) {
    ElMessage.error('管理员账号不允许下单');
    return;
  }
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
  if (isAdmin.value) {
    ElMessage.error('管理员账号不允许下单');
    return;
  }
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

watch(targetType, () => {
  if (content.value.trim() && !isAdmin.value) {
    validateContent();
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
  window.addEventListener('resize', handleWindowResize, { passive: true });
  checkConnection();
  loadTypeStatus();
  loadOrderRecords();
  loadProblemLinkRecords();
});

onUnmounted(() => {
  window.removeEventListener('resize', handleWindowResize);
});
</script>

<template>
  <div class="batch-order-page">
    <section class="page-head">
      <div class="head-text">
        <span class="eyebrow">Batch Order</span>
        <h1>批量下单</h1>
        <p>当前类型：{{ typeLabelMap[targetType] }} · 每行一条链接 + 数量，空格或 Tab 分隔</p>
      </div>
      <div class="head-actions">
        <div class="type-switcher">
          <button
            v-for="opt in typeOptions"
            :key="opt.value"
            type="button"
            class="type-pill"
            :class="{
              active: targetType === opt.value,
              disabled: isTypeDisabled(opt.value),
            }"
            @click="targetType = opt.value"
          >
            <component :is="opt.icon" class="type-pill-icon" />
            {{ opt.label }}
            <span v-if="isTypeDisabled(opt.value)" class="type-off-badge">关</span>
          </button>
        </div>
        <button
          type="button"
          class="head-btn head-btn--ghost"
          :class="statusType"
          :disabled="checkingConnection"
          @click="checkConnection(true)"
        >
          <component :is="checkingConnection ? RefreshIcon : (connectionOk ? CheckIcon : LinkIcon)" />
          {{ connectionMessage }}
        </button>
        <button type="button" class="head-btn" @click="openOrderRecords">
          下单记录
          <span class="head-badge">{{ orderRecordTotal + checkBatchGroups.length }}</span>
        </button>
      </div>
    </section>

    <section class="summary-grid">
      <div class="stat-card stat-card--primary">
        <div class="stat-icon">
          <component :is="WalletIcon" />
        </div>
        <div class="stat-body">
          <span>预计扣费</span>
          <strong>{{ preview ? formatMoneyParts(preview.total_amount).symbol : '￥' }}{{ preview ? formatMoneyParts(preview.total_amount).amount : '0.00' }}</strong>
          <em>{{ settlementLabels.totalQuantity }} {{ preview ? previewTotalQuantity.toLocaleString('zh-CN') : '0' }}</em>
        </div>
      </div>
      <div class="stat-card stat-card--success">
        <div class="stat-icon">
          <component :is="CheckIcon" />
        </div>
        <div class="stat-body">
          <span>有效行</span>
          <strong>{{ preview ? preview.valid_count : 0 }}</strong>
        </div>
      </div>
      <div class="stat-card stat-card--danger">
        <div class="stat-icon">
          <component :is="AlertIcon" />
        </div>
        <div class="stat-body">
          <span>失败行</span>
          <strong :class="{ 'text-danger': preview && preview.invalid_count > 0 }">
            {{ preview ? preview.invalid_count : 0 }}
          </strong>
        </div>
      </div>
      <div class="stat-card stat-card--warning">
        <div class="stat-icon">
          <component :is="ListIcon" />
        </div>
        <div class="stat-body">
          <span>可用余额</span>
          <strong>{{ preview ? formatMoney(preview.available_balance) : formatMoney(0) }}</strong>
          <em>单价 {{ preview ? previewPriceText : '￥ 0.0000' }}</em>
        </div>
      </div>
    </section>

    <div
      v-if="isAdmin || typeDisabledMessage"
      class="alert-strip alert-strip--error"
    >
      <component :is="AlertIcon" />
      <span>{{ isAdmin ? '管理员账号不允许下单，请使用普通账号操作' : typeDisabledMessage }}</span>
    </div>

    <section class="workspace">
      <div class="workspace-head">
        <h2>批量内容</h2>
        <div class="workspace-meta">
          <span class="meta-tag">{{ parsedLines.length }} 行</span>
          <span v-if="formatErrorCount > 0" class="meta-tag meta-tag--danger">
            {{ formatErrorCount }} 行格式有误
          </span>
        </div>
      </div>

      <textarea
        v-model="content"
        class="batch-textarea"
        :disabled="isAdmin"
        placeholder="https://xhslink.com/xxxxxx 100&#10;https://www.xiaohongshu.com/explore/xxxx 200"
      />

      <div class="toolbar">
        <ElButton
          :disabled="isAdmin"
          :loading="previewing"
          type="primary"
          @click="validateContent"
        >
          {{ previewing && streamTotal > 0 ? `校验中 ${streamResolved}/${streamTotal}` : '手动预校验' }}
        </ElButton>
        <ElButton :disabled="isAdmin" @click="fillExample">填充示例</ElButton>
        <ElButton
          :disabled="isAdmin || !preview?.invalid_count"
          type="warning"
          plain
          @click="removeProblemLinks"
        >
          删除问题链接
        </ElButton>
        <ElButton :disabled="isAdmin" text @click="clearContent">清空</ElButton>
      </div>

      <div class="submit-bar">
        <div class="policy-block">
          <p class="policy-text">
            <component :is="InfoIcon" />
            有封控风险，价格上涨，下单前请自行核对价格
          </p>
          <ElCheckbox v-model="agreePolicy">
            我已阅读并确认上述公告
          </ElCheckbox>
        </div>
        <div class="submit-block">
          <span
            class="submit-hint"
            :class="{ ready: canSubmit, danger: !canSubmit && (isAdmin || connectionOk === false) }"
          >
            {{ submitHint }}
          </span>
          <ElButton
            class="submit-btn"
            type="primary"
            size="large"
            :disabled="!canSubmit || submitting"
            :loading="submitting"
            @click="submitOrder"
          >
            {{ submitting ? '提交中...' : `确认提交${typeLabelMap[targetType]}` }}
          </ElButton>
        </div>
      </div>
    </section>

    <section v-if="preview && preview.warnings.length" class="alert-strip alert-strip--warning">
      <component :is="AlertIcon" />
      <span>{{ preview.warnings.join('；') }}</span>
    </section>

    <section v-if="invalidItemsSummary" class="invalid-panel">
      <div class="invalid-panel-head">
        <component :is="AlertIcon" />
        <strong>{{ invalidItemsSummary.count }} 条校验失败</strong>
        <ElButton size="small" type="warning" plain @click="copyInvalidPreviewLinks">
          一键复制
        </ElButton>
      </div>
      <div v-for="(group, idx) in invalidItemsSummary.groups" :key="idx" class="invalid-group">
        <ElTag size="small" type="danger">{{ group.reason }}</ElTag>
        <span class="invalid-group-count">{{ group.count }} 条</span>
        <div class="invalid-group-links">
          <div v-for="(link, li) in group.links" :key="li" class="invalid-link-item">
            <span class="invalid-link-no">{{ li + 1 }}</span>
            <span class="invalid-link-url">{{ link }}</span>
          </div>
        </div>
      </div>
      <p class="invalid-panel-tip">
        请修正问题链接或使用「删除问题链接」移除后再提交
      </p>
    </section>

    <section v-if="preview?.items.length" class="preview-card">
      <div class="preview-head">
        <h3>校验结果</h3>
        <span>{{ preview.valid_count }} 有效 / {{ preview.invalid_count }} 失败</span>
      </div>
      <div class="result-list">
        <div
          v-for="item in preview.items"
          v-reveal
          :key="item.line_no"
          class="result-row"
          :class="{ invalid: !item.valid }"
        >
          <span class="row-no">#{{ item.line_no }}</span>
          <div class="note-avatar">
            <img v-if="item.avatar_url" :src="item.avatar_url" alt="" referrerpolicy="no-referrer" />
            <span v-else>{{ (item.author_name || item.note_id || 'ID').slice(0, 1).toUpperCase() }}</span>
          </div>
          <div class="note-info">
            <strong>
              {{ item.title || item.note_id || '未解析到笔记ID' }}
              <small v-if="item.cache_hit">缓存</small>
            </strong>
            <span v-if="item.author_name">{{ item.author_name }} / {{ item.note_id }}</span>
            <a v-if="item.note_url" :href="item.note_url" target="_blank">{{ item.note_url }}</a>
          </div>
          <em class="row-qty">{{ item.ordered_quantity.toLocaleString('zh-CN') }}</em>
          <small class="row-amount">
            {{ item.valid ? formatMoney(item.payable_amount) : item.errors.join('、') }}
          </small>
        </div>
      </div>
    </section>

    <ElDrawer
      v-model="removedDrawerVisible"
      append-to-body
      class="order-records-drawer"
      direction="rtl"
      :size="drawerSize"
      :body-style="{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }"
    >
      <template #header>
        <div class="dr-header">
          <h3>下单记录</h3>
          <span v-if="drawerBatches.length" class="dr-header-count">{{ drawerBatches.length }} 批</span>
        </div>
      </template>

      <div v-if="drawerBatches.length" class="dr-root">
        <div class="dr-shell">
        <aside class="dr-sidebar">
          <ElInput
            v-model="drawerBatchKeyword"
            clearable
            size="small"
            placeholder="搜索批次"
            :prefix-icon="SearchIcon"
          />
          <div class="dr-batch-list">
            <button
              v-for="batch in filteredDrawerBatches"
              :key="batch.key"
              type="button"
              class="dr-batch-item"
              :class="{
                active: selectedDrawerBatchKey === batch.key,
                'dr-batch-item--problem': batch.type === 'problem',
              }"
              @click="selectedDrawerBatchKey = batch.key"
            >
              <div class="dr-batch-item-row">
                <span class="dr-batch-kind">{{ batch.type === 'order' ? '提交' : '问题' }}</span>
                <span class="dr-badge" :class="drawerBatchStatus(batch).class">
                  {{ drawerBatchStatus(batch).label }}
                </span>
              </div>
              <strong class="dr-batch-no">{{ shortenBatchNo(batch.batchNo) }}</strong>
              <div class="dr-batch-item-row dr-batch-item-meta">
                <span>{{ formatShortDateTime(batch.time) }}</span>
                <span>{{ formatMoney(batch.amount) }}</span>
              </div>
              <div class="dr-batch-counts">
                <span class="ok">{{ batch.successCount }} 成</span>
                <span class="bad">{{ batch.failedCount }} 败</span>
                <span class="total">共 {{ batch.total }}</span>
              </div>
            </button>
            <div v-if="filteredDrawerBatches.length === 0" class="dr-sidebar-empty">
              无匹配批次
            </div>
          </div>
        </aside>

        <section v-if="drawerHero" class="dr-main">
          <div class="dr-main-head">
            <div class="dr-main-title">
              <code>{{ drawerHero.batchNo }}</code>
              <div class="dr-main-tags">
                <span class="dr-badge" :class="drawerHero.statusClass">{{ drawerHero.statusLabel }}</span>
                <span class="dr-main-amount">{{ drawerHero.amount }}</span>
              </div>
            </div>
            <div class="dr-main-actions">
              <ElButton
                v-if="selectedProblemBatch"
                size="small"
                plain
                type="primary"
                @click="copySelectedProblemBatchLinks"
              >
                <component :is="CopyIcon" class="button-icon" />
                复制
              </ElButton>
              <ElButton
                v-else-if="removedProblemLinks.filter((r) => !r.valid).length > 0"
                size="small"
                plain
                type="warning"
                @click="copyAllProblemLinks"
              >
                复制问题链接
              </ElButton>
            </div>
          </div>

          <div class="dr-main-stats">
            <span>{{ drawerHero.time }}</span>
            <span>{{ drawerHero.total }} 单</span>
            <span class="ok">{{ drawerHero.successLabel }} {{ drawerHero.successCount }}</span>
            <span class="bad">{{ drawerHero.failedLabel }} {{ drawerHero.failedCount }}</span>
          </div>

          <div class="dr-main-toolbar">
            <ElInput
              v-model="orderDrawerKeyword"
              clearable
              size="small"
              :placeholder="selectedProblemBatch ? '搜索链接、标题' : '搜索订单、链接'"
              :prefix-icon="SearchIcon"
            />
            <div class="dr-tabs">
              <button
                v-for="tab in drawerStatusTabs"
                :key="tab.value"
                type="button"
                class="dr-tab"
                :class="{ active: orderDrawerStatus === tab.value }"
                @click="orderDrawerStatus = tab.value"
              >
                {{ tab.value === 'failed' ? drawerFailedTabLabel : tab.label }}
              </button>
            </div>
          </div>

          <div class="dr-list">
            <article
              v-for="item in drawerListItems"
              :key="item.id"
              class="dr-order"
              :class="item.rowClass"
            >
              <div class="dr-order-avatar">
                <img
                  v-if="item.avatar"
                  :src="item.avatar"
                  alt=""
                  referrerpolicy="no-referrer"
                />
                <span v-else>{{ (item.author || item.noteId || item.title || '单').slice(0, 1).toUpperCase() }}</span>
              </div>
              <div class="dr-order-body">
                <div class="dr-order-top">
                  <strong>{{ item.noteTitle || item.title || item.subtitle || '未命名订单' }}</strong>
                  <div class="dr-order-side">
                    <em>{{ item.qty.toLocaleString('zh-CN') }}</em>
                    <span class="dr-badge" :class="item.statusClass">{{ item.statusLabel }}</span>
                  </div>
                </div>
                <p v-if="item.noteTitle" class="dr-order-sub">{{ item.title }}</p>
                <p v-else-if="item.subtitle" class="dr-order-sub">{{ item.subtitle }}</p>
                <a
                  v-if="item.link && !item.linkRaw"
                  class="dr-order-link"
                  :href="item.link"
                  target="_blank"
                >
                  {{ item.link }}
                </a>
                <p v-else-if="item.link" class="dr-order-link dr-order-link--raw">{{ item.link }}</p>
              </div>
            </article>
            <div v-if="drawerListItems.length === 0" class="dr-list-empty">
              <component :is="ClipboardIcon" class="dr-list-empty-icon" />
              <p>暂无匹配记录</p>
            </div>
          </div>
        </section>

        <section v-else class="dr-main dr-main--empty">
          <p>请选择左侧批次查看详情</p>
        </section>
        </div>
      </div>

      <div v-else class="dr-empty">
        <component :is="ClipboardIcon" class="dr-empty-icon" />
        <p>暂无下单记录</p>
      </div>
    </ElDrawer>
  </div>
</template>

<style scoped>
.batch-order-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 20px;
  color: var(--el-text-color-primary);
}

.eyebrow {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--el-color-primary);
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

.page-head h1 { margin: 2px 0 0; font-size: 22px; font-weight: 700; }
.page-head p { margin: 4px 0 0; font-size: 13px; color: var(--el-text-color-secondary); }

.head-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  flex-shrink: 0;
}

.head-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 8px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.head-btn svg { width: 14px; height: 14px; }

.head-btn:hover:not(:disabled) {
  background: var(--el-color-primary);
  color: #fff;
}

.head-btn:disabled { opacity: 0.55; cursor: not-allowed; }

.head-btn--ghost {
  background: var(--el-bg-color);
  border-color: var(--el-border-color);
  color: var(--el-text-color-secondary);
}

.head-btn--ghost.success {
  border-color: var(--el-color-success-light-5);
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.head-btn--ghost.danger {
  border-color: var(--el-color-danger-light-5);
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.head-btn--ghost.warning { color: var(--el-color-warning); }

.head-badge {
  margin-left: 2px;
  padding: 1px 7px;
  border-radius: 10px;
  background: rgb(255 255 255 / 70%);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.type-switcher {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
}

.type-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.type-pill-icon { width: 14px; height: 14px; opacity: 0.75; }
.type-pill:hover:not(.disabled) { color: var(--el-text-color-primary); }
.type-pill.active {
  background: var(--el-bg-color);
  color: var(--el-color-primary);
  box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
}
.type-pill.disabled { opacity: 0.5; cursor: not-allowed; }

.type-off-badge {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--el-color-danger-light-8);
  color: var(--el-color-danger);
  font-size: 10px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
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
  transition: box-shadow 0.2s;
}

.stat-card:hover { box-shadow: 0 2px 12px rgb(0 0 0 / 6%); }

.stat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 10px;
  flex-shrink: 0;
}

.stat-icon svg { width: 18px; height: 18px; }

.stat-card--primary .stat-icon { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }
.stat-card--success .stat-icon { background: var(--el-color-success-light-8); color: var(--el-color-success); }
.stat-card--danger .stat-icon { background: var(--el-color-danger-light-8); color: var(--el-color-danger); }
.stat-card--warning .stat-icon { background: var(--el-color-warning-light-8); color: var(--el-color-warning); }

.stat-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.stat-body span { font-size: 12px; color: var(--el-text-color-secondary); }
.stat-body strong { font-size: 20px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.stat-body em { font-size: 11px; color: var(--el-text-color-secondary); font-style: normal; overflow-wrap: anywhere; }
.stat-body .text-danger { color: var(--el-color-danger); }

.alert-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
}

.alert-strip svg { width: 16px; height: 16px; flex-shrink: 0; }

.alert-strip--error {
  border: 1px solid var(--el-color-danger-light-5);
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.alert-strip--warning {
  border: 1px solid var(--el-color-warning-light-5);
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.workspace,
.preview-card,
.invalid-panel {
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.workspace { padding: 20px 24px 24px; }

.workspace-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.workspace-head h2 { margin: 0; font-size: 16px; font-weight: 600; }

.workspace-meta { display: flex; gap: 8px; }

.meta-tag {
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.meta-tag--danger {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.batch-textarea {
  width: 100%;
  min-height: 260px;
  padding: 14px 16px;
  resize: vertical;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  outline: none;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-primary);
  font-size: 13px;
  line-height: 1.75;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.batch-textarea:focus {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 3px var(--el-color-primary-light-8);
}

.batch-textarea:disabled {
  background: var(--el-fill-color-light);
  cursor: not-allowed;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.submit-bar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-top: 20px;
  padding: 16px 18px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
}

.policy-block { flex: 1; min-width: 0; }

.policy-text {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 10px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.policy-text svg { width: 15px; height: 15px; color: var(--el-color-primary); flex-shrink: 0; }

.submit-block {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

.submit-hint { font-size: 12px; color: var(--el-text-color-secondary); }
.submit-hint.ready { color: var(--el-color-success); }
.submit-hint.danger { color: var(--el-color-danger); }

.submit-btn { min-width: 160px; border-radius: 8px !important; font-weight: 600; }

.button-icon { width: 14px; height: 14px; margin-right: 4px; }

.invalid-panel { padding: 18px 20px; max-height: 360px; overflow-y: auto; }

.invalid-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  color: var(--el-color-danger);
  font-size: 14px;
}

.invalid-panel-head svg { width: 16px; height: 16px; }
.invalid-panel-head strong { flex: 1; }

.invalid-group { margin-top: 14px; }
.invalid-group-count { margin-left: 8px; font-size: 12px; color: var(--el-text-color-secondary); }

.invalid-group-links {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}

.invalid-link-item {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  font-size: 12px;
}

.invalid-link-no { flex-shrink: 0; width: 18px; color: var(--el-text-color-placeholder); text-align: right; }
.invalid-link-url { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }

.invalid-panel-tip {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.preview-card { padding: 18px 20px; }

.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.preview-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
.preview-head span { font-size: 12px; color: var(--el-text-color-secondary); }

.result-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 480px;
  overflow-y: auto;
}

.result-row {
  display: grid;
  grid-template-columns: 40px 36px minmax(0, 1fr) 72px 120px;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
}

.result-row.invalid {
  border-color: var(--el-color-danger-light-5);
  background: var(--el-color-danger-light-9);
}

.row-no { font-size: 12px; color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
.row-qty { font-style: normal; font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
.row-amount { font-size: 12px; color: var(--el-text-color-secondary); text-align: right; }

.note-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--el-fill-color);
  font-size: 10px;
  font-weight: 700;
  color: var(--el-text-color-secondary);
}

.note-avatar img { width: 100%; height: 100%; object-fit: cover; }
.note-info { min-width: 0; }
.note-info strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.note-info strong small { margin-left: 6px; color: var(--el-color-success); font-weight: 400; font-size: 11px; }
.note-info span, .note-info a {
  display: block;
  overflow: hidden;
  margin-top: 2px;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-decoration: none;
}
.note-info a:hover { color: var(--el-color-primary); }

.reveal-hidden { opacity: 0; transform: translateY(12px); }
.reveal-visible { animation: reveal-in 0.4s ease-out forwards; }

@keyframes reveal-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.order-records-drawer {
  display: flex;
  flex-direction: column;
}

.order-records-drawer :deep(.el-drawer__header) {
  flex-shrink: 0;
  margin-bottom: 0;
  padding: 14px 20px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.order-records-drawer :deep(.el-drawer__body) {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0;
  overflow: hidden;
}

.order-records-drawer :deep(.el-drawer__close-btn) {
  font-size: 18px;
}

.dr-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dr-header h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}

.dr-header-count {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.dr-root {
  flex: 1 1 0;
  display: flex;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.dr-shell {
  flex: 1 1 0;
  display: flex;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}

.dr-sidebar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 248px;
  flex-shrink: 0;
  align-self: stretch;
  min-height: 0;
  padding: 12px;
  border-right: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-light);
  overflow: hidden;
}

.dr-sidebar > :deep(.el-input) {
  flex-shrink: 0;
}

.dr-batch-list {
  flex: 1 1 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding-right: 4px;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.dr-batch-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  flex-shrink: 0;
  margin-bottom: 8px;
  padding: 10px 11px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-bg-color);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.dr-batch-item:last-child {
  margin-bottom: 0;
}

.dr-batch-item:hover {
  border-color: var(--el-color-primary-light-5);
}

.dr-batch-item.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary-light-7);
}

.dr-batch-item--problem.active {
  border-color: var(--el-color-warning);
  box-shadow: 0 0 0 1px var(--el-color-warning-light-7);
}

.dr-batch-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.dr-batch-kind {
  font-size: 11px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.dr-batch-item--problem .dr-batch-kind {
  color: var(--el-color-warning);
}

.dr-batch-no {
  font-size: 12px;
  font-weight: 600;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dr-batch-item-meta {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.dr-batch-counts {
  display: flex;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
}

.dr-batch-counts .ok { color: var(--el-color-success); }
.dr-batch-counts .bad { color: var(--el-color-danger); }
.dr-batch-counts .total { color: var(--el-text-color-secondary); font-weight: 500; }

.dr-sidebar-empty {
  padding: 24px 8px;
  text-align: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.dr-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 14px 16px 16px;
  background: var(--el-bg-color);
}

.dr-main--empty {
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.dr-main-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.dr-main-title code {
  display: block;
  font-size: 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  word-break: break-all;
  line-height: 1.45;
}

.dr-main-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.dr-main-amount {
  font-size: 15px;
  font-weight: 700;
  color: var(--el-color-primary);
}

.dr-main-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 14px;
  margin-top: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.dr-main-stats .ok { color: var(--el-color-success); font-weight: 600; }
.dr-main-stats .bad { color: var(--el-color-danger); font-weight: 600; }

.dr-main-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0;
}

.dr-main-toolbar :deep(.el-input) {
  flex: 1;
  min-width: 0;
}

.dr-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.pill--success, .dr-badge.pill--success { background: var(--el-color-success-light-8); color: var(--el-color-success); }
.pill--danger, .dr-badge.pill--danger { background: var(--el-color-danger-light-8); color: var(--el-color-danger); }
.pill--warning, .dr-badge.pill--warning { background: var(--el-color-warning-light-8); color: var(--el-color-warning); }
.pill--info, .dr-badge.pill--info { background: var(--el-color-primary-light-8); color: var(--el-color-primary); }

.dr-tabs {
  display: inline-flex;
  flex-shrink: 0;
  padding: 2px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
}

.dr-tab {
  padding: 5px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.dr-tab.active {
  background: var(--el-bg-color);
  color: var(--el-color-primary);
  box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
}

.dr-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}

.dr-order {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-blank);
}

.dr-order.is-success { border-left: 3px solid var(--el-color-success); }
.dr-order.is-failed { border-left: 3px solid var(--el-color-danger); }
.dr-order.is-refunded,
.dr-order.is-refunding { border-left: 3px solid var(--el-color-warning); }

.dr-order-avatar {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--el-fill-color);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: var(--el-text-color-secondary);
}

.dr-order-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.dr-order-body {
  min-width: 0;
  flex: 1;
}

.dr-order-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.dr-order-top strong {
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

.dr-order-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}

.dr-order-side em {
  font-style: normal;
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.dr-order-sub {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dr-order-link {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--el-text-color-secondary);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dr-order-link:hover { color: var(--el-color-primary); }

.dr-order-link--raw {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  white-space: normal;
  word-break: break-all;
}

.dr-list-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 120px;
  color: var(--el-text-color-secondary);
}

.dr-list-empty-icon {
  width: 32px;
  height: 32px;
  opacity: 0.35;
}

.dr-list-empty p { margin: 0; font-size: 13px; }

.dr-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--el-text-color-secondary);
}

.dr-empty-icon { width: 40px; height: 40px; opacity: 0.4; }
.dr-empty p { margin: 0; font-size: 14px; }

@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 768px) {
  .batch-order-page { padding: 12px; }
  .page-head { flex-direction: column; align-items: stretch; }
  .head-actions { flex-direction: column; align-items: stretch; }
  .type-switcher { overflow-x: auto; }
  .summary-grid { grid-template-columns: 1fr; }
  .submit-bar { flex-direction: column; align-items: stretch; }
  .submit-block { align-items: stretch; }
  .submit-btn { width: 100%; }
  .result-row { grid-template-columns: 1fr; }
  .row-qty, .row-amount { text-align: left; }

  .order-records-drawer :deep(.el-drawer__body) {
    max-height: calc(100dvh - 56px);
  }

  .dr-root,
  .dr-shell {
    flex: 1 1 0;
    min-height: 0;
    height: 100%;
  }

  .dr-shell {
    flex-direction: column;
  }

  .dr-sidebar {
    flex: 0 0 auto;
    width: 100%;
    max-height: min(36vh, 260px);
    border-right: none;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }

  .dr-batch-list {
    flex: 1 1 0;
    min-height: 0;
  }

  .dr-main {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
    padding: 12px;
  }

  .dr-main-head {
    flex-direction: column;
    gap: 8px;
  }

  .dr-main-toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .dr-main-toolbar :deep(.el-input) {
    width: 100%;
  }

  .dr-tabs {
    display: flex;
    width: 100%;
  }

  .dr-tab {
    flex: 1;
    text-align: center;
  }

  .dr-list {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
  }

  .dr-order {
    align-items: flex-start;
  }

  .dr-order-top {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }

  .dr-order-top strong {
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .dr-order-side {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }

  .dr-order-sub,
  .dr-order-link {
    font-size: 12px;
    white-space: normal;
    word-break: break-all;
  }
}
</style>
