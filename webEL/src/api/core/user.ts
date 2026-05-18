import type { UserInfo } from '@vben/types';

import { requestClient } from '#/api/request';

export namespace UserApi {
  export interface ProfileAccount {
    account_status: string;
    created_at: null | string;
    display_name: string;
    role_label: string;
    roles: string[];
    status: string;
    user_id: number;
    user_no: string;
    username: string;
  }

  export interface ProfileBalance {
    available_amount: number;
    updated_at: null | string;
  }

  export interface ProfileDiscounts {
    impression_discount_rate: number;
    view_discount_rate: number;
  }

  export interface ProfileOrderStats {
    completed_quantity_total: number;
    completed_total: number;
    failed_total: number;
    manual_review_total: number;
    order_total: number;
    ordered_quantity_total: number;
    running_total: number;
  }

  export interface ProfileOrder {
    completed_quantity: number;
    created_at: string;
    order_no: string;
    order_status: string;
    ordered_quantity: number;
    target_type: string;
    updated_at: string;
  }

  export interface ProfileRecord {
    actual_paid_amount: number;
    after_available_amount: number;
    before_available_amount: number;
    created_at: string;
    direction: string;
    net_amount: number;
    order_no: null | string;
    reason_message: null | string;
    record_no: string;
    record_type: string;
    refund_amount: number;
    status: string;
  }

  export interface Profile {
    account: ProfileAccount;
    balance: ProfileBalance;
    discounts: ProfileDiscounts;
    order_stats: ProfileOrderStats;
    recent_orders: ProfileOrder[];
    recent_records: ProfileRecord[];
  }

  export interface AdminRole {
    code: string;
    name: string;
  }

  export interface AdminUserPermission {
    available_amount: number;
    created_at: string;
    display_name: string;
    discount_rate: number;
    fixed_unit_price: null | number;
    id: number;
    impression_fixed_unit_price: null | number;
    impression_quantity_price_amount: null | number;
    impression_quantity_price_base: null | number;
    impression_discount_rate: number;
    impression_price_mode: 'default' | 'discount' | 'fixed' | 'quantity';
    like_discount_rate: number;
    like_fixed_unit_price: null | number;
    like_price_mode: 'default' | 'discount' | 'fixed' | 'quantity';
    like_quantity_price_amount: null | number;
    like_quantity_price_base: null | number;
    price_mode: 'default' | 'discount' | 'fixed' | 'quantity';
    quantity_price_amount: null | number;
    quantity_price_base: null | number;
    real_name: string;
    role_names: string[];
    roles: string[];
    status: string;
    user_no: string;
    username: string;
  }

  export interface PageResult<T> {
    items: T[];
    page: number;
    page_size: number;
    total: number;
  }

  export interface Notification {
    date: string;
    id: number | string;
    link?: string;
    message: string;
    title: string;
    type?: 'danger' | 'info' | 'success' | 'warning';
  }
}

/**
 * 获取用户信息
 */
export async function getUserInfoApi() {
  return requestClient.get<UserInfo>('/user/info');
}

export async function getUserProfileApi() {
  return requestClient.get<UserApi.Profile>('/user/profile');
}

export async function getUserNotificationsApi(options?: { silent?: boolean }) {
  return requestClient.get<UserApi.Notification[]>('/user/notifications', {
    skipBackendLoading: options?.silent,
  } as any);
}

export async function getAdminPermissionUsersApi(params?: {
  keyword?: string;
  page?: number;
  page_size?: number;
}) {
  return requestClient.get<UserApi.PageResult<UserApi.AdminUserPermission>>(
    '/v1/admin/permissions/users',
    { params },
  );
}

export async function getAdminPermissionRolesApi() {
  return requestClient.get<UserApi.AdminRole[]>('/v1/admin/permissions/roles');
}

export async function updateAdminUserRolesApi(userId: number, roles: string[]) {
  return requestClient.put<{ roles: string[]; user_id: number }>(
    `/v1/admin/permissions/users/${userId}/roles`,
    { roles },
  );
}

export async function updateAdminUserStatusApi(userId: number, status: string) {
  return requestClient.put<{ status: string; user_id: number }>(
    `/v1/admin/permissions/users/${userId}/status`,
    { status },
  );
}

export async function updateAdminUserBalanceApi(
  userId: number,
  data: { amount: number; reason?: string },
) {
  return requestClient.put<{
    after_available_amount: number;
    before_available_amount: number;
    delta_amount: number;
    user_id: number;
  }>(`/v1/admin/permissions/users/${userId}/balance`, data);
}

export async function updateAdminUserDiscountsApi(
  userId: number,
  data: {
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
  },
) {
  return requestClient.put<{
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
    user_id: number;
  }>(`/v1/admin/permissions/users/${userId}/discounts`, data);
}
