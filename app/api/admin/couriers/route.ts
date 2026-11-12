import { callRustAdminRpc } from '@/lib/server/rust-rpc';
import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimit, clientIpFromRequest } from '@/lib/rate-limit';
import {
  courierIntegrationStatus,
  getConfiguredCourierAdapter,
  type CourierShipmentRequest,
} from '@/lib/shipping/couriers';

async function requireAdmin() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { supabase: null, error: 'Supabase not configured', status: 503 as const };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase: null, error: 'Unauthorized', status: 401 as const };
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('auth_id', user.id)
    .maybeSingle();
  if (!profile?.id || !['ADMIN', 'SUPER_ADMIN'].includes(String(profile.role || '').toUpperCase())) {
    return { supabase: null, error: 'Admins only', status: 403 as const };
  }
  return { supabase, profile, error: null, status: 200 as const };
}

/** GET /api/admin/couriers — integration status only, never secret values. */
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.supabase) {
    return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
  }
  return NextResponse.json({
    success: true,
    data: {
      ...courierIntegrationStatus(),
      manualFallbackAvailable: true,
      requiredEnv: [
        'COURIER_API_BASE_URL',
        'COURIER_API_KEY',
        'COURIER_PROVIDER_CODE',
        'COURIER_CREATE_PATH',
        'COURIER_TRACKING_PATH',
        'COURIER_WEBHOOK_SECRET',
      ],
    },
  });
}

/**
 * POST /api/admin/couriers
 * { action: 'CREATE', deliveryId } — create via the configured HTTP adapter
 * { action: 'SYNC', deliveryId } — pull tracking events and apply them
 * { action: 'MANUAL', deliveryId, courierName, trackingNumber, status?, note? }
 */
export async function POST(req: NextRequest) {
  try {
    const limited = rateLimit(`admin:couriers:${clientIpFromRequest(req)}`, 60, 60_000);
    if (!limited.allowed) {
      return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429 });
    }
    const auth = await requireAdmin();
    if (!auth.supabase) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }
    const supabase = auth.supabase;
    const body = await req.json().catch(() => null);
    const action = String(body?.action || '').toUpperCase();
    const deliveryId = Number(body?.deliveryId);
    if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
      return NextResponse.json({ success: false, error: 'A delivery is required' }, { status: 400 });
    }

    if (action === 'MANUAL') {
      const courierName = String(body?.courierName || '').trim().slice(0, 120);
      const trackingNumber = String(body?.trackingNumber || '').trim().slice(0, 120);
      if (!courierName || !trackingNumber) {
        return NextResponse.json(
          { success: false, error: 'Courier name and tracking number are required' },
          { status: 400 }
        );
      }
      const { data, error } = await callRustAdminRpc(supabase, 'admin_manual_courier_update', {
        p_delivery_id: deliveryId,
        p_courier_name: courierName,
        p_tracking_number: trackingNumber,
        p_status: body?.status ? String(body.status).toUpperCase().slice(0, 40) : '',
        p_note: body?.note ? String(body.note).trim().slice(0, 500) : '',
      });
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 409 });
      }
      return NextResponse.json({ success: true, data });
    }

    const adapter = getConfiguredCourierAdapter();
    if (!adapter) {
      return NextResponse.json(
        {
          success: false,
          error:
            'No courier API adapter is configured. Set the server courier environment variables, or use the manual tracking fallback.',
          manualFallback: true,
        },
        { status: 503 }
      );
    }

    if (action === 'CREATE') {
      const { data: delivery, error: deliveryError } = await supabase
        .from('deliveries')
        .select('*')
        .eq('id', deliveryId)
        .maybeSingle();
      if (deliveryError || !delivery) {
        return NextResponse.json({ success: false, error: 'Delivery not found' }, { status: 404 });
      }
      const { data: order } = await supabase
        .from('orders')
        .select('order_number, buyer_id, total_amount')
        .eq('id', delivery.order_id)
        .maybeSingle();
      const { data: buyer } = order?.buyer_id
        ? await supabase
            .from('profiles')
            .select('full_name, phone_number')
            .eq('id', order.buyer_id)
            .maybeSingle()
        : { data: null };

      const request: CourierShipmentRequest = {
        orderId: Number(delivery.order_id),
        orderNumber: String(order?.order_number || `ORDER-${delivery.order_id}`),
        customerName: String(buyer?.full_name || 'GoodSale buyer'),
        customerPhone: String(buyer?.phone_number || ''),
        pickupAddress: String(delivery.pickup_address || ''),
        pickupCity: String(delivery.pickup_city || ''),
        pickupState: String(delivery.pickup_state || ''),
        pickupLat: delivery.pickup_lat ?? undefined,
        pickupLng: delivery.pickup_lng ?? undefined,
        deliveryAddress: String(delivery.delivery_address || ''),
        deliveryCity: String(delivery.delivery_city || ''),
        deliveryState: String(delivery.delivery_state || ''),
        deliveryLat: delivery.delivery_lat ?? undefined,
        deliveryLng: delivery.delivery_lng ?? undefined,
        weightKg: 1,
        service: ['ECONOMY', 'STANDARD', 'EXPRESS'].includes(String(delivery.service_type))
          ? (delivery.service_type as 'ECONOMY' | 'STANDARD' | 'EXPRESS')
          : 'STANDARD',
      };
      if (!request.pickupAddress && !request.pickupCity) {
        return NextResponse.json({ success: false, error: 'Pickup details are missing' }, { status: 400 });
      }

      let shipment;
      try {
        shipment = await adapter.createShipment(request);
      } catch (error) {
        logger.warn('Courier shipment creation failed', { error: String(error), deliveryId });
        return NextResponse.json(
          { success: false, error: publicErrorMessage(error, 'Courier shipment creation failed') },
          { status: 502 }
        );
      }

      const { data, error } = await callRustAdminRpc(supabase, 'admin_record_courier_shipment', {
        p_delivery_id: deliveryId,
        p_provider: shipment.provider,
        p_tracking_number: shipment.trackingNumber,
        p_external_shipment_id: shipment.externalShipmentId || '',
        p_courier_name: adapter.provider,
        p_label_url: shipment.labelUrl || '',
        p_status: 'CREATED',
      });
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 409 });
      }
      return NextResponse.json({ success: true, data: { ...(data && typeof data === 'object' ? data as Record<string, unknown> : {}), labelUrl: shipment.labelUrl || '' } });
    }

    if (action === 'SYNC') {
      const { data: shipmentRow, error: shipmentError } = await supabase
        .from('courier_shipments')
        .select('*')
        .eq('delivery_id', deliveryId)
        .maybeSingle();
      if (shipmentError || !shipmentRow) {
        return NextResponse.json({ success: false, error: 'No courier shipment is recorded' }, { status: 404 });
      }
      if (String(shipmentRow.provider).toLowerCase() !== adapter.provider) {
        return NextResponse.json(
          { success: false, error: 'Shipment provider does not match the configured courier adapter' },
          { status: 409 }
        );
      }

      let events;
      try {
        events = await adapter.getTracking(String(shipmentRow.tracking_number));
      } catch (error) {
        const service = createAdminClient();
        if (service) {
          await service
            .from('courier_shipments')
            .update({
              sync_attempts: Number(shipmentRow.sync_attempts || 0) + 1,
              last_error: String(error).slice(0, 500),
            })
            .eq('id', shipmentRow.id);
        }
        return NextResponse.json(
          { success: false, error: publicErrorMessage(error, 'Courier tracking sync failed') },
          { status: 502 }
        );
      }

      const service = createAdminClient();
      if (!service) {
        return NextResponse.json({ success: false, error: 'Server service role is not configured' }, { status: 503 });
      }

      let applied = 0;
      for (const [index, event] of events.entries()) {
        const eventId = createHash('sha256')
          .update(
            [
              shipmentRow.provider,
              shipmentRow.tracking_number,
              event.status,
              event.occurredAt,
              event.note || '',
              index,
            ].join('|')
          )
          .digest('hex');
        const { error } = await callRustAdminRpc(supabase, 'courier_apply_tracking_event', {
          p_provider: shipmentRow.provider,
          p_event_id: eventId,
          p_tracking_number: shipmentRow.tracking_number,
          p_status: event.status,
          p_note: event.note || '',
          p_occurred_at: event.occurredAt,
          p_payload_hash: eventId,
          p_reason_code: 'OTHER',
          p_location: event.location || '',
          p_payload: event as unknown as Record<string, unknown>,
        });
        if (!error) applied += 1;
      }

      return NextResponse.json({
        success: true,
        data: {
          applied,
          received: events.length,
          provider: adapter.provider,
          trackingNumber: shipmentRow.tracking_number,
        },
      });
    }

    return NextResponse.json({ success: false, error: 'Unknown courier action' }, { status: 400 });
  } catch (error) {
    logger.error('Admin courier action failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Could not process courier request') },
      { status: 500 }
    );
  }
}
