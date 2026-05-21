<script setup lang="ts">
import type { UserApi } from '#/api';

import { computed, onMounted, reactive, ref } from 'vue';

import {
  ElButton,
  ElDialog,
  ElInput,
  ElInputNumber,
  ElMessage,
  ElOption,
  ElPagination,
  ElSelect,
  ElSwitch,
  ElTag,
} from 'element-plus';

import {
  getAdminOrderSwitchesApi,
  getAdminPermissionRolesApi,
  getAdminPermissionUsersApi,
  updateAdminOrderSwitchesApi,
  updateAdminUserBalanceApi,
  updateAdminUserDiscountsApi,
  updateAdminUserOrderTypesApi,
  updateAdminUserRolesApi,
  updateAdminUserStatusApi,
} from '#/api';
import type { OrderSwitches } from '#/api/core/user';

interface EditableDiscounts {
  discount_rate: number;
  fixed_unit_price: null | number;
  impression_discount_rate: number;
  impression_fixed_unit_price: null | number;
  impression_price_mode: 'default' | 'discount' | 'fixed' | 'quantity';
  impression_quantity_price_amount: null | number;
  impression_quantity_price_base: null | number;
  like_discount_rate: number;
  like_fixed_unit_price: null | number;
  like_price_mode: 'default' | 'discount' | 'fixed' | 'quantity';
  like_quantity_price_amount: null | number;
  like_quantity_price_base: null | number;
  price_mode: 'default' | 'discount' | 'fixed' | 'quantity';
  quantity_price_amount: null | number;
  quantity_price_base: null | number;
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
const balanceDialogVisible = ref(false);
const balanceSaving = ref(false);
const balanceTargetUser = ref<UserApi.AdminUserPermission>();
const discountDialogVisible = ref(false);
const discountTargetUser = ref<UserApi.AdminUserPermission>();
const editedRoles = reactive<Record<number, string[]>>({});
const editedDiscounts = reactive<Record<number, EditableDiscounts>>({});
const activeDiscounts = computed(() =>
  discountTargetUser.value ? getEditedDiscounts(discountTargetUser.value) : undefined,
);
const balanceForm = reactive({
  amount: 0,
  reason: '',
});
const batchDiscounts = reactive<EditableDiscounts>({
  discount_rate: 1,
  fixed_unit_price: 0.01,
  impression_discount_rate: 1,
  impression_fixed_unit_price: 0.01,
  impression_price_mode: 'default',
  impression_quantity_price_amount: 30,
  impression_quantity_price_base: 1000,
  like_discount_rate: 1,
  like_fixed_unit_price: 0.01,
  like_price_mode: 'default',
  like_quantity_price_amount: 30,
  like_quantity_price_base: 1000,
  price_mode: 'default',
  quantity_price_amount: 30,
  quantity_price_base: 1000,
});

// ─── 全局下单开关 ───
const orderSwitches = reactive<OrderSwitches>({
  impression_submit_enabled: true,
  like_submit_enabled: true,
  view_submit_enabled: true,
});
const switchLoading = reactive<Record<string, boolean>>({});

async function loadOrderSwitches() {
  try {
    const data = await getAdminOrderSwitchesApi();
    orderSwitches.view_submit_enabled = data.view_submit_enabled;
    orderSwitches.like_submit_enabled = data.like_submit_enabled;
    orderSwitches.impression_submit_enabled = data.impression_submit_enabled;
  } catch {
    // ignore
  }
}

async function toggleGlobalSwitch(key: keyof OrderSwitches) {
  const next = !orderSwitches[key];
  const label = key === 'view_submit_enabled' ? '阅读' : key === 'like_submit_enabled' ? '点赞' : '曝光';
  switchLoading[key] = true;
  try {
    const data = await updateAdminOrderSwitchesApi({ [key]: next });
    orderSwitches.view_submit_enabled = data.view_submit_enabled;
    orderSwitches.like_submit_enabled = data.like_submit_enabled;
    orderSwitches.impression_submit_enabled = data.impression_submit_enabled;
    ElMessage.success(`已${next ? '开启' : '关闭'}全局${label}下单`);
  } catch {
    ElMessage.error('更新失败');
  } finally {
    switchLoading[key] = false;
  }
}

const filteredUsers = users;

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
  quantityBase?: null | number,
  quantityAmount?: null | number,
) {
  if (mode === 'discount') {
    return formatDiscount(discountRate);
  }
  if (mode === 'quantity') {
    return `${Number(quantityBase) || 0} 个 / ${formatMoney(Number(quantityAmount) || 0)}`;
  }
  if (mode === 'default') {
    const price = Number(fixedPrice) > 0 ? formatMoney(fixedPrice) : '系统默认';
    return `${price}/单`;
  }
  return `${formatMoney(Number(fixedPrice) || 0)} / 单`;
}

function viewPriceLabel(discounts: EditableDiscounts) {
  return priceValueLabel(
    discounts.price_mode,
    discounts.discount_rate,
    discounts.fixed_unit_price,
    discounts.quantity_price_base,
    discounts.quantity_price_amount,
  );
}

function impressionPriceLabel(discounts: EditableDiscounts) {
  return priceValueLabel(
    discounts.impression_price_mode,
    discounts.impression_discount_rate,
    discounts.impression_fixed_unit_price,
    discounts.impression_quantity_price_base,
    discounts.impression_quantity_price_amount,
  );
}

function likePriceLabel(discounts: EditableDiscounts) {
  return priceValueLabel(
    discounts.like_price_mode,
    discounts.like_discount_rate,
    discounts.like_fixed_unit_price,
    discounts.like_quantity_price_base,
    discounts.like_quantity_price_amount,
  );
}
function createEditableDiscounts(user: UserApi.AdminUserPermission): EditableDiscounts {
  return {
    discount_rate: Number(user.discount_rate) || 1,
    fixed_unit_price: user.fixed_unit_price ?? null,
    impression_discount_rate: Number(user.impression_discount_rate) || 1,
    impression_fixed_unit_price: user.impression_fixed_unit_price ?? null,
    impression_quantity_price_amount: user.impression_quantity_price_amount ?? 30,
    impression_quantity_price_base: user.impression_quantity_price_base ?? 1000,
    impression_price_mode: user.impression_price_mode || 'discount',
    like_discount_rate: Number(user.like_discount_rate ?? user.discount_rate) || 1,
    like_fixed_unit_price: user.like_fixed_unit_price ?? user.fixed_unit_price ?? null,
    like_price_mode: user.like_price_mode || user.price_mode || 'discount',
    like_quantity_price_amount:
      user.like_quantity_price_amount ?? user.quantity_price_amount ?? 30,
    like_quantity_price_base: user.like_quantity_price_base ?? user.quantity_price_base ?? 1000,
    quantity_price_amount: user.quantity_price_amount ?? 30,
    quantity_price_base: user.quantity_price_base ?? 1000,
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

function formatMoney(value: number) {
  return `￥ ${Number(value || 0).toFixed(2)}`;
}

function openBalanceDialog(user: UserApi.AdminUserPermission) {
  balanceTargetUser.value = user;
  balanceForm.amount = Number(user.available_amount) || 0;
  balanceForm.reason = '';
  balanceDialogVisible.value = true;
}

function openDiscountDialog(user: UserApi.AdminUserPermission) {
  discountTargetUser.value = user;
  getEditedDiscounts(user);
  discountDialogVisible.value = true;
}

function validateDiscounts(discounts: EditableDiscounts) {
  if (discounts.price_mode === 'fixed' && !Number(discounts.fixed_unit_price)) {
    ElMessage.warning('请填写阅读固定金额');
    return false;
  }
  if (
    discounts.price_mode === 'quantity' &&
    (!Number(discounts.quantity_price_base) || !Number(discounts.quantity_price_amount))
  ) {
    ElMessage.warning('请填写阅读按数量计价的数量和金额');
    return false;
  }
  if (
    discounts.impression_price_mode === 'fixed' &&
    !Number(discounts.impression_fixed_unit_price)
  ) {
    ElMessage.warning('请填写曝光固定金额');
    return false;
  }
  if (
    discounts.impression_price_mode === 'quantity' &&
    (!Number(discounts.impression_quantity_price_base) ||
      !Number(discounts.impression_quantity_price_amount))
  ) {
    ElMessage.warning('请填写曝光按数量计价的数量和金额');
    return false;
  }
  if (discounts.like_price_mode === 'fixed' && !Number(discounts.like_fixed_unit_price)) {
    ElMessage.warning('请填写点赞固定金额');
    return false;
  }
  if (
    discounts.like_price_mode === 'quantity' &&
    (!Number(discounts.like_quantity_price_base) || !Number(discounts.like_quantity_price_amount))
  ) {
    ElMessage.warning('请填写点赞按数量计价的数量和金额');
    return false;
  }
  return true;
}

async function saveUserBalance() {
  const targetUser = balanceTargetUser.value;
  const amount = Number(balanceForm.amount);
  if (!targetUser) {
    return;
  }
  if (!Number.isFinite(amount) || amount < 0) {
    ElMessage.warning('请输入正确的余额');
    return;
  }

  balanceSaving.value = true;
  try {
    await updateAdminUserBalanceApi(targetUser.id, {
      amount,
      reason: balanceForm.reason || '管理员修改余额',
    });
    ElMessage.success('余额已更新');
    balanceDialogVisible.value = false;
    await loadData();
  } catch {
    ElMessage.error('余额更新失败');
  } finally {
    balanceSaving.value = false;
  }
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
  if (!validateDiscounts(discounts)) {
    return;
  }
  discountSavingUserId.value = user.id;
  try {
    await updateAdminUserDiscountsApi(user.id, discounts);
    ElMessage.success('折扣单价已保存');
    discountDialogVisible.value = false;
    await loadData();
  } catch {
    ElMessage.error('折扣单价保存失败，请检查输入');
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
      impression_quantity_price_amount: batchDiscounts.impression_quantity_price_amount,
      impression_quantity_price_base: batchDiscounts.impression_quantity_price_base,
      impression_price_mode: batchDiscounts.impression_price_mode,
      like_discount_rate: batchDiscounts.like_discount_rate,
      like_fixed_unit_price: batchDiscounts.like_fixed_unit_price,
      like_price_mode: batchDiscounts.like_price_mode,
      like_quantity_price_amount: batchDiscounts.like_quantity_price_amount,
      like_quantity_price_base: batchDiscounts.like_quantity_price_base,
      quantity_price_amount: batchDiscounts.quantity_price_amount,
      quantity_price_base: batchDiscounts.quantity_price_base,
      price_mode: batchDiscounts.price_mode,
    };
  }
  ElMessage.success(`已填入 ${filteredUsers.value.length} 个用户`);
}

async function saveAllDiscounts() {
  for (const user of filteredUsers.value) {
    if (!validateDiscounts(getEditedDiscounts(user))) {
      return;
    }
  }
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

const orderTypeSavingUserId = ref<number>();

async function toggleOrderType(
  user: UserApi.AdminUserPermission,
  field: 'order_impression_enabled' | 'order_like_enabled' | 'order_view_enabled',
) {
  const next = !user[field];
  orderTypeSavingUserId.value = user.id;
  try {
    await updateAdminUserOrderTypesApi(user.id, {
      order_impression_enabled: field === 'order_impression_enabled' ? next : user.order_impression_enabled,
      order_like_enabled: field === 'order_like_enabled' ? next : user.order_like_enabled,
      order_view_enabled: field === 'order_view_enabled' ? next : user.order_view_enabled,
    });
    user[field] = next;
    ElMessage.success(`已${next ? '启用' : '禁用'}${field === 'order_view_enabled' ? '阅读' : field === 'order_like_enabled' ? '点赞' : '曝光'}下单`);
  } catch {
    ElMessage.error('更新失败');
  } finally {
    orderTypeSavingUserId.value = undefined;
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

onMounted(() => {
  loadData();
  loadOrderSwitches();
});
</script>

<template>
  <div class="permission-page">
    <section class="permission-head">
      <div class="head-text">
        <span class="eyebrow">Permission</span>
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
        <button class="head-btn" :disabled="loading" @click="searchUsers">
          {{ loading ? '搜索中…' : '搜索' }}
        </button>
      </div>
    </section>

    <section class="global-switch-panel">
      <div class="gs-head">
        <div class="gs-desc">
          <strong>全局下单开关</strong>
          <span>关闭后，所有用户将无法提交对应类型的订单。</span>
        </div>
      </div>
      <div class="gs-switches">
        <div class="gs-item">
          <div class="gs-label">
            <span class="gs-tag gs-tag--view">阅读</span>
            <span class="gs-status" :class="{ 'gs-status--off': !orderSwitches.view_submit_enabled }">
              {{ orderSwitches.view_submit_enabled ? '已开启' : '已关闭' }}
            </span>
          </div>
          <ElSwitch
            :model-value="orderSwitches.view_submit_enabled"
            :loading="!!switchLoading['view_submit_enabled']"
            @change="toggleGlobalSwitch('view_submit_enabled')"
          />
        </div>
        <div class="gs-item">
          <div class="gs-label">
            <span class="gs-tag gs-tag--like">点赞</span>
            <span class="gs-status" :class="{ 'gs-status--off': !orderSwitches.like_submit_enabled }">
              {{ orderSwitches.like_submit_enabled ? '已开启' : '已关闭' }}
            </span>
          </div>
          <ElSwitch
            :model-value="orderSwitches.like_submit_enabled"
            :loading="!!switchLoading['like_submit_enabled']"
            @change="toggleGlobalSwitch('like_submit_enabled')"
          />
        </div>
        <div class="gs-item">
          <div class="gs-label">
            <span class="gs-tag gs-tag--impression">曝光</span>
            <span class="gs-status" :class="{ 'gs-status--off': !orderSwitches.impression_submit_enabled }">
              {{ orderSwitches.impression_submit_enabled ? '已开启' : '已关闭' }}
            </span>
          </div>
          <ElSwitch
            :model-value="orderSwitches.impression_submit_enabled"
            :loading="!!switchLoading['impression_submit_enabled']"
            @change="toggleGlobalSwitch('impression_submit_enabled')"
          />
        </div>
      </div>
    </section>

    <section class="batch-discount-panel">
      <div class="batch-top">
        <div class="batch-desc">
          <strong>批量填入折扣设置</strong>
          <span>选择模式和数值后，一键填入当前列表所有用户。</span>
        </div>
        <div class="batch-btns">
          <button class="bd-btn bd-btn--primary" @click="applyBatchDiscounts">一键填入</button>
          <button class="bd-btn bd-btn--warning" :disabled="batchDiscountSaving" @click="saveAllDiscounts">
            {{ batchDiscountSaving ? '保存中…' : '一键保存' }}
          </button>
        </div>
      </div>
      <div class="batch-cards">
        <div class="batch-card">
          <div class="bc-head"><span class="bc-tag">阅读</span><em>{{ viewPriceLabel(batchDiscounts) }}</em></div>
          <ElSelect v-model="batchDiscounts.price_mode" class="price-mode-select">
            <ElOption label="默认价格" value="default" />
            <ElOption label="折扣价格" value="discount" />
            <ElOption label="固定金额" value="fixed" />
            <ElOption label="按数量计价" value="quantity" />
          </ElSelect>
          <ElInputNumber
            v-if="batchDiscounts.price_mode === 'default'"
            v-model="batchDiscounts.fixed_unit_price"
            :min="0.0001" :precision="4" :step="0.01" controls-position="right"
          />
          <ElInputNumber
            v-else-if="batchDiscounts.price_mode === 'discount'"
            v-model="batchDiscounts.discount_rate"
            :max="1" :min="0.0001" :precision="4" :step="0.1" controls-position="right"
          />
          <ElInputNumber
            v-else-if="batchDiscounts.price_mode === 'fixed'"
            v-model="batchDiscounts.fixed_unit_price"
            :min="0.0001" :precision="4" :step="0.001" controls-position="right"
          />
          <div v-else-if="batchDiscounts.price_mode === 'quantity'" class="quantity-mini-inputs">
            <ElInputNumber v-model="batchDiscounts.quantity_price_base" :min="1" :precision="0" :step="100" controls-position="right" />
            <ElInputNumber v-model="batchDiscounts.quantity_price_amount" :min="0.0001" :precision="4" :step="1" controls-position="right" />
          </div>
        </div>
        <div class="batch-card">
          <div class="bc-head"><span class="bc-tag">点赞</span><em>{{ likePriceLabel(batchDiscounts) }}</em></div>
          <ElSelect v-model="batchDiscounts.like_price_mode" class="price-mode-select">
            <ElOption label="默认价格" value="default" />
            <ElOption label="折扣价格" value="discount" />
            <ElOption label="固定金额" value="fixed" />
            <ElOption label="按数量计价" value="quantity" />
          </ElSelect>
          <ElInputNumber
            v-if="batchDiscounts.like_price_mode === 'default'"
            v-model="batchDiscounts.like_fixed_unit_price"
            :min="0.0001" :precision="4" :step="0.01" controls-position="right"
          />
          <ElInputNumber
            v-else-if="batchDiscounts.like_price_mode === 'discount'"
            v-model="batchDiscounts.like_discount_rate"
            :max="1" :min="0.0001" :precision="4" :step="0.1" controls-position="right"
          />
          <ElInputNumber
            v-else-if="batchDiscounts.like_price_mode === 'fixed'"
            v-model="batchDiscounts.like_fixed_unit_price"
            :min="0.0001" :precision="4" :step="0.001" controls-position="right"
          />
          <div v-else-if="batchDiscounts.like_price_mode === 'quantity'" class="quantity-mini-inputs">
            <ElInputNumber v-model="batchDiscounts.like_quantity_price_base" :min="1" :precision="0" :step="100" controls-position="right" />
            <ElInputNumber v-model="batchDiscounts.like_quantity_price_amount" :min="0.0001" :precision="4" :step="1" controls-position="right" />
          </div>
        </div>
        <div class="batch-card">
          <div class="bc-head"><span class="bc-tag">曝光</span><em>{{ impressionPriceLabel(batchDiscounts) }}</em></div>
          <ElSelect v-model="batchDiscounts.impression_price_mode" class="price-mode-select">
            <ElOption label="默认价格" value="default" />
            <ElOption label="折扣价格" value="discount" />
            <ElOption label="固定金额" value="fixed" />
            <ElOption label="按数量计价" value="quantity" />
          </ElSelect>
          <ElInputNumber
            v-if="batchDiscounts.impression_price_mode === 'default'"
            v-model="batchDiscounts.impression_fixed_unit_price"
            :min="0.0001" :precision="4" :step="0.01" controls-position="right"
          />
          <ElInputNumber
            v-else-if="batchDiscounts.impression_price_mode === 'discount'"
            v-model="batchDiscounts.impression_discount_rate"
            :max="1" :min="0.0001" :precision="4" :step="0.1" controls-position="right"
          />
          <ElInputNumber
            v-else-if="batchDiscounts.impression_price_mode === 'fixed'"
            v-model="batchDiscounts.impression_fixed_unit_price"
            :min="0.0001" :precision="4" :step="0.001" controls-position="right"
          />
          <div v-else-if="batchDiscounts.impression_price_mode === 'quantity'" class="quantity-mini-inputs">
            <ElInputNumber v-model="batchDiscounts.impression_quantity_price_base" :min="1" :precision="0" :step="100" controls-position="right" />
            <ElInputNumber v-model="batchDiscounts.impression_quantity_price_amount" :min="0.0001" :precision="4" :step="1" controls-position="right" />
          </div>
        </div>
      </div>
    </section>

    <section class="permission-table" v-loading="loading">
      <div class="table-row table-header">
        <span>用户</span>
        <span>账号编号</span>
        <span>状态</span>
        <span>余额</span>
        <span>当前角色 / 权限修改</span>
        <span>折扣设置</span>
        <span>下单权限</span>
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
        <strong class="balance-text">{{ formatMoney(user.available_amount) }}</strong>
        <ElSelect
          :model-value="getEditedRoles(user)"
          multiple
          @update:model-value="editedRoles[user.id] = $event"
        >
          <ElOption
            v-for="role in roles"
            :key="role.code"
            :label="role.name"
            :value="role.code"
          />
        </ElSelect>
        <div class="discount-summary">
          <span>
            <b>阅读</b>
            {{ viewPriceLabel(getEditedDiscounts(user)) }}
          </span>
          <span>
            <b>点赞</b>
            {{ likePriceLabel(getEditedDiscounts(user)) }}
          </span>
          <span>
            <b>曝光</b>
            {{ impressionPriceLabel(getEditedDiscounts(user)) }}
          </span>
        </div>
        <div class="order-type-switches">
          <label>
            <span>阅读</span>
            <ElSwitch
              :model-value="user.order_view_enabled"
              :loading="orderTypeSavingUserId === user.id"
              size="small"
              @change="toggleOrderType(user, 'order_view_enabled')"
            />
          </label>
          <label>
            <span>点赞</span>
            <ElSwitch
              :model-value="user.order_like_enabled"
              :loading="orderTypeSavingUserId === user.id"
              size="small"
              @change="toggleOrderType(user, 'order_like_enabled')"
            />
          </label>
          <label>
            <span>曝光</span>
            <ElSwitch
              :model-value="user.order_impression_enabled"
              :loading="orderTypeSavingUserId === user.id"
              size="small"
              @change="toggleOrderType(user, 'order_impression_enabled')"
            />
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
            @click="openDiscountDialog(user)"
          >
            折扣
          </ElButton>
          <ElButton size="small" type="primary" plain @click="openBalanceDialog(user)">
            余额
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

    <ElDialog
      v-model="discountDialogVisible"
      title="折扣单价设置"
      width="560px"
      destroy-on-close
    >
      <div v-if="discountTargetUser && activeDiscounts" class="discount-dialog-body">
        <div class="discount-user">
          <strong>{{ discountTargetUser.display_name }}</strong>
          <span>{{ discountTargetUser.username }} / {{ discountTargetUser.user_no || '-' }}</span>
        </div>

        <section class="price-form-section">
          <div class="section-title">
            <strong>阅读单价</strong>
            <span>{{ viewPriceLabel(activeDiscounts) }}</span>
          </div>
          <label>
            <span>计价模式</span>
            <ElSelect v-model="activeDiscounts.price_mode">
              <ElOption label="默认价格" value="default" />
              <ElOption label="折扣价格" value="discount" />
              <ElOption label="固定金额" value="fixed" />
              <ElOption label="按数量计价" value="quantity" />
            </ElSelect>
          </label>
          <label v-if="activeDiscounts.price_mode === 'default'">
            <span>默认单价</span>
            <ElInputNumber
              v-model="activeDiscounts.fixed_unit_price"
              :min="0.0001"
              :precision="4"
              :step="0.01"
              controls-position="right"
            />
          </label>
          <label v-if="activeDiscounts.price_mode === 'discount'">
            <span>折扣</span>
            <ElInputNumber
              v-model="activeDiscounts.discount_rate"
              :max="1"
              :min="0.0001"
              :precision="4"
              :step="0.1"
              controls-position="right"
            />
          </label>
          <label v-else-if="activeDiscounts.price_mode === 'fixed'">
            <span>单笔金额</span>
            <ElInputNumber
              v-model="activeDiscounts.fixed_unit_price"
              :min="0.0001"
              :precision="4"
              :step="0.001"
              controls-position="right"
            />
          </label>
          <div v-else-if="activeDiscounts.price_mode === 'quantity'" class="quantity-price-inputs">
            <label>
              <span>数量基数</span>
              <ElInputNumber
                v-model="activeDiscounts.quantity_price_base"
                :min="1"
                :precision="0"
                :step="100"
                controls-position="right"
              />
            </label>
            <label>
              <span>基数金额</span>
              <ElInputNumber
                v-model="activeDiscounts.quantity_price_amount"
                :min="0.0001"
                :precision="4"
                :step="1"
                controls-position="right"
              />
            </label>
          </div>
        </section>


        <section class="price-form-section">
          <div class="section-title">
            <strong>点赞单价</strong>
            <span>{{ likePriceLabel(activeDiscounts) }}</span>
          </div>
          <label>
            <span>计价模式</span>
            <ElSelect v-model="activeDiscounts.like_price_mode">
              <ElOption label="默认价格" value="default" />
              <ElOption label="折扣价格" value="discount" />
              <ElOption label="固定金额" value="fixed" />
              <ElOption label="按数量计价" value="quantity" />
            </ElSelect>
          </label>
          <label v-if="activeDiscounts.like_price_mode === 'default'">
            <span>默认单价</span>
            <ElInputNumber
              v-model="activeDiscounts.like_fixed_unit_price"
              :min="0.0001"
              :precision="4"
              :step="0.01"
              controls-position="right"
            />
          </label>
          <label v-if="activeDiscounts.like_price_mode === 'discount'">
            <span>折扣</span>
            <ElInputNumber
              v-model="activeDiscounts.like_discount_rate"
              :max="1"
              :min="0.0001"
              :precision="4"
              :step="0.1"
              controls-position="right"
            />
          </label>
          <label v-else-if="activeDiscounts.like_price_mode === 'fixed'">
            <span>单笔金额</span>
            <ElInputNumber
              v-model="activeDiscounts.like_fixed_unit_price"
              :min="0.0001"
              :precision="4"
              :step="0.001"
              controls-position="right"
            />
          </label>
          <div v-else-if="activeDiscounts.like_price_mode === 'quantity'" class="quantity-price-inputs">
            <label>
              <span>数量基数</span>
              <ElInputNumber
                v-model="activeDiscounts.like_quantity_price_base"
                :min="1"
                :precision="0"
                :step="100"
                controls-position="right"
              />
            </label>
            <label>
              <span>基数金额</span>
              <ElInputNumber
                v-model="activeDiscounts.like_quantity_price_amount"
                :min="0.0001"
                :precision="4"
                :step="1"
                controls-position="right"
              />
            </label>
          </div>
        </section>
        <section class="price-form-section">
          <div class="section-title">
            <strong>曝光单价</strong>
            <span>{{ impressionPriceLabel(activeDiscounts) }}</span>
          </div>
          <label>
            <span>计价模式</span>
            <ElSelect v-model="activeDiscounts.impression_price_mode">
              <ElOption label="默认价格" value="default" />
              <ElOption label="折扣价格" value="discount" />
              <ElOption label="固定金额" value="fixed" />
              <ElOption label="按数量计价" value="quantity" />
            </ElSelect>
          </label>
          <label v-if="activeDiscounts.impression_price_mode === 'default'">
            <span>默认单价</span>
            <ElInputNumber
              v-model="activeDiscounts.impression_fixed_unit_price"
              :min="0.0001"
              :precision="4"
              :step="0.01"
              controls-position="right"
            />
          </label>
          <label v-if="activeDiscounts.impression_price_mode === 'discount'">
            <span>折扣</span>
            <ElInputNumber
              v-model="activeDiscounts.impression_discount_rate"
              :max="1"
              :min="0.0001"
              :precision="4"
              :step="0.1"
              controls-position="right"
            />
          </label>
          <label v-else-if="activeDiscounts.impression_price_mode === 'fixed'">
            <span>单笔金额</span>
            <ElInputNumber
              v-model="activeDiscounts.impression_fixed_unit_price"
              :min="0.0001"
              :precision="4"
              :step="0.001"
              controls-position="right"
            />
          </label>
          <div
            v-else-if="activeDiscounts.impression_price_mode === 'quantity'"
            class="quantity-price-inputs"
          >
            <label>
              <span>数量基数</span>
              <ElInputNumber
                v-model="activeDiscounts.impression_quantity_price_base"
                :min="1"
                :precision="0"
                :step="100"
                controls-position="right"
              />
            </label>
            <label>
              <span>基数金额</span>
              <ElInputNumber
                v-model="activeDiscounts.impression_quantity_price_amount"
                :min="0.0001"
                :precision="4"
                :step="1"
                controls-position="right"
              />
            </label>
          </div>
        </section>
      </div>
      <template #footer>
        <ElButton @click="discountDialogVisible = false">取消</ElButton>
        <ElButton
          :loading="discountSavingUserId === discountTargetUser?.id"
          type="primary"
          @click="discountTargetUser && saveUserDiscounts(discountTargetUser)"
        >
          保存
        </ElButton>
      </template>
    </ElDialog>

    <ElDialog v-model="balanceDialogVisible" title="修改余额" width="420px">
      <div class="balance-dialog-body">
        <div class="balance-user">
          <strong>{{ balanceTargetUser?.display_name }}</strong>
          <span>
            {{ balanceTargetUser?.username }} / 当前
            {{ formatMoney(balanceTargetUser?.available_amount || 0) }}
          </span>
        </div>
        <label>
          <span>新余额</span>
          <ElInputNumber
            v-model="balanceForm.amount"
            :min="0"
            :precision="2"
            :step="10"
            class="balance-input"
            controls-position="right"
          />
        </label>
        <label>
          <span>备注</span>
          <ElInput v-model="balanceForm.reason" placeholder="管理员修改余额" />
        </label>
      </div>
      <template #footer>
        <ElButton @click="balanceDialogVisible = false">取消</ElButton>
        <ElButton :loading="balanceSaving" type="primary" @click="saveUserBalance">
          保存
        </ElButton>
      </template>
    </ElDialog>
  </div>
</template>

<style scoped>
.permission-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 20px;
  color: var(--el-text-color-primary);
}

/* ---- header ---- */
.permission-head {
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

.permission-head h1 {
  margin: 2px 0 0;
  font-size: 22px;
  font-weight: 700;
}

.permission-head p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.head-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

.head-actions :deep(.el-input) {
  width: 260px;
}

.head-btn {
  padding: 8px 20px;
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 8px;
  background: var(--el-color-primary);
  color: #fff;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.head-btn:hover:not(:disabled) {
  background: var(--el-color-primary-light-3);
  box-shadow: 0 4px 12px rgba(64, 158, 255, 0.35);
}

.head-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* ---- global switch ---- */
.global-switch-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.gs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.gs-desc strong {
  font-size: 15px;
}

.gs-desc span {
  display: block;
  margin-top: 3px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.gs-switches {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.gs-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
  transition: border-color 0.2s;
}

.gs-item:hover {
  border-color: var(--el-color-primary-light-5);
}

.gs-label {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gs-tag {
  padding: 3px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
}

.gs-tag--view {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}

.gs-tag--like {
  background: var(--el-color-danger-light-8);
  color: var(--el-color-danger);
}

.gs-tag--impression {
  background: var(--el-color-warning-light-8);
  color: var(--el-color-warning);
}

.gs-status {
  font-size: 12px;
  color: var(--el-color-success);
  font-weight: 500;
}

.gs-status--off {
  color: var(--el-color-danger);
}

/* ---- batch discount ---- */
.batch-discount-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.batch-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.batch-desc strong {
  font-size: 15px;
}

.batch-desc span {
  display: block;
  margin-top: 3px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.batch-btns {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.bd-btn {
  padding: 8px 20px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.bd-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.bd-btn--primary {
  background: var(--el-color-primary);
  color: #fff;
}

.bd-btn--primary:hover:not(:disabled) {
  background: var(--el-color-primary-light-3);
  box-shadow: 0 3px 10px rgba(64, 158, 255, 0.35);
}

.bd-btn--warning {
  background: var(--el-color-warning);
  color: #fff;
}

.bd-btn--warning:hover:not(:disabled) {
  background: var(--el-color-warning-light-3);
  box-shadow: 0 3px 10px rgba(230, 162, 60, 0.35);
}

.batch-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.batch-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
}

.bc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.bc-tag {
  padding: 2px 10px;
  border-radius: 6px;
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
  font-size: 12px;
  font-weight: 600;
}

.bc-head em {
  font-style: normal;
  font-size: 12px;
  font-family: Consolas, monospace;
  color: var(--el-color-primary);
}

.batch-card :deep(.el-select),
.batch-card :deep(.el-input-number) {
  width: 100%;
}

.batch-card :deep(.el-input-number .el-input__inner) {
  text-align: center;
}

/* ---- user table ---- */
.permission-table {
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
  overflow: hidden;
}

.table-row {
  display: grid;
  grid-template-columns: minmax(110px, 0.7fr) 96px 72px 100px minmax(220px, 1.05fr) minmax(180px, 0.8fr) 160px 184px;
  gap: 10px;
  align-items: center;
  padding: 14px 18px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  transition: background 0.15s;
}

.table-row:not(.table-header):hover {
  background: var(--el-fill-color-lighter);
}

.table-row > * {
  min-width: 0;
}

.table-header {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.user-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.user-cell strong {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-cell span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.balance-text {
  font-family: Consolas, monospace;
  font-size: 14px;
  color: var(--el-color-primary);
  white-space: nowrap;
}

/* ---- row actions ---- */
.row-actions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  justify-content: start;
}

.row-actions :deep(.el-button) {
  margin-left: 0;
  width: 100%;
  padding-inline: 0;
  font-size: 12px;
}

/* ---- switches ---- */
.order-type-switches {
  display: grid;
  gap: 4px;
}

.order-type-switches label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

/* ---- discount summary ---- */
.discount-summary {
  display: grid;
  gap: 4px;
}

.discount-summary span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
  font-size: 12px;
  font-family: Consolas, monospace;
}

.discount-summary b {
  color: var(--el-text-color-secondary);
  font-weight: 500;
  font-family: inherit;
}

/* ---- batch discount editor ---- */
.discount-editor {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.discount-editor label {
  display: grid;
  grid-template-columns: 34px minmax(92px, 0.9fr) minmax(84px, 0.8fr);
  gap: 6px 8px;
  align-items: center;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 7px 8px;
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

.quantity-mini-inputs {
  display: grid;
  grid-template-columns: repeat(2, minmax(72px, 1fr));
  gap: 6px;
  min-width: 0;
}

/* ---- dialogs ---- */
.discount-dialog-body {
  display: grid;
  gap: 14px;
}

.discount-user,
.price-form-section {
  display: grid;
  gap: 10px;
}

.discount-user {
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
}

.discount-user span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.price-form-section {
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.section-title strong {
  padding-left: 8px;
  border-left: 3px solid var(--el-color-primary);
}

.section-title span {
  color: var(--el-color-primary);
  font-size: 13px;
  font-family: Consolas, monospace;
}

.price-form-section label,
.quantity-price-inputs {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}

.price-form-section label span {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.price-form-section :deep(.el-input-number) {
  width: 100%;
}

.quantity-price-inputs {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.quantity-price-inputs label {
  grid-template-columns: 70px minmax(0, 1fr);
}

.empty-state {
  padding: 60px 16px;
  color: var(--el-text-color-secondary);
  text-align: center;
  font-size: 14px;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  padding: 14px 18px;
}

.balance-dialog-body {
  display: grid;
  gap: 14px;
}

.balance-dialog-body label,
.balance-user {
  display: grid;
  gap: 6px;
}

.balance-dialog-body label span,
.balance-user span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.balance-input {
  width: 100%;
}

/* ---- responsive ---- */
@media (max-width: 1280px) {
  .permission-head {
    align-items: stretch;
    flex-direction: column;
  }

  .head-actions {
    flex-direction: column;
  }

  .head-actions :deep(.el-input) {
    width: 100%;
  }

  .gs-switches {
    grid-template-columns: 1fr;
  }

  .batch-cards {
    grid-template-columns: 1fr;
  }

  .batch-top {
    flex-direction: column;
    align-items: stretch;
  }

  .table-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .table-header {
    display: none;
  }
}
</style>
