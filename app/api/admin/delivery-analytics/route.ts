import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';

type RawTotals = {
  total?: number;
  completed?: number;
  failed?: number;
  cancelled?: number;
  active?: number;
  delayed?: number;
  avg_delivery_hours?: number;
  delivery_costs?: number;
  completed_delivery_costs?: number;
  rider_earnings?: number;
  successful_delivery_percentage?: number | null;
};

/** GET /api/admin/delivery-analytics?from=YYYY-MM-DD&to=YYYY-MM-DD */
export async function GET(req: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const from = req.nextUrl.searchParams.get('from');
    const to = req.nextUrl.searchParams.get('to');
    if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
      return NextResponse.json({ success: false, error: 'Dates must use YYYY-MM-DD' }, { status: 400 });
    }

    const { data, error } = await callRustAdminRpc(supabase, 'admin_delivery_analytics', {
      p_from: from || null,
      p_to: to || null,
    });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }

    const raw = data as {
      totals?: RawTotals;
      courier_performance?: { courier?: string; shipments?: number; completed?: number; failed?: number }[];
      by_state?: { state?: string; total?: number; completed?: number; failed?: number; avg_hours?: number }[];
      by_city?: { city?: string; state?: string; total?: number; completed?: number; failed?: number; avg_hours?: number }[];
      route_distance_estimate_count?: number;
    };
    const totals = raw?.totals || {};
    return NextResponse.json({
      success: true,
      data: {
        totals: {
          total: Number(totals.total || 0),
          completed: Number(totals.completed || 0),
          failed: Number(totals.failed || 0),
          cancelled: Number(totals.cancelled || 0),
          active: Number(totals.active || 0),
          delayed: Number(totals.delayed || 0),
          avgDeliveryHours: Number(totals.avg_delivery_hours || 0),
          deliveryCosts: Number(totals.delivery_costs || 0),
          completedDeliveryCosts: Number(totals.completed_delivery_costs || 0),
          riderEarnings: Number(totals.rider_earnings || 0),
          successfulDeliveryPercentage:
            totals.successful_delivery_percentage == null
              ? null
              : Number(totals.successful_delivery_percentage),
        },
        courierPerformance: (raw?.courier_performance || []).map((row) => ({
          courier: row.courier || 'Unassigned',
          shipments: Number(row.shipments || 0),
          completed: Number(row.completed || 0),
          failed: Number(row.failed || 0),
        })),
        byState: (raw?.by_state || []).map((row) => ({
          state: row.state || 'Unknown',
          total: Number(row.total || 0),
          completed: Number(row.completed || 0),
          failed: Number(row.failed || 0),
          avgHours: Number(row.avg_hours || 0),
        })),
        byCity: (raw?.by_city || []).map((row) => ({
          city: row.city || 'Unknown',
          state: row.state || 'Unknown',
          total: Number(row.total || 0),
          completed: Number(row.completed || 0),
          failed: Number(row.failed || 0),
          avgHours: Number(row.avg_hours || 0),
        })),
        routeDistanceEstimateCount: Number(raw?.route_distance_estimate_count || 0),
      },
    });
  } catch (error) {
    logger.error('Delivery analytics failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not load delivery analytics') },
      { status: 500 }
    );
  }
}
