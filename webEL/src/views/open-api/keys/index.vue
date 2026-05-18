<script setup lang="ts">
import type { OrderApi } from '#/api/core';

import { computed, onMounted, ref } from 'vue';

import {
  createOpenApiKeyApi,
  deleteOpenApiKeyApi,
  getOpenApiKeysApi,
} from '#/api/core';

import { ElMessage, ElMessageBox } from 'element-plus';

const loading = ref(false);
const creating = ref(false);
const deletingId = ref<number>();
const keys = ref<OrderApi.OpenApiKey[]>([]);
const newApiKey = ref('');
const keyName = ref('default');

const fullKeyCachePrefix = 'goods:open-api-full-key:';

const authRows = [
  { label: 'Header', value: 'X-Api-Key: <Open API key>' },
  { label: 'Header', value: 'Authorization: Bearer <Open API key>' },
  { label: 'Query', value: '?key=<Open API key> 或 ?api_key=<Open API key>' },
];

const responseFields = [
  { desc: '0 表示成功，非 0 表示失败', name: 'code', type: 'number' },
  { desc: '成功为 ok，失败为错误原因', name: 'message', type: 'string' },
  { desc: '接口业务数据，失败时可能为 null', name: 'data', type: 'object | null' },
];

const apiDocs = [
  {
    desc: '按批量内容预校验订单，只计算可提交行、金额和错误行，不创建订单，不扣余额。',
    method: 'POST',
    params: [
      {
        desc: '批量内容，每行一条，格式为“链接 数量”。支持阅读、点赞、曝光下单链接。',
        example: 'https://www.xiaohongshu.com/explore/6a081953000000003501efc6 100',
        name: 'content',
        place: 'body',
        required: '是',
        type: 'string',
      },
      {
        desc: '业务类型：view=阅读，like=点赞，impression=曝光。',
        example: 'view',
        name: 'target_type',
        place: 'body',
        required: '是',
        type: 'string',
      },
    ],
    path: '/api/open/orders/preview',
    requestExample: `{
  // 必填：业务类型，view=阅读，like=点赞，impression=曝光
  "target_type": "view",
  // 必填：批量内容，每行格式为“链接 数量”
  "content": "https://www.xiaohongshu.com/explore/6a081953000000003501efc6 100"
}`,
    responseExample: `{
  // 0 表示成功，非 0 表示失败
  "code": 0,
  // 本次接口处理结果说明
  "message": "ok",
  // 预校验结果，不会创建订单，也不会扣余额
  "data": {
    "total_count": 1,
    "valid_count": 1,
    "invalid_count": 0,
    "total_amount": 30
  }
}`,
    title: '预校验订单',
  },
  {
    desc: '创建批量订单，费用从当前 Open API key 所属账号余额扣除，单价使用管理员在权限管理里给该账号设置的单价。创建前会先执行预校验，预校验不通过不会创建订单。',
    method: 'POST',
    params: [
      {
        desc: '批量内容，每行一条，格式为“链接 数量”。一条链接会创建一条订单并提交一次上游任务。',
        example: 'https://www.xiaohongshu.com/explore/6a081953000000003501efc6 100',
        name: 'content',
        place: 'body',
        required: '是',
        type: 'string',
      },
      {
        desc: '业务类型：view=阅读，like=点赞，impression=曝光。',
        example: 'like',
        name: 'target_type',
        place: 'body',
        required: '是',
        type: 'string',
      },
      {
        desc: '是否确认公告和下单规则。外部调用可传 true。',
        example: 'true',
        name: 'agree_policy',
        place: 'body',
        required: '否',
        type: 'boolean',
      },
      {
        desc: '外部系统备注，会记录到订单和消费流水里，便于对账。',
        example: 'merchant_order=MO202605180001',
        name: 'remark',
        place: 'body',
        required: '否',
        type: 'string',
      },
    ],
    path: '/api/open/orders/submit',
    requestExample: `{
  // 必填：业务类型，view=阅读，like=点赞，impression=曝光
  "target_type": "like",
  // 选填：是否确认平台公告和下单规则，外部调用建议传 true
  "agree_policy": true,
  // 选填：外部系统备注，方便后续对账
  "remark": "merchant_order=MO202605180001",
  // 必填：批量内容，每行格式为“链接 数量”
  "content": "https://www.xiaohongshu.com/explore/6a081953000000003501efc6 20"
}`,
    responseExample: `{
  "code": 0,
  "message": "ok",
  "data": {
    // 批次 ID，查询进度和停止任务推荐传这个
    "batch_id": "62db9f35-1228-4fe9-962b-57568c5bb690",
    // 批次编号，页面也会显示
    "batch_no": "BATCH-MP9XXXX-01",
    "submitted_count": 1,
    "failed_count": 0,
    "total_amount": 30
  }
}`,
    title: '提交订单',
  },
  {
    desc: '查询批次或单条订单的处理进度。同一个 Open API key 10 秒内只能调用一次。',
    method: 'GET',
    params: [
      {
        desc: '批次 ID，创建订单接口返回的 batch_id，通常是 UUID 字符串。',
        example: '62db9f35-1228-4fe9-962b-57568c5bb690',
        name: 'batch_id',
        place: 'query',
        required: '否',
        type: 'string',
      },
      {
        desc: '批次编号。',
        example: 'BATCH-MP9XXXX-01',
        name: 'batch_no',
        place: 'query',
        required: '否',
        type: 'string',
      },
      {
        desc: '订单自增 ID，不是批次 UUID。',
        example: '338',
        name: 'order_id',
        place: 'query',
        required: '否',
        type: 'number',
      },
      {
        desc: '订单编号。',
        example: 'ORDER-1779022974635-003',
        name: 'order_no',
        place: 'query',
        required: '否',
        type: 'string',
      },
    ],
    path: '/api/open/orders/progress',
    requestExample: `GET /api/open/orders/progress?batch_id=62db9f35-1228-4fe9-962b-57568c5bb690`,
    responseExample: `{
  "code": 0,
  "message": "ok",
  "data": {
    "count": 1,
    "batches": [
      {
        "batch_id": "62db9f35-1228-4fe9-962b-57568c5bb690",
        "batch_no": "BATCH-MP9XXXX-01",
        "status": "processing",
        "progress": {
          "completed_quantity": 40,
          "total_quantity": 100,
          "percent": 40
        },
        "orders": [
          {
            "order_id": 338,
            "order_no": "ORDER-1779022974635-003",
            "order_status": "running",
            "progress": 40,
            "progress_percent": 40
          }
        ]
      }
    ]
  }
}`,
    title: '查询进度',
  },
  {
    desc: '停止本平台订单对应的上游任务，只停止任务，不自动退款。四个定位参数任选一个即可。',
    method: 'POST',
    params: [
      {
        desc: '批次 ID，创建订单接口返回的 batch_id，通常是 UUID 字符串。推荐使用这个。',
        example: '62db9f35-1228-4fe9-962b-57568c5bb690',
        name: 'batch_id',
        place: 'body/query',
        required: '否',
        type: 'string',
      },
      {
        desc: '批次编号。',
        example: 'BATCH-MP9XXXX-01',
        name: 'batch_no',
        place: 'body/query',
        required: '否',
        type: 'string',
      },
      {
        desc: '订单自增 ID，不是批次 UUID。批次 UUID 请传 batch_id。',
        example: '338',
        name: 'order_id',
        place: 'body/query',
        required: '否',
        type: 'number',
      },
      {
        desc: '订单编号。',
        example: 'ORDER-1779022974635-003',
        name: 'order_no',
        place: 'body/query',
        required: '否',
        type: 'string',
      },
      {
        desc: '停止原因，会写入订单记录和上游状态变更原因。',
        example: 'merchant cancel requested',
        name: 'reason',
        place: 'body',
        required: '否',
        type: 'string',
      },
    ],
    path: '/api/open/orders/stop',
    requestExample: `{
  // 必填其一：batch_id、batch_no、order_id、order_no
  // 推荐使用创建订单接口返回的 batch_id；order_id 是本平台订单自增 ID，不是批次 UUID
  "batch_id": "62db9f35-1228-4fe9-962b-57568c5bb690",
  // 选填：停止原因，会写入订单记录和上游状态变更原因
  "reason": "merchant cancel requested"
}`,
    responseExample: `{
  "code": 0,
  "message": "ok",
  "data": {
    "total_count": 1,
    "stopped_count": 1,
    "skipped_count": 0,
    "failed_count": 0,
    "orders": [
      {
        "batch_id": "62db9f35-1228-4fe9-962b-57568c5bb690",
        "batch_no": "BATCH-MP9XXXX-01",
        "order_id": 338,
        "order_no": "ORDER-1779022974635-003",
        "order_status": "stopping",
        "stop_status": "success"
      }
    ]
  }
}`,
    title: '停止任务',
  },
];

const activeKey = computed(() => keys.value.find((item) => item.status === 'active'));
const canCreate = computed(() => !activeKey.value && !creating.value);
const activeFullKey = computed(() => {
  if (!activeKey.value) return '';
  if (newApiKey.value.startsWith(activeKey.value.key_prefix)) {
    return newApiKey.value;
  }
  return localStorage.getItem(`${fullKeyCachePrefix}${activeKey.value.id}`) || '';
});

async function loadKeys() {
  loading.value = true;
  try {
    keys.value = await getOpenApiKeysApi();
  } finally {
    loading.value = false;
  }
}

async function createKey() {
  if (!canCreate.value) {
    ElMessage.warning('当前账号已有可用 key，请删除后再重新申请');
    return;
  }
  creating.value = true;
  try {
    const data = await createOpenApiKeyApi({ name: keyName.value || 'default' });
    newApiKey.value = data.api_key;
    localStorage.setItem(`${fullKeyCachePrefix}${data.id}`, data.api_key);
    ElMessage.success('Open API key 已生成');
    await loadKeys();
  } finally {
    creating.value = false;
  }
}

async function deleteKey(row: OrderApi.OpenApiKey) {
  await ElMessageBox.confirm(
    '删除后当前 key 将不能继续调用开放接口，需要重新申请新 key。',
    '删除 Open API key',
    {
      cancelButtonText: '取消',
      confirmButtonText: '删除',
      type: 'warning',
    },
  );
  deletingId.value = row.id;
  try {
    await deleteOpenApiKeyApi(row.id);
    localStorage.removeItem(`${fullKeyCachePrefix}${row.id}`);
    if (newApiKey.value.startsWith(row.key_prefix)) {
      newApiKey.value = '';
    }
    ElMessage.success('已删除');
    await loadKeys();
  } finally {
    deletingId.value = undefined;
  }
}

async function copyText(text: string) {
  if (!text) {
    ElMessage.warning('没有可复制的内容');
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error('Clipboard API unavailable');
    }
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) {
      ElMessage.error('复制失败，请手动选择复制');
      return;
    }
  }
  ElMessage.success('已复制');
}

async function copyActiveKey() {
  if (activeFullKey.value) {
    await copyText(activeFullKey.value);
    return;
  }
  ElMessage.warning('完整 key 只在创建后显示一次。当前只有脱敏 key，请删除后重新申请新 key。');
}

function formatDate(value?: null | string) {
  if (!value) return '-';
  return value.replace('T', ' ').slice(0, 19);
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function highlightCode(value: string) {
  return escapeHtml(value)
    .replace(/(\/\/.*)$/gm, '<span class="code-comment">$1</span>')
    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="code-key">$1</span>$2')
    .replace(/(:\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="code-string">$2</span>')
    .replace(/(:\s*)(\d+(?:\.\d+)?)/g, '$1<span class="code-number">$2</span>')
    .replace(/(:\s*)(true|false|null)\b/g, '$1<span class="code-literal">$2</span>');
}

onMounted(loadKeys);
</script>

<template>
  <div class="open-api-page">
    <section class="page-head">
      <div>
        <span class="eyebrow">Open API</span>
        <h1>开放接口</h1>
        <p>申请 key 后，外部系统可以通过本平台中转创建订单、查询进度和停止任务。</p>
      </div>
      <button class="header-refresh-button" type="button" :disabled="loading" @click="loadKeys">
        {{ loading ? '刷新中' : '刷新' }}
      </button>
    </section>

    <section class="top-grid">
      <div class="key-panel">
        <div class="panel-title" >
          <div class="title-content" style="flex: 1;">
            <h2>我的 Key</h2>
            <p>一个账号同一时间只保留一个可用 key，删除后才可以重新申请。</p>
          </div>
          <span v-if="activeKey" class="key-status-badge key-status-badge--active">
            <span class="status-dot"></span>
            已启用
          </span>
          <span v-else class="key-status-badge key-status-badge--empty">未申请</span>
        </div>

        <div v-if="newApiKey" class="new-key-box">
          <div>
            <strong>请立即保存完整 key</strong>
            <p>完整 key 只在创建后显示一次，刷新页面后只显示脱敏内容。</p>
          </div>
          <div class="key-copy-line">
            <code>{{ newApiKey }}</code>
            <el-button type="primary" @click="copyText(newApiKey)" class="create-button">复制</el-button>
          </div>
        </div>

        <div v-if="activeKey" class="active-key">
          <div class="key-main">
            <span class="label">当前 key</span>
            <div class="current-key-line">
              <strong>{{ activeFullKey || activeKey.masked_key }}</strong>
              <button class="inline-copy-button" type="button" @click="copyActiveKey">复制</button>
            </div>
            <small v-if="!activeFullKey" class="key-copy-tip">
              仅显示脱敏 key，完整 key 需要重新申请后复制。
            </small>
          </div>
          <div>
            <span class="label">创建时间</span>
            <strong>{{ formatDate(activeKey.created_at) }}</strong>
          </div>
          <div>
            <span class="label">最后使用</span>
            <strong>{{ formatDate(activeKey.last_used_at) }}</strong>
          </div>
          <div class="key-actions">
            <button class="key-action-button key-action-button--danger" type="button" :disabled="deletingId === activeKey.id" @click="deleteKey(activeKey)">
              {{ deletingId === activeKey.id ? '删除中' : '删除 key' }}
            </button>
          </div>
        </div>

        <div v-else class="create-key">
          <el-input v-model="keyName" maxlength="100" placeholder="key 名称" />
          <el-button type="primary" class="create-button" :loading="creating" @click="createKey">申请 key</el-button>
        </div>
      </div>

      <div class="auth-panel">
        <h2>调用规则</h2>
        <p>所有开放接口都需要携带 key。订单扣款使用 key 所属账号余额和该账号的业务单价。</p>
        <div class="auth-list">
          <div v-for="row in authRows" :key="row.value" class="auth-row">
            <span>{{ row.label }}</span>
            <code>{{ row.value }}</code>
          </div>
        </div>
        <div class="note-box">
          <strong>提交内容格式</strong>
          <p>每行一条：链接 + 空格 + 数量。多行会按链接拆成多条订单。</p>
        </div>
      </div>
    </section>

    <section class="doc-panel">
      <h2>接口文档</h2>

      <div class="doc-block response-block">
        <h3>统一响应</h3>
        <el-table :data="responseFields" size="small">
          <el-table-column label="字段" prop="name" width="160" />
          <el-table-column label="类型" prop="type" width="160" />
          <el-table-column label="说明" prop="desc" />
        </el-table>
      </div>

      <article v-for="doc in apiDocs" :key="doc.path" class="doc-block api-card">
        <div class="api-card-head">
          <span class="method-badge" :class="`method-${doc.method.toLowerCase()}`">{{ doc.method }}</span>
          <code>{{ doc.path }}</code>
          <strong>{{ doc.title }}</strong>
        </div>
        <p class="api-desc">{{ doc.desc }}</p>

        <el-table :data="doc.params" size="small" class="param-table">
          <el-table-column label="参数" prop="name" width="150" />
          <el-table-column label="位置" prop="place" width="110" />
          <el-table-column label="类型" prop="type" width="120" />
          <el-table-column label="必填" prop="required" width="80" />
          <el-table-column label="示例" prop="example" min-width="220" />
          <el-table-column label="说明" prop="desc" min-width="260" />
        </el-table>

        <div class="code-grid">
          <div class="code-panel">
            <div class="code-title">
              <span>请求示例</span>
              <button type="button" @click="copyText(doc.requestExample)">复制</button>
            </div>
            <pre><code v-html="highlightCode(doc.requestExample)"></code></pre>
          </div>
          <div class="code-panel">
            <div class="code-title">
              <span>成功响应</span>
              <button type="button" @click="copyText(doc.responseExample)">复制</button>
            </div>
            <pre><code v-html="highlightCode(doc.responseExample)"></code></pre>
          </div>
        </div>
      </article>
    </section>
  </div>
</template>

<style scoped>
.create-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 20px;
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  background: var(--el-color-primary);
  color: #fff;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 4px rgba(64, 158, 255, 0.3);
  transform: translateY(0);

  &:hover {
    background: var(--el-color-primary-light-3);
    box-shadow: 0 4px 12px rgba(64, 158, 255, 0.4);
    transform: translateY(-2px);
  }

  &:active {
    transition: all 0.1s ease;
    box-shadow: 0 1px 2px rgba(64, 158, 255, 0.3);
    transform: translateY(0);
  }

  &:disabled {
    background: var(--el-fill-color);
    color: var(--el-text-color-secondary);
    cursor: not-allowed;
    box-shadow: none;
    transform: none;
  }
}

.open-api-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.page-head,
.key-panel,
.auth-panel,
.doc-panel,
.doc-block {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px;
}

.page-head h1,
.key-panel h2,
.auth-panel h2,
.doc-panel h2 {
  margin: 0;
  color: var(--el-text-color-primary);
}

.page-head p,
.panel-title p,
.auth-panel p,
.api-desc,
.note-box p {
  margin: 6px 0 0;
  color: var(--el-text-color-secondary);
}

.eyebrow {
  color: var(--el-color-primary);
  font-size: 12px;
  font-weight: 700;
}

.header-refresh-button,
.inline-copy-button,
.key-action-button,
.code-title button {
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 6px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  cursor: pointer;
  font-weight: 600;
}

.header-refresh-button {
  padding: 8px 16px;
}

.top-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.7fr);
  gap: 16px;
}

.key-panel,
.auth-panel,
.doc-panel {
  padding: 18px;
}

.panel-title,
.active-key {
  display: flex;
  gap: 16px;
  justify-content: flex-start;
}

.key-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border-radius: 999px;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 700;
}

.key-status-badge--active {
  border: 1px solid var(--el-color-success-light-5);
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.key-status-badge--empty {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.new-key-box,
.active-key,
.create-key,
.note-box {
  margin-top: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 14px;
  background: var(--el-fill-color-extra-light);
}

.new-key-box {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}

.key-copy-line,
.current-key-line,
.create-key,
.key-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.key-copy-line {
  margin-top: 12px;
}

.key-copy-line code,
.current-key-line strong {
  flex: 0 1 auto;
  min-width: 320px;
  max-width: 520px;
  overflow: auto;
  border-radius: 6px;
  background: var(--el-bg-color);
  padding: 10px;
  font-family: Consolas, monospace;
}

.label {
  display: block;
  margin-bottom: 6px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.key-main {
  flex: 0 1 590px;
  min-width: 0;
}

.inline-copy-button,
.key-action-button,
.code-title button {
  padding: 6px 10px;
}

.key-action-button--danger {
  border-color: var(--el-color-danger-light-5);
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.key-copy-tip {
  display: block;
  margin-top: 6px;
  color: var(--el-text-color-secondary);
}

.auth-list {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}

.auth-row {
  display: grid;
  grid-template-columns: 80px 1fr;
  gap: 12px;
  align-items: center;
}

.auth-row span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.auth-row code {
  border-radius: 6px;
  background: var(--el-fill-color-light);
  padding: 8px 10px;
  font-family: Consolas, monospace;
}

.doc-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.doc-block {
  padding: 16px;
}

.doc-block h3 {
  margin: 0 0 12px;
}

.api-card-head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.method-badge {
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 800;
}

.method-post {
  background: #fff2e8;
  color: #d46b08;
}

.method-get {
  background: #e6f7ff;
  color: #0958d9;
}

.param-table {
  margin-top: 12px;
}

.code-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.code-panel {
  overflow: hidden;
  border: 1px solid #20304a;
  border-radius: 8px;
  background: #0f172a;
}

.code-title {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid #20304a;
  padding: 8px 10px;
  color: #e5e7eb;
  font-weight: 700;
}

pre {
  min-height: 220px;
  margin: 0;
  overflow: auto;
  padding: 14px;
  color: #dbeafe;
  font-family: Consolas, monospace;
  font-size: 13px;
  line-height: 1.7;
}

:deep(.code-comment) {
  color: #34d399;
}

:deep(.code-key) {
  color: #93c5fd;
}

:deep(.code-string) {
  color: #fbbf24;
}

:deep(.code-number) {
  color: #f472b6;
}

:deep(.code-literal) {
  color: #c084fc;
}

@media (max-width: 1100px) {
  .top-grid,
  .code-grid {
    grid-template-columns: 1fr;
  }
}
</style>
