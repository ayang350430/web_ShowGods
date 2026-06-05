<script setup lang="ts">
import type { UserApi } from '#/api';

import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';

import {
  ElAvatar,
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
  getPasswordResetRequestsApi,
  handlePasswordResetRequestApi,
  updateAdminOrderSwitchesApi,
  updateAdminUserBalanceApi,
  updateAdminUserDiscountsApi,
  updateAdminUserOrderTypesApi,
  updateAdminUserRolesApi,
  updateAdminUserStatusApi,
} from '#/api';
import type { OrderSwitches, PasswordResetRequest } from '#/api/core/user';

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
const userPanelRef = ref<HTMLElement>();
const userListInView = ref(false);
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

function userInitial(user: UserApi.AdminUserPermission) {
  const name = user.display_name?.trim() || user.username?.trim() || '?';
  return name[0]?.toUpperCase() || '?';
}

function userAvatarColor(userId: number) {
  const palette = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#626aef', '#909399'];
  return palette[userId % palette.length];
}

function openBalanceDialog(user: UserApi.AdminUserPermission) {
  balanceTargetUser.value = user;
  balanceForm.amount = 0;
  balanceForm.reason = '';
  balanceDialogVisible.value = true;
}

const balancePreview = computed(() => {
  const current = Number(balanceTargetUser.value?.available_amount) || 0;
  const delta = Number(balanceForm.amount) || 0;
  return Math.round((current + delta) * 100) / 100;
});

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
  if (!Number.isFinite(amount) || amount === 0) {
    ElMessage.warning('请输入调整金额（正数增加，负数减少）');
    return;
  }
  const currentBalance = Number(targetUser.available_amount) || 0;
  const newBalance = Math.round((currentBalance + amount) * 100) / 100;
  if (newBalance < 0) {
    ElMessage.warning(`余额不足，当前 ${currentBalance}，调整后为 ${newBalance}`);
    return;
  }

  balanceSaving.value = true;
  try {
    await updateAdminUserBalanceApi(targetUser.id, {
      amount: newBalance,
      reason: balanceForm.reason || `管理员调整余额 ${amount > 0 ? '+' : ''}${amount}`,
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

// ---- 密码重置申请管理 ----
const resetRequestsRaw = ref<PasswordResetRequest[]>([]);
const resetRequests = computed(() => resetRequestsRaw.value.filter((r) => r.status === 'pending'));
const resetLoading = ref(false);
const resetDialogVisible = ref(false);
const resetHandlingId = ref<number>();
const resetTargetRequest = ref<PasswordResetRequest>();
const resetNewPassword = ref('');

async function loadResetRequests() {
  resetLoading.value = true;
  try {
    resetRequestsRaw.value = await getPasswordResetRequestsApi();
  } catch {
    // silent
  } finally {
    resetLoading.value = false;
  }
}

function openResetDialog(req: PasswordResetRequest) {
  resetTargetRequest.value = req;
  resetNewPassword.value = '';
  resetDialogVisible.value = true;
}

async function approveReset() {
  if (!resetTargetRequest.value) return;
  if (!resetNewPassword.value || resetNewPassword.value.length < 6) {
    ElMessage.warning('新密码至少 6 位');
    return;
  }
  resetHandlingId.value = resetTargetRequest.value.id;
  try {
    await handlePasswordResetRequestApi(resetTargetRequest.value.id, {
      action: 'approve',
      newPassword: resetNewPassword.value,
    });
    ElMessage.success('密码已重置');
    resetDialogVisible.value = false;
    await loadResetRequests();
  } catch (error: any) {
    ElMessage.error(error?.message || '操作失败');
  } finally {
    resetHandlingId.value = undefined;
  }
}

async function rejectReset(req: PasswordResetRequest) {
  resetHandlingId.value = req.id;
  try {
    await handlePasswordResetRequestApi(req.id, { action: 'reject' });
    ElMessage.success('已拒绝');
    await loadResetRequests();
  } catch (error: any) {
    ElMessage.error(error?.message || '操作失败');
  } finally {
    resetHandlingId.value = undefined;
  }
}

function resetStatusLabel(status: string) {
  const map: Record<string, string> = { approved: '已重置', pending: '待处理', rejected: '已拒绝' };
  return map[status] || status;
}

function resetStatusType(status: string) {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'info';
  return 'warning';
}

function formatTime(value?: null | string) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const showScrollHint = computed(
  () => pagination.total > 0 && !userListInView.value,
);

function scrollToUserList() {
  userPanelRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let userListObserver: IntersectionObserver | undefined;

onMounted(() => {
  loadData();
  loadOrderSwitches();
  loadResetRequests();

  void nextTick(() => {
    userListObserver = new IntersectionObserver(
      ([entry]) => {
        userListInView.value = Boolean(entry?.isIntersecting);
      },
      { root: null, rootMargin: '-80px 0px 0px 0px', threshold: 0.08 },
    );
    if (userPanelRef.value) {
      userListObserver.observe(userPanelRef.value);
    }
  });
});

onUnmounted(() => {
  userListObserver?.disconnect();
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

    <section class="control-deck">
      <div class="deck-row deck-row--switches">
        <div class="deck-title">
          <strong>全局下单开关</strong>
          <span>关闭后所有用户无法提交对应类型订单</span>
        </div>
        <div class="switch-pills">
          <div class="switch-pill">
            <span class="pill-tag pill-tag--view">阅读</span>
            <span class="pill-state" :class="{ 'pill-state--off': !orderSwitches.view_submit_enabled }">
              {{ orderSwitches.view_submit_enabled ? '开' : '关' }}
            </span>
            <ElSwitch
              :model-value="orderSwitches.view_submit_enabled"
              :loading="!!switchLoading['view_submit_enabled']"
              size="small"
              @change="toggleGlobalSwitch('view_submit_enabled')"
            />
          </div>
          <div class="switch-pill">
            <span class="pill-tag pill-tag--like">点赞</span>
            <span class="pill-state" :class="{ 'pill-state--off': !orderSwitches.like_submit_enabled }">
              {{ orderSwitches.like_submit_enabled ? '开' : '关' }}
            </span>
            <ElSwitch
              :model-value="orderSwitches.like_submit_enabled"
              :loading="!!switchLoading['like_submit_enabled']"
              size="small"
              @change="toggleGlobalSwitch('like_submit_enabled')"
            />
          </div>
          <div class="switch-pill">
            <span class="pill-tag pill-tag--impression">曝光</span>
            <span class="pill-state" :class="{ 'pill-state--off': !orderSwitches.impression_submit_enabled }">
              {{ orderSwitches.impression_submit_enabled ? '开' : '关' }}
            </span>
            <ElSwitch
              :model-value="orderSwitches.impression_submit_enabled"
              :loading="!!switchLoading['impression_submit_enabled']"
              size="small"
              @change="toggleGlobalSwitch('impression_submit_enabled')"
            />
          </div>
        </div>
      </div>

      <details class="batch-details">
        <summary class="batch-details-summary">
          <div class="deck-title">
            <strong>批量填入折扣设置</strong>
            <span>选择模式和数值后，一键填入当前列表所有用户</span>
          </div>
          <div class="batch-btns" @click.stop>
            <button class="bd-btn bd-btn--primary" @click="applyBatchDiscounts">一键填入</button>
            <button class="bd-btn bd-btn--warning" :disabled="batchDiscountSaving" @click="saveAllDiscounts">
              {{ batchDiscountSaving ? '保存中…' : '一键保存' }}
            </button>
          </div>
        </summary>
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
        <p class="batch-scroll-tip">设置完成后，请向下滚动管理各用户的权限与折扣</p>
      </details>
    </section>

    <button
      v-if="showScrollHint"
      type="button"
      class="list-scroll-hint"
      @click="scrollToUserList"
    >
      <span class="list-scroll-hint-arrow" aria-hidden="true">↓</span>
      <span class="list-scroll-hint-text">
        下方还有 <strong>{{ pagination.total }}</strong> 位用户，点击查看权限与折扣列表
      </span>
    </button>

    <section v-if="resetRequests.length > 0" class="reset-panel">
      <div class="reset-head">
        <div class="reset-desc">
          <strong>密码重置申请</strong>
          <span>用户通过「忘记密码」提交的重置申请，审核后可设置新密码。</span>
        </div>
        <button class="head-btn head-btn--sm" :disabled="resetLoading" @click="loadResetRequests">
          刷新
        </button>
      </div>
      <div class="reset-list">
        <div
          v-for="req in resetRequests"
          :key="req.id"
          class="reset-item"
        >
          <div class="reset-user">
            <strong>{{ req.real_name || req.username }}</strong>
            <span>{{ req.username }}</span>
          </div>
          <div class="reset-time">{{ formatTime(req.created_at) }}</div>
          <ElTag :type="resetStatusType(req.status)" size="small" effect="plain">
            {{ resetStatusLabel(req.status) }}
          </ElTag>
          <div v-if="req.status === 'pending'" class="reset-actions">
            <ElButton
              size="small"
              type="primary"
              :loading="resetHandlingId === req.id"
              @click="openResetDialog(req)"
            >
              重置密码
            </ElButton>
            <ElButton
              size="small"
              :loading="resetHandlingId === req.id"
              @click="rejectReset(req)"
            >
              拒绝
            </ElButton>
          </div>
          <div v-else class="reset-handled">
            {{ formatTime(req.handled_at) }}
          </div>
        </div>
      </div>
    </section>

    <ElDialog
      v-model="resetDialogVisible"
      title="重置用户密码"
      width="420px"
      :close-on-click-modal="false"
    >
      <div class="reset-dialog-body">
        <p>为用户 <strong>{{ resetTargetRequest?.real_name || resetTargetRequest?.username }}</strong>（{{ resetTargetRequest?.username }}）设置新密码：</p>
        <ElInput
          v-model="resetNewPassword"
          placeholder="输入新密码（至少 6 位）"
          show-password
          @keyup.enter="approveReset"
        />
      </div>
      <template #footer>
        <ElButton @click="resetDialogVisible = false">取消</ElButton>
        <ElButton :loading="!!resetHandlingId" type="primary" @click="approveReset">
          确认重置
        </ElButton>
      </template>
    </ElDialog>

    <section ref="userPanelRef" class="user-panel" v-loading="loading">
      <div class="user-list-head">
        <span>共 {{ pagination.total }} 位用户</span>
      </div>

      <article v-for="user in filteredUsers" :key="user.id" class="user-card">
        <div class="user-card-top">
          <div class="user-identity">
            <ElAvatar :size="40" :style="{ background: userAvatarColor(user.id) }">
              {{ userInitial(user) }}
            </ElAvatar>
            <div class="user-text">
              <strong>{{ user.display_name }}</strong>
              <span>{{ user.username }}</span>
            </div>
          </div>
          <span class="user-no-cell">{{ user.user_no || '-' }}</span>
          <ElTag size="small" effect="plain" :type="statusTagType(user.status)">
            {{ statusLabel(user.status) }}
          </ElTag>
          <strong class="balance-text">{{ formatMoney(user.available_amount) }}</strong>
          <div class="card-actions">
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
            <ElButton size="small" plain @click="openBalanceDialog(user)">余额</ElButton>
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

        <div class="user-card-body">
          <div class="body-col body-col--roles">
            <label>角色权限</label>
            <ElSelect
              :model-value="getEditedRoles(user)"
              class="role-select"
              collapse-tags
              collapse-tags-tooltip
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
          </div>
          <div class="body-col body-col--discount">
            <label>折扣设置</label>
            <div class="discount-chips">
              <span class="d-chip d-chip--view" :title="viewPriceLabel(getEditedDiscounts(user))">
                阅 {{ viewPriceLabel(getEditedDiscounts(user)) }}
              </span>
              <span class="d-chip d-chip--like" :title="likePriceLabel(getEditedDiscounts(user))">
                赞 {{ likePriceLabel(getEditedDiscounts(user)) }}
              </span>
              <span class="d-chip d-chip--impression" :title="impressionPriceLabel(getEditedDiscounts(user))">
                曝 {{ impressionPriceLabel(getEditedDiscounts(user)) }}
              </span>
            </div>
          </div>
          <div class="body-col body-col--orders">
            <label>下单权限</label>
            <div class="order-toggle-row">
              <label class="toggle-chip">
                <span>阅读</span>
                <ElSwitch
                  :model-value="user.order_view_enabled"
                  :loading="orderTypeSavingUserId === user.id"
                  size="small"
                  @change="toggleOrderType(user, 'order_view_enabled')"
                />
              </label>
              <label class="toggle-chip">
                <span>点赞</span>
                <ElSwitch
                  :model-value="user.order_like_enabled"
                  :loading="orderTypeSavingUserId === user.id"
                  size="small"
                  @change="toggleOrderType(user, 'order_like_enabled')"
                />
              </label>
              <label class="toggle-chip">
                <span>曝光</span>
                <ElSwitch
                  :model-value="user.order_impression_enabled"
                  :loading="orderTypeSavingUserId === user.id"
                  size="small"
                  @change="toggleOrderType(user, 'order_impression_enabled')"
                />
              </label>
            </div>
          </div>
        </div>
      </article>

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

    <ElDialog v-model="balanceDialogVisible" title="调整余额" width="420px">
      <div class="balance-dialog-body">
        <div class="balance-user">
          <strong>{{ balanceTargetUser?.display_name }}</strong>
          <span>
            {{ balanceTargetUser?.username }} / 当前
            {{ formatMoney(balanceTargetUser?.available_amount || 0) }}
          </span>
        </div>
        <label>
          <span>调整金额</span>
          <ElInputNumber
            v-model="balanceForm.amount"
            :precision="2"
            :step="10"
            class="balance-input"
            controls-position="right"
          />
        </label>
        <div class="balance-preview">
          <span>调整后余额：</span>
          <strong :style="{ color: balancePreview < 0 ? '#f56c6c' : '#409eff' }">{{ formatMoney(balancePreview) }}</strong>
        </div>
        <label>
          <span>备注</span>
          <ElInput v-model="balanceForm.reason" placeholder="管理员调整余额" />
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
  min-height: calc(100dvh - 88px);
  padding: 20px;
  box-sizing: border-box;
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

/* ---- control deck ---- */
.control-deck {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.deck-row--switches {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.deck-title strong {
  font-size: 14px;
}

.deck-title span {
  display: block;
  margin-top: 2px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.switch-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.switch-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 999px;
  background: var(--el-fill-color-blank);
}

.pill-tag {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.pill-tag--view {
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
}

.pill-tag--like {
  background: var(--el-color-danger-light-8);
  color: var(--el-color-danger);
}

.pill-tag--impression {
  background: var(--el-color-warning-light-8);
  color: var(--el-color-warning);
}

.pill-state {
  min-width: 18px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-success);
}

.pill-state--off {
  color: var(--el-color-danger);
}

.batch-details {
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 10px;
}

.batch-details-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  list-style: none;
}

.batch-details-summary::-webkit-details-marker {
  display: none;
}

.batch-details[open] .batch-cards {
  margin-top: 12px;
}

.batch-scroll-tip {
  margin: 10px 0 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--el-color-primary) 6%, var(--el-fill-color-blank));
  color: var(--el-text-color-secondary);
  font-size: 12px;
  text-align: center;
}

.list-scroll-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  padding: 12px 16px;
  border: 1px dashed var(--el-color-primary-light-5);
  border-radius: 10px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--el-color-primary) 8%, var(--el-bg-color)) 0%,
    var(--el-bg-color) 100%
  );
  color: var(--el-color-primary);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.15s;
}

.list-scroll-hint:hover {
  border-color: var(--el-color-primary-light-3);
  box-shadow: 0 4px 14px rgb(64 158 255 / 12%);
  transform: translateY(1px);
}

.list-scroll-hint-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--el-color-primary-light-8);
  font-size: 14px;
  font-weight: 700;
  animation: scroll-hint-bounce 1.6s ease-in-out infinite;
}

.list-scroll-hint-text strong {
  color: var(--el-color-primary);
  font-weight: 700;
}

@keyframes scroll-hint-bounce {
  0%,
  100% {
    transform: translateY(0);
  }

  50% {
    transform: translateY(3px);
  }
}

/* ---- batch discount ---- */
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

/* ---- user list ---- */
.user-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
  overflow: hidden;
}

.user-list-head {
  padding: 12px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: var(--el-fill-color-light);
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.user-card {
  padding: 12px 16px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  transition: background 0.12s;
}

.user-card:hover {
  background: var(--el-fill-color-lighter);
}

.user-card-top {
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) 96px 72px 110px 1fr;
  gap: 12px;
  align-items: center;
}

.user-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.user-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.user-text strong {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-text span {
  font-size: 12px;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-no-cell {
  font-size: 12px;
  font-family: ui-monospace, Consolas, monospace;
  color: var(--el-text-color-secondary);
}

.balance-text {
  font-family: Consolas, monospace;
  font-size: 14px;
  color: var(--el-color-primary);
  white-space: nowrap;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.card-actions :deep(.el-button) {
  margin-left: 0;
}

.user-card-body {
  display: grid;
  grid-template-columns: minmax(220px, 1.2fr) minmax(240px, 1fr) minmax(280px, 1.1fr);
  gap: 12px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.body-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.body-col > label {
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.role-select {
  width: 100%;
}

.discount-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.d-chip {
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.d-chip--view {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.d-chip--like {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.d-chip--impression {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.order-toggle-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.toggle-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 999px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
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

.balance-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 13px;
}

.balance-preview span {
  color: var(--el-text-color-secondary);
}

.balance-preview strong {
  font-size: 16px;
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

  .deck-row--switches {
    flex-direction: column;
    align-items: stretch;
  }

  .batch-cards {
    grid-template-columns: 1fr;
  }

  .batch-details-summary {
    flex-direction: column;
    align-items: stretch;
  }

  .user-card-top {
    grid-template-columns: 1fr;
  }

  .user-card-body {
    grid-template-columns: 1fr;
  }

  .card-actions {
    justify-content: flex-start;
  }
}

/* ---- 密码重置申请面板 ---- */
.reset-panel {
  padding: 18px 20px;
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
}

.reset-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.reset-desc strong {
  font-size: 15px;
}

.reset-desc span {
  display: block;
  margin-top: 3px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.head-btn--sm {
  padding: 5px 14px;
  font-size: 13px;
}

.reset-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.reset-item {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) 160px 80px 180px;
  gap: 14px;
  align-items: center;
  padding: 12px 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-blank);
}

.reset-user {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.reset-user strong {
  font-size: 14px;
}

.reset-user span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-family: Consolas, 'SF Mono', monospace;
}

.reset-time {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.reset-actions {
  display: flex;
  gap: 8px;
}

.reset-handled {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.reset-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.reset-dialog-body p {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
}
</style>
