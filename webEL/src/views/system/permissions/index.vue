<script setup lang="ts">
import type { UserApi } from '#/api';

import { computed, onMounted, reactive, ref } from 'vue';

import {
  ElButton,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElOption,
  ElPagination,
  ElSelect,
  ElTag,
} from 'element-plus';

import {
  getAdminPermissionRolesApi,
  getAdminPermissionUsersApi,
  updateAdminUserDiscountsApi,
  updateAdminUserRolesApi,
  updateAdminUserStatusApi,
} from '#/api';

interface EditableDiscounts {
  discount_rate: number;
  fixed_unit_price: null | number;
  impression_discount_rate: number;
  impression_fixed_unit_price: null | number;
  impression_price_mode: 'default' | 'discount' | 'fixed';
  price_mode: 'default' | 'discount' | 'fixed';
}

const loading = ref(false);
const roles = ref<UserApi.AdminRole[]>([]);
const users = ref<UserApi.AdminUserPermission[]>([]);
const keyword = ref('');
const pagination = reactive({
  page: 1,
  page_size: 10,
  total: 0,
});
const savingUserId = ref<number>();
const statusSavingUserId = ref<number>();
const discountSavingUserId = ref<number>();
const batchDiscountSaving = ref(false);
const editedRoles = reactive<Record<number, string[]>>({});
const editedDiscounts = reactive<Record<number, EditableDiscounts>>({});
const batchDiscounts = reactive<EditableDiscounts>({
  discount_rate: 1,
  fixed_unit_price: 0.01,
  impression_discount_rate: 1,
  impression_fixed_unit_price: 0.01,
  impression_price_mode: 'default',
  price_mode: 'default',
});

const roleLabelMap = computed(() =>
  Object.fromEntries(roles.value.map((role) => [role.code, role.name])),
);

const filteredUsers = computed(() => users.value);

function roleTagType(role: string) {
  if (role === 'super') {
    return 'danger';
  }
  if (role === 'admin') {
    return 'warning';
  }
  return 'success';
}

function statusLabel(status: string) {
  if (status === 'disabled') {
    return '已停用';
  }
  if (status === 'locked') {
    return '已锁定';
  }
  return '正常';
}

function statusTagType(status: string) {
  if (status === 'disabled') {
    return 'danger';
  }
  if (status === 'locked') {
    return 'warning';
  }
  return 'success';
}

function formatDiscount(rate: number) {
  return `${(Number(rate || 1) * 10).toFixed(1)} 折`;
}

function priceValueLabel(
  mode: EditableDiscounts['price_mode'],
  discountRate: number,
  fixedPrice: null | number,
) {
  if (mode === 'discount') {
    return formatDiscount(discountRate);
  }
  return `￥ ${(Number(fixedPrice) || 0).toFixed(4)} /个`;
}

function createEditableDiscounts(user: UserApi.AdminUserPermission): EditableDiscounts {
  return {
    discount_rate: Number(user.discount_rate) || 1,
    fixed_unit_price: user.fixed_unit_price ?? null,
    impression_discount_rate: Number(user.impression_discount_rate) || 1,
    impression_fixed_unit_price: user.impression_fixed_unit_price ?? null,
    impression_price_mode: user.impression_price_mode || 'discount',
    price_mode: user.price_mode || 'discount',
  };
}

function getEditedRoles(user: UserApi.AdminUserPermission): string[] {
  const existingRoles = editedRoles[user.id];
  if (!existingRoles) {
    editedRoles[user.id] = [...user.roles];
  }
  return editedRoles[user.id] ?? [];
}

function getEditedDiscounts(user: UserApi.AdminUserPermission): EditableDiscounts {
  const existingDiscounts = editedDiscounts[user.id];
  if (!existingDiscounts) {
    editedDiscounts[user.id] = createEditableDiscounts(user);
  }
  return editedDiscounts[user.id] ?? createEditableDiscounts(user);
}

async function loadData() {
  loading.value = true;
  try {
    const [roleData, userData] = await Promise.all([
      getAdminPermissionRolesApi(),
      getAdminPermissionUsersApi({
        keyword: keyword.value,
        page: pagination.page,
        page_size: pagination.page_size,
      }),
    ]);
    roles.value = roleData;
    users.value = userData.items;
    pagination.total = userData.total;
    for (const user of userData.items) {
      editedRoles[user.id] = [...user.roles];
      editedDiscounts[user.id] = createEditableDiscounts(user);
    }
  } finally {
    loading.value = false;
  }
}

function searchUsers() {
  pagination.page = 1;
  loadData();
}

function handlePermissionPageChange(page: number) {
  pagination.page = page;
  loadData();
}

function handlePermissionPageSizeChange(pageSize: number) {
  pagination.page = 1;
  pagination.page_size = pageSize;
  loadData();
}

async function saveUserRoles(user: UserApi.AdminUserPermission) {
  const selectedRoles = getEditedRoles(user);
  if (selectedRoles.length === 0) {
    ElMessage.warning('至少保留一个角色');
    return;
  }

  savingUserId.value = user.id;
  try {
    await updateAdminUserRolesApi(user.id, selectedRoles);
    ElMessage.success('权限已更新');
    await loadData();
  } catch {
    ElMessage.error('权限更新失败');
  } finally {
    savingUserId.value = undefined;
  }
}

async function saveUserDiscounts(user: UserApi.AdminUserPermission) {
  const discounts = getEditedDiscounts(user);
  if (discounts.price_mode !== 'discount' && !Number(discounts.fixed_unit_price)) {
    ElMessage.warning('请填写阅读价格');
    return;
  }
  if (
    discounts.impression_price_mode !== 'discount' &&
    !Number(discounts.impression_fixed_unit_price)
  ) {
    ElMessage.warning('请填写曝光价格');
    return;
  }
  discountSavingUserId.value = user.id;
  try {
    await updateAdminUserDiscountsApi(user.id, discounts);
    ElMessage.success('折扣已更新');
    await loadData();
  } catch {
    ElMessage.error('折扣更新失败，折扣率必须大于 0 且不超过 1');
  } finally {
    discountSavingUserId.value = undefined;
  }
}

function applyBatchDiscounts() {
  for (const user of filteredUsers.value) {
    editedDiscounts[user.id] = {
      discount_rate: batchDiscounts.discount_rate,
      fixed_unit_price: batchDiscounts.fixed_unit_price,
      impression_discount_rate: batchDiscounts.impression_discount_rate,
      impression_fixed_unit_price: batchDiscounts.impression_fixed_unit_price,
      impression_price_mode: batchDiscounts.impression_price_mode,
      price_mode: batchDiscounts.price_mode,
    };
  }
  ElMessage.success(`已填入 ${filteredUsers.value.length} 个用户`);
}

async function saveAllDiscounts() {
  batchDiscountSaving.value = true;
  try {
    for (const user of filteredUsers.value) {
      await updateAdminUserDiscountsApi(user.id, getEditedDiscounts(user));
    }
    ElMessage.success(`已保存 ${filteredUsers.value.length} 个用户折扣设置`);
    await loadData();
  } catch {
    ElMessage.error('批量保存失败，请检查价格和折扣输入');
  } finally {
    batchDiscountSaving.value = false;
  }
}

async function toggleUserStatus(user: UserApi.AdminUserPermission) {
  const nextStatus = user.status === 'disabled' ? 'active' : 'disabled';
  statusSavingUserId.value = user.id;
  try {
    await updateAdminUserStatusApi(user.id, nextStatus);
    ElMessage.success(nextStatus === 'disabled' ? '用户已停用' : '用户已启用');
    await loadData();
  } catch {
    ElMessage.error('用户状态更新失败');
  } finally {
    statusSavingUserId.value = undefined;
  }
}

onMounted(loadData);
</script>

<template>
  <div class="permission-page">
    <section class="permission-head">
      <div>
        <h1>权限管理</h1>
        <p>管理员可调整用户角色、账号状态，以及阅读和曝光业务折扣。</p>
      </div>
      <div class="head-actions">
        <ElInput
          v-model="keyword"
          clearable
          placeholder="搜索用户名、昵称、编号"
          @keyup.enter="searchUsers"
        />
        <ElButton :loading="loading" type="primary" @click="searchUsers">
          搜索
        </ElButton>
      </div>
    </section>

    <section class="batch-discount-panel">
      <div>
        <strong>批量填入折扣设置</strong>
        <span>选择模式和数值后，一键填入当前列表所有用户。</span>
      </div>
      <div class="discount-editor batch-discount-editor">
        <label>
          <span>阅读</span>
          <ElSelect v-model="batchDiscounts.price_mode" class="price-mode-select">
            <ElOption label="默认价格" value="default" />
            <ElOption label="折扣价格" value="discount" />
            <ElOption label="固定金额价格" value="fixed" />
          </ElSelect>
          <ElInputNumber
            v-if="batchDiscounts.price_mode === 'discount'"
            v-model="batchDiscounts.discount_rate"
            :max="1"
            :min="0.0001"
            :precision="4"
            :step="0.1"
            controls-position="right"
          />
          <ElInputNumber
            v-else
            v-model="batchDiscounts.fixed_unit_price"
            :min="0.0001"
            :precision="4"
            :step="0.001"
            controls-position="right"
          />
          <em>
            {{
              priceValueLabel(
                batchDiscounts.price_mode,
                batchDiscounts.discount_rate,
                batchDiscounts.fixed_unit_price,
              )
            }}
          </em>
        </label>
        <label>
          <span>曝光</span>
          <ElSelect
            v-model="batchDiscounts.impression_price_mode"
            class="price-mode-select"
          >
            <ElOption label="默认价格" value="default" />
            <ElOption label="折扣价格" value="discount" />
            <ElOption label="固定金额价格" value="fixed" />
          </ElSelect>
          <ElInputNumber
            v-if="batchDiscounts.impression_price_mode === 'discount'"
            v-model="batchDiscounts.impression_discount_rate"
            :max="1"
            :min="0.0001"
            :precision="4"
            :step="0.1"
            controls-position="right"
          />
          <ElInputNumber
            v-else
            v-model="batchDiscounts.impression_fixed_unit_price"
            :min="0.0001"
            :precision="4"
            :step="0.001"
            controls-position="right"
          />
          <em>
            {{
              priceValueLabel(
                batchDiscounts.impression_price_mode,
                batchDiscounts.impression_discount_rate,
                batchDiscounts.impression_fixed_unit_price,
              )
            }}
          </em>
        </label>
      </div>
      <ElButton type="primary" @click="applyBatchDiscounts">
        一键填入
      </ElButton>
      <ElButton
        :loading="batchDiscountSaving"
        type="warning"
        @click="saveAllDiscounts"
      >
        一键保存
      </ElButton>
    </section>

    <section class="permission-table" v-loading="loading">
      <div class="table-row table-header">
        <span>用户</span>
        <span>账号编号</span>
        <span>状态</span>
        <span>当前角色</span>
        <span>权限修改</span>
        <span>折扣设置</span>
        <span>操作</span>
      </div>

      <div v-for="user in filteredUsers" :key="user.id" class="table-row">
        <div class="user-cell">
          <strong>{{ user.display_name }}</strong>
          <span>{{ user.username }}</span>
        </div>
        <span>{{ user.user_no || '-' }}</span>
        <ElTag size="small" :type="statusTagType(user.status)">
          {{ statusLabel(user.status) }}
        </ElTag>
        <div class="role-tags">
          <ElTag
            v-for="role in user.roles"
            :key="role"
            :type="roleTagType(role)"
            size="small"
          >
            {{ roleLabelMap[role] || role }}
          </ElTag>
        </div>
        <ElSelect
          :model-value="getEditedRoles(user)"
          multiple
          collapse-tags
          collapse-tags-tooltip
          @update:model-value="editedRoles[user.id] = $event"
        >
          <ElOption
            v-for="role in roles"
            :key="role.code"
            :label="role.name"
            :value="role.code"
          />
        </ElSelect>
        <div class="discount-editor">
          <label>
            <span>阅读</span>
            <ElSelect
              v-model="getEditedDiscounts(user).price_mode"
              class="price-mode-select"
            >
              <ElOption label="默认价格" value="default" />
              <ElOption label="折扣价格" value="discount" />
              <ElOption label="固定金额价格" value="fixed" />
            </ElSelect>
            <ElInputNumber
              v-if="getEditedDiscounts(user).price_mode === 'discount'"
              v-model="getEditedDiscounts(user).discount_rate"
              :max="1"
              :min="0.0001"
              :precision="4"
              :step="0.1"
              controls-position="right"
            />
            <ElInputNumber
              v-else
              v-model="getEditedDiscounts(user).fixed_unit_price"
              :min="0.0001"
              :precision="4"
              :step="0.001"
              controls-position="right"
            />
            <em>
              {{
                getEditedDiscounts(user).price_mode === 'default'
                  ? priceValueLabel(
                      getEditedDiscounts(user).price_mode,
                      getEditedDiscounts(user).discount_rate,
                      getEditedDiscounts(user).fixed_unit_price,
                    )
                  : getEditedDiscounts(user).price_mode === 'fixed'
                    ? priceValueLabel(
                        getEditedDiscounts(user).price_mode,
                        getEditedDiscounts(user).discount_rate,
                        getEditedDiscounts(user).fixed_unit_price,
                      )
                    : formatDiscount(getEditedDiscounts(user).discount_rate)
              }}
            </em>
          </label>
          <label>
            <span>曝光</span>
            <ElSelect
              v-model="getEditedDiscounts(user).impression_price_mode"
              class="price-mode-select"
            >
              <ElOption label="默认价格" value="default" />
              <ElOption label="折扣价格" value="discount" />
              <ElOption label="固定金额价格" value="fixed" />
            </ElSelect>
            <ElInputNumber
              v-if="getEditedDiscounts(user).impression_price_mode === 'discount'"
              v-model="getEditedDiscounts(user).impression_discount_rate"
              :max="1"
              :min="0.0001"
              :precision="4"
              :step="0.1"
              controls-position="right"
            />
            <ElInputNumber
              v-else
              v-model="getEditedDiscounts(user).impression_fixed_unit_price"
              :min="0.0001"
              :precision="4"
              :step="0.001"
              controls-position="right"
            />
            <em>
              {{
                getEditedDiscounts(user).impression_price_mode === 'default'
                  ? priceValueLabel(
                      getEditedDiscounts(user).impression_price_mode,
                      getEditedDiscounts(user).impression_discount_rate,
                      getEditedDiscounts(user).impression_fixed_unit_price,
                    )
                  : getEditedDiscounts(user).impression_price_mode === 'fixed'
                    ? priceValueLabel(
                        getEditedDiscounts(user).impression_price_mode,
                        getEditedDiscounts(user).impression_discount_rate,
                        getEditedDiscounts(user).impression_fixed_unit_price,
                      )
                    : formatDiscount(getEditedDiscounts(user).impression_discount_rate)
              }}
            </em>
          </label>
        </div>
        <div class="row-actions">
          <ElButton
            :loading="savingUserId === user.id"
            size="small"
            type="primary"
            @click="saveUserRoles(user)"
          >
            权限
          </ElButton>
          <ElButton
            :loading="discountSavingUserId === user.id"
            size="small"
            type="warning"
            @click="saveUserDiscounts(user)"
          >
            折扣
          </ElButton>
          <ElButton
            :loading="statusSavingUserId === user.id"
            :type="user.status === 'disabled' ? 'success' : 'danger'"
            plain
            size="small"
            @click="toggleUserStatus(user)"
          >
            {{ user.status === 'disabled' ? '启用' : '停用' }}
          </ElButton>
        </div>
      </div>

      <div v-if="!loading && filteredUsers.length === 0" class="empty-state">
        暂无用户
      </div>
      <div class="pagination-bar">
        <ElPagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.page_size"
          :page-sizes="[10, 20, 50, 100]"
          :total="pagination.total"
          background
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="handlePermissionPageChange"
          @size-change="handlePermissionPageSizeChange"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.permission-page {
  min-height: 100%;
  padding: 16px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-primary);
}

.permission-head,
.batch-discount-panel,
.permission-table {
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.permission-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  padding: 18px 20px;
}

.permission-head h1 {
  margin: 0 0 6px;
  font-size: 22px;
}

.permission-head p {
  margin: 0;
  color: var(--el-text-color-secondary);
}

.head-actions {
  display: grid;
  grid-template-columns: minmax(220px, 320px) auto;
  gap: 10px;
}

.batch-discount-panel {
  display: grid;
  grid-template-columns: minmax(180px, 0.8fr) minmax(360px, 1.5fr) auto auto;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  padding: 14px 16px;
}

.batch-discount-panel strong,
.batch-discount-panel span {
  display: block;
}

.batch-discount-panel span {
  margin-top: 4px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.batch-discount-editor {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.permission-table {
  overflow: hidden;
}

.table-row {
  display: grid;
  grid-template-columns: minmax(150px, 1.1fr) 110px 78px minmax(120px, 0.8fr) minmax(230px, 1.25fr) minmax(260px, 1.45fr) 178px;
  gap: 16px;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.table-header {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 13px;
  font-weight: 650;
}

.user-cell strong,
.user-cell span {
  display: block;
}

.user-cell span {
  margin-top: 2px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.role-tags,
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.row-actions {
  flex-wrap: nowrap;
}

.discount-editor {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.discount-editor label {
  display: grid;
  grid-template-columns: 34px minmax(108px, 0.9fr) minmax(96px, 0.8fr);
  gap: 6px 8px;
  align-items: center;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 7px 8px;
  background: var(--el-fill-color-blank);
}

.discount-editor span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.discount-editor :deep(.el-input-number) {
  width: 100%;
}

.discount-editor :deep(.el-input-number .el-input__inner) {
  text-align: center;
}

.price-mode-select {
  width: 100%;
}

.discount-editor em {
  grid-column: 2 / 4;
  color: var(--el-color-primary);
  font-style: normal;
  font-size: 12px;
  line-height: 1;
}

.empty-state {
  padding: 48px 16px;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding: 14px 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}

@media (max-width: 1280px) {
  .permission-head {
    align-items: stretch;
    flex-direction: column;
  }

  .batch-discount-panel {
    grid-template-columns: 1fr;
  }

  .batch-discount-editor {
    grid-template-columns: 1fr;
  }

  .table-row {
    grid-template-columns: 1fr;
  }

  .table-header {
    display: none;
  }
}
</style>
