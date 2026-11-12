import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { callRustRpc } from '@/lib/server/rust-rpc';
import { logger, publicErrorMessage } from '@/lib/logger';
import { rateLimitAsync, clientIpFromRequest } from '@/lib/rate-limit';

type BulkRow = {
  productId?: unknown;
  price?: unknown;
  quantity?: unknown;
  stockStatus?: unknown;
};

const STOCK = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'SOLD', 'UNAVAILABLE'];

export async function POST(req: NextRequest) {
  try {
    const limited = await rateLimitAsync(`seller:inventory:bulk:${clientIpFromRequest(req)}`, 10, 60_000);
    if (!limited.allowed) {
      return NextResponse.json(
        { success: false, error: 'Too many bulk updates' },
        { status: limited.unavailable ? 503 : 429 },
      );
    }

    const supabase = await createServerSupabaseClient();
    if (!supabase) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => null);
    const rows = Array.isArray(body?.rows) ? body.rows as BulkRow[] : [];
    if (!rows.length || rows.length > 250) {
      return NextResponse.json({ success: false, error: 'Send between 1 and 250 inventory rows' }, { status: 400 });
    }

    const ids = new Set<number>();
    const normalized = rows.map((row, index) => {
      const productId = Number(row.productId);
      const price = row.price == null || row.price === '' ? null : Number(row.price);
      const quantity = row.quantity == null || row.quantity === '' ? null : Number(row.quantity);
      const stockStatus = row.stockStatus == null ? null : String(row.stockStatus).toUpperCase();

      if (!Number.isSafeInteger(productId) || productId <= 0 || ids.has(productId)) {
        throw new Error(`Row ${index + 1}: invalid or duplicate product id`);
      }
      ids.add(productId);
      if (price != null && (!Number.isFinite(price) || price < 1 || price > 1_000_000_000)) {
        throw new Error(`Row ${index + 1}: invalid price`);
      }
      if (quantity != null && (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 100_000_000)) {
        throw new Error(`Row ${index + 1}: invalid quantity`);
      }
      if (stockStatus && !STOCK.includes(stockStatus)) {
        throw new Error(`Row ${index + 1}: invalid stock status`);
      }
      if (price == null && quantity == null && !stockStatus) {
        throw new Error(`Row ${index + 1}: nothing to update`);
      }
      return { productId, price, quantity, stockStatus };
    });

    const requestedOwner = body?.ownerId == null ? null : Number(body.ownerId);
    if (requestedOwner != null && (!Number.isSafeInteger(requestedOwner) || requestedOwner <= 0)) {
      return NextResponse.json({ success: false, error: 'Business owner id is invalid' }, { status: 400 });
    }

    const { data, error } = await callRustRpc<{ success: boolean; updated: number }>(
      supabase,
      'bulk_update_my_inventory',
      { p_rows: normalized, p_owner_id: requestedOwner },
    );
    if (error || !data?.success) {
      const message = error?.message || 'Bulk inventory update failed';
      const status = /membership|inventory access/i.test(message) ? 403 :
        /do not belong/i.test(message) ? 403 :
        Number(error?.code) || 400;
      return NextResponse.json({ success: false, error: message }, { status });
    }
    return NextResponse.json({ success: true, updated: data.updated });
  } catch (error) {
    logger.warn('Bulk inventory update failed', { error: String(error) });
    return NextResponse.json(
      { success: false, error: publicErrorMessage(error, 'Bulk inventory update failed') },
      { status: 400 },
    );
  }
}
