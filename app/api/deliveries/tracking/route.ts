import { callRustRpc } from '@/lib/server/rust-rpc';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import { resolveRoute } from '@/lib/logistics/maps';
import type { DeliveryTrackingView } from '@/lib/types';

type RawTracking = {
  delivery_id: number;
  delivery_number: string;
  status: DeliveryTrackingView['status'];
  assignment_status: DeliveryTrackingView['assignmentStatus'];
  tracking_active: boolean;
  tracking_status: DeliveryTrackingView['trackingStatus'];
  reason: string;
  last_updated?: string | null;
  rider_location?: { lat: number; lng: number; accuracy_m?: number; speed_kmh?: number; heading_degrees?: number } | null;
  destination?: { lat: number; lng: number } | null;
  pickup?: { lat: number; lng: number } | null;
  route_distance_km?: number | null;
  route_duration_minutes?: number | null;
  route_provider?: string | null;
  route_is_estimate?: boolean | null;
};

function mapTracking(raw: RawTracking): DeliveryTrackingView {
  return {
    deliveryId: Number(raw.delivery_id),
    deliveryNumber: raw.delivery_number,
    status: raw.status,
    assignmentStatus: raw.assignment_status,
    trackingActive: Boolean(raw.tracking_active),
    trackingStatus: raw.tracking_status,
    reason: raw.reason || '',
    lastUpdated: raw.last_updated || undefined,
    riderLocation: raw.rider_location
      ? {
          lat: raw.rider_location.lat,
          lng: raw.rider_location.lng,
          accuracyM: raw.rider_location.accuracy_m,
          speedKmh: raw.rider_location.speed_kmh,
          headingDegrees: raw.rider_location.heading_degrees,
        }
      : undefined,
    destination: raw.destination || undefined,
    pickup: raw.pickup || undefined,
    routeDistanceKm: raw.route_distance_km ?? undefined,
    routeDurationMinutes: raw.route_duration_minutes ?? undefined,
    routeProvider: raw.route_provider || '',
    routeIsEstimate: raw.route_is_estimate !== false,
  };
}

/** GET /api/deliveries/tracking?deliveryId=123 — participants only. */
export async function GET(req: NextRequest) {
  try {
    const limited = rateLimit(`delivery:tracking:${clientIpFromRequest(req)}`, 120, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many tracking requests' }, { status: 429 });
    }
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
    const deliveryId = Number(req.nextUrl.searchParams.get('deliveryId'));
    if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
      return NextResponse.json({ success: false, error: 'A valid delivery is required' }, { status: 400 });
    }

    const { data, error } = await callRustRpc(supabase, 'delivery_tracking_view', {
      p_delivery_id: deliveryId,
    });
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 403 });
    }
    let raw = data as RawTracking;

    // Compute the road route once, when both endpoints are known. The RPC
    // restricts this update to participants; failure here must not break
    // tracking, so the fallback result is simply left unset.
    if (
      !raw.route_distance_km &&
      raw.pickup?.lat != null &&
      raw.pickup?.lng != null &&
      raw.destination?.lat != null &&
      raw.destination?.lng != null
    ) {
      const route = await resolveRoute(raw.pickup, raw.destination);
      if (route) {
        const { error: routeError } = await callRustRpc(supabase, 'delivery_set_route', {
          p_delivery_id: deliveryId,
          p_distance_km: route.distanceKm,
          p_duration_minutes: route.durationMinutes,
          p_provider: route.provider,
          p_is_estimate: route.isEstimate,
        });
        if (!routeError) {
          raw = {
            ...raw,
            route_distance_km: route.distanceKm,
            route_duration_minutes: route.durationMinutes,
            route_provider: route.provider,
            route_is_estimate: route.isEstimate,
          };
        }
      }
    }

    return NextResponse.json({ success: true, data: mapTracking(raw) });
  } catch (error) {
    logger.error('Delivery tracking failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not load tracking') },
      { status: 500 }
    );
  }
}
