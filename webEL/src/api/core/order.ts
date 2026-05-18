import { baseRequestClient, requestClient } from '#/api/request';

export namespace OrderApi {
  export interface BatchOrderParams {
    agree_policy?: boolean;
    content: string;
    target_type: 'impression' | 'like' | 'view';
  }

  export interface BatchOrderItem {
    author_name: string;
    avatar_url: string;
    cache_hit: boolean;
    discount_amount: number;
    duplicate: boolean;
    errors: string[];
    line_no: number;
    like_count: null | number;
    note_id: string;
    note_url: string;
    ordered_quantity: number;
    original_amount?: number;
    payable_amount: number;
    raw: string;
    resolved_note_url: string;
    title: string;
    valid: boolean;
  }

  export interface BatchOrderPreview {
    available_balance: number;
    can_submit: boolean;
    check_batch_no: string;
    discount_rate: number;
    discounted_unit_price: number;
    invalid_count: number;
    items: BatchOrderItem[];
    price_base_quantity?: number;
    price_mode?: 'default' | 'discount' | 'fixed' | 'quantity';
    target_type: 'impression' | 'like' | 'view';
    total_amount: number;
    total_count: number;
    unit_price: number;
    valid_count: number;
    warnings: string[];
  }

  export interface BatchOrderSubmitResult {
    batch_id: string;
    batch_no: string;
    submitted_count: number;
    total_amount: number;
  }

  export interface BatchOrderRecordItem {
    actual_paid_amount: number;
    after_available_amount: null | number;
    author_name: string;
    avatar_url: string;
    batch_item_id: number;
    completed_quantity: number;
    created_at: string;
    external_completed_quantity: number;
    external_progress: number;
    external_status: string;
    id: number;
    like_count: null | number;
    note_id: string;
    note_url: string;
    order_no: string;
    order_status: string;
    ordered_quantity: number;
    payable_amount: number;
    reason_message: string;
    record_status: string;
    refund_amount: number;
    repair_count: number;
    target_type: 'impression' | 'like' | 'view';
    snapshot_current_read_count: null | number;
    snapshot_verified_read_count: null | number;
    source_note_url: string;
    title: string;
    updated_at: string;
  }

  export interface BatchOrderRecord {
    batch_id: string;
    batch_no: string;
    created_at: string;
    estimated_amount: number;
    failed_count: number;
    finished_at: null | string;
    id: number;
    orders: BatchOrderRecordItem[];
    processing_count: number;
    raw_content: string;
    retryable_count: number;
    status: string;
    submitted_at: string;
    succeeded_count: number;
    total_count: number;
  }

  export interface ProblemLinkRecord {
    author_name: string;
    avatar_url: string;
    check_batch_no: string;
    created_at: string;
    errors: string[];
    id: number;
    line_no: number;
    note_id: string;
    note_url: string;
    ordered_quantity: number;
    payable_amount: number;
    raw: string;
    resolved_note_url: string;
    target_type: 'impression' | 'like' | 'view';
    title: string;
    valid: boolean;
  }

  export interface BatchLinkCheckRecord {
    author_name: string;
    avatar_url: string;
    check_batch_no: string;
    created_at: string;
    errors: string[];
    id: number;
    line_no: number;
    note_id: string;
    note_url: string;
    ordered_quantity: number;
    payable_amount: number;
    raw: string;
    resolved_note_url: string;
    target_type: 'impression' | 'like' | 'view';
    title: string;
    valid: boolean;
  }

  export interface ConsumptionRecord {
    actual_paid_amount: number;
    after_available_amount: number;
    before_available_amount: number;
    completed_quantity: number;
    created_at: string;
    discount_amount: number;
    discount_rate: number;
    discounted_unit_price: number;
    direction: string;
    display_name: string;
    id: number;
    net_amount: number;
    order_id: number;
    order_items: Array<{
      actual_paid_amount: number;
      external_status: string;
      order_id: number;
      order_no: string;
      order_status: string;
      ordered_quantity: number;
      repair_count: number;
      refund_amount: number;
      refund_requested_at: null | string;
      refunded_quantity: number;
    }>;
    order_no: string;
    order_status: string;
    ordered_quantity: number;
    original_total_amount: number;
    original_unit_price: number;
    payable_amount: number;
    reason_code: string;
    reason_message: string;
    record_no: string;
    record_type: string;
    refund_amount: number;
    refund_requested_at: null | string;
    refunded_quantity: number;
    remark: string;
    status: string;
    user_id: number;
    username: string;
  }

  export interface ConsumptionRecordSummary {
    expense_amount: number;
    income_amount: number;
    net_amount: number;
    refund_amount: number;
  }

  export interface ConsumptionRecordPageResult
    extends PageResult<ConsumptionRecord> {
    summary: ConsumptionRecordSummary;
  }

  export interface RefundRecord {
    actual_paid_amount: number;
    author_name: string;
    avatar_url: string;
    batch_no: string;
    created_at: string;
    display_name: string;
    id: number;
    note_id: string;
    note_url: string;
    order_id: number;
    order_no: string;
    order_status: string;
    ordered_quantity: number;
    reason_message: string;
    refund_amount_total: number;
    refund_calc_after_at: null | string;
    refund_requested_at: null | string;
    refunded_quantity: number;
    target_type: 'impression' | 'like' | 'view';
    title: string;
    updated_at: string;
    user_id: number;
    username: string;
  }

  export interface ReplenishmentRequest {
    batch_id: number;
    batch_no: string;
    batch_uuid: string;
    estimated_amount: number;
    id: number;
    pending_order_count: number;
    pending_quantity: number;
    reason_message: string;
    real_name: string;
    requested_at: string;
    reviewed_at: null | string;
    status: string;
    target_count: number;
    user_id: number;
    username: string;
  }

  export interface BatchOrderSearchResult {
    invalid_count: number;
    items: Array<
      BatchOrderRecordItem & {
        batch_no: string;
        batch_uuid: string;
        matched_input: string;
        user_id: number;
        username: string;
      }
    >;
    links: Array<{
      duplicate: boolean;
      errors: string[];
      line_no: number;
      note_id: string;
      note_url: string;
      raw: string;
      valid: boolean;
    }>;
    matched_count: number;
    total_count: number;
  }

  export interface SaveProblemLinkRecordsParams {
    check_batch_no?: string;
    records: Array<{
      author_name?: string;
      avatar_url?: string;
      errors: string[];
      line_no: number;
      note_id?: string;
      note_url?: string;
      ordered_quantity?: number;
      payable_amount?: number;
      raw: string;
      resolved_note_url?: string;
      title?: string;
    }>;
    target_type: 'impression' | 'like' | 'view';
  }

  export interface SaveProblemLinkRecordsResult {
    check_batch_no: string;
    saved_count: number;
  }

  export interface HealthResult {
    status: string;
    timestamp: string;
    uptime: number;
  }

  export interface OpenApiKey {
    created_at: string;
    id: number;
    key_name: string;
    key_prefix: string;
    last_used_at: null | string;
    masked_key: string;
    revoked_at: null | string;
    status: 'active' | 'revoked' | string;
  }

  export interface OpenApiKeyCreateResult extends OpenApiKey {
    api_key: string;
  }

  export interface PageResult<T> {
    items: T[];
    page: number;
    page_size: number;
    total: number;
  }
}

export async function checkBackendConnectionApi() {
  return baseRequestClient.get<OrderApi.HealthResult>('/health');
}

export async function previewBatchOrderApi(data: OrderApi.BatchOrderParams) {
  return requestClient.post<OrderApi.BatchOrderPreview>(
    '/v1/orders/batch/preview',
    data,
  );
}

export async function previewBatchOrderSilentApi(
  data: OrderApi.BatchOrderParams,
) {
  return requestClient.post<OrderApi.BatchOrderPreview>(
    '/v1/orders/batch/preview-silent',
    data,
  );
}

export async function submitBatchOrderApi(
  data: OrderApi.BatchOrderParams,
  options?: { silent?: boolean },
) {
  return requestClient.post<OrderApi.BatchOrderSubmitResult>(
    '/v1/orders/batch/submit',
    data,
    { skipBackendLoading: options?.silent, timeout: 60_000 } as any,
  );
}

export async function getBatchOrderRecordsApi(
  params?: {
    page?: number;
    page_size?: number;
    skip_status_sync?: 1;
  },
  options?: { silent?: boolean },
) {
  return requestClient.get<OrderApi.PageResult<OrderApi.BatchOrderRecord>>(
    '/v1/orders/batch/records',
    { params, skipBackendLoading: options?.silent } as any,
  );
}

export async function searchBatchOrdersApi(data: {
  content: string;
  end_date?: string;
  start_date?: string;
}) {
  return requestClient.post<OrderApi.BatchOrderSearchResult>(
    '/v1/orders/batch/search',
    data,
  );
}

export async function getConsumptionRecordsApi(params?: {
  direction?: string;
  keyword?: string;
  page?: number;
  page_size?: number;
  record_type?: string;
  status?: string;
}) {
  return requestClient.get<OrderApi.ConsumptionRecordPageResult>(
    '/v1/orders/consumption-records',
    { params },
  );
}

export async function getRefundRecordsApi(params?: {
  keyword?: string;
  page?: number;
  page_size?: number;
  status?: string;
}) {
  return requestClient.get<OrderApi.PageResult<OrderApi.RefundRecord>>(
    '/v1/orders/refund-records',
    { params },
  );
}

export async function retryBatchOrderApi(batchId: number) {
  return requestClient.post<{
    batch_id: number;
    retried_count: number;
    status: string;
  }>(`/v1/orders/batch/${batchId}/retry`);
}

export async function replenishBatchOrderApi(batchId: number) {
  return requestClient.post<{
    batch_id: number;
    batch_no: string;
    checked_count: number;
    replenished_count: number;
    total_replenish_quantity: number;
  }>(`/v1/orders/batch/${batchId}/replenish`);
}

export async function requestReplenishBatchOrderApi(batchId: number) {
  return requestClient.post<{
    batch_id: number;
    batch_no: string;
    id: number;
    status: string;
  }>(`/v1/orders/batch/${batchId}/replenish-request`);
}

export async function getReplenishmentRequestsApi(params?: {
  page?: number;
  page_size?: number;
  status?: string;
}) {
  return requestClient.get<OrderApi.PageResult<OrderApi.ReplenishmentRequest>>(
    '/v1/orders/replenishments',
    { params },
  );
}

export async function approveReplenishmentRequestApi(requestId: number) {
  return requestClient.post<{
    batch_id: number;
    batch_no: string;
    id: number;
    result: {
      checked_count: number;
      replenished_count: number;
      total_replenish_quantity: number;
    };
    status: string;
  }>(`/v1/orders/replenishments/${requestId}/approve`);
}

export async function requestOrderRefundApi(orderId: number) {
  return requestClient.post<{
    order_id: number;
    order_no: string;
    order_status: string;
  }>(`/v1/orders/${orderId}/refund-request`);
}

export async function reviewOrderRefundApi(
  orderId: number,
  data: { approved: boolean; reason?: string },
) {
  return requestClient.post<{
    order_id: number;
    order_no: string;
    order_status: string;
    refunded_amount: number;
  }>(`/v1/orders/${orderId}/refund-review`, data);
}

export async function saveProblemLinkRecordsApi(
  data: OrderApi.SaveProblemLinkRecordsParams,
) {
  return requestClient.post<OrderApi.SaveProblemLinkRecordsResult>(
    '/v1/orders/batch/problem-links',
    data,
  );
}

export async function getProblemLinkRecordsApi(options?: { silent?: boolean }) {
  return requestClient.get<OrderApi.ProblemLinkRecord[]>(
    '/v1/orders/batch/problem-links',
    { skipBackendLoading: options?.silent } as any,
  );
}

export async function getBatchLinkCheckRecordsApi(options?: { silent?: boolean }) {
  return requestClient.get<OrderApi.BatchLinkCheckRecord[]>(
    '/v1/orders/batch/check-records',
    { skipBackendLoading: options?.silent } as any,
  );
}

export async function getOpenApiKeysApi() {
  return requestClient.get<OrderApi.OpenApiKey[]>('/v1/open-api/keys');
}

export async function createOpenApiKeyApi(data: { name?: string }) {
  return requestClient.post<OrderApi.OpenApiKeyCreateResult>(
    '/v1/open-api/keys',
    data,
  );
}

export async function deleteOpenApiKeyApi(keyId: number) {
  return requestClient.delete<{ id: number; status: string }>(
    `/v1/open-api/keys/${keyId}`,
  );
}
