import { requestClient } from '#/api/request';

export namespace DashboardApi {
  export interface DashboardMetrics {
    available_balance: number;
    completed_total: number;
    failed_total: number;
    manual_review_total: number;
    order_amount_all: number;
    order_amount_today: number;
    order_amount_yesterday: number;
    order_quantity_all: number;
    order_quantity_today: number;
    order_quantity_yesterday: number;
    order_total: number;
    recent_net_amount: number;
    refund_approved_total: number;
    refunding_total: number;
    retryable_batch_items: number;
    running_total: number;
    xhs_active_total: number;
    xhs_cooling_total: number;
    xhs_disabled_total: number;
    xhs_invalid_total: number;
    xhs_total: number;
  }

  export interface DashboardPricing {
    discounted_impression_unit_price: number;
    discounted_view_unit_price: number;
    discount_rate: number;
    impression_discount_rate: number;
    impression_submit_enabled: boolean;
    impression_unit_price: number;
    like_submit_enabled: boolean;
    view_discount_rate: number;
    view_submit_enabled: boolean;
    view_unit_price: number;
  }

  export interface DashboardRankingUser {
    available_balance: number;
    charge_amount_total: number;
    completed_orders: number;
    display_name: string;
    failed_orders: number;
    last_order_at: null | string;
    order_total: number;
    ordered_quantity_total: number;
    rank: number;
    user_id: number;
    user_no: string;
    username: string;
  }

  export interface ApiCallStats {
    preview_calls: number;
    progress_calls: number;
    stop_calls: number;
    submit_calls: number;
    today_calls: number;
    total_calls: number;
    week_calls: number;
    yesterday_calls: number;
  }

  export interface DashboardSummary {
    alert_orders: unknown[];
    all_users_overview: unknown[];
    api_call_stats: ApiCallStats;
    is_admin: boolean;
    metrics: DashboardMetrics;
    pricing: DashboardPricing;
    ranking_period: string;
    rankings_by_amount: DashboardRankingUser[];
    rankings_by_quantity: DashboardRankingUser[];
    recent_batches: unknown[];
    recent_orders: unknown[];
    recent_records: unknown[];
    risk_accounts: unknown[];
  }

  export interface DashboardRankings {
    ranking_period: string;
    rankings_by_amount: DashboardRankingUser[];
    rankings_by_quantity: DashboardRankingUser[];
    target_type: string;
  }

  export interface TodayWeather {
    city: string;
    current_temperature: number;
    temperature_max: number;
    temperature_min: number;
    unit: string;
    weather_code: number;
  }
}

export async function getDashboardSummaryApi(params?: {
  ranking_period?: string;
}) {
  return requestClient.get<DashboardApi.DashboardSummary>(
    '/v1/dashboard/summary',
    { params },
  );
}

export async function getDashboardRankingsApi(params?: {
  ranking_period?: string;
  target_type?: string;
}) {
  return requestClient.get<DashboardApi.DashboardRankings>(
    '/v1/dashboard/rankings',
    { params },
  );
}

export async function getTodayWeatherApi(params?: {
  latitude?: number;
  longitude?: number;
}) {
  return requestClient.get<DashboardApi.TodayWeather>('/weather/today', {
    params,
  });
}
