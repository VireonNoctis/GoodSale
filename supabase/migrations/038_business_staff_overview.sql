-- 038 — Server-side Business staff overview for owners and authorized staff.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_my_business_staff_overview(p_owner_id bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller bigint;
  v_owner bigint;
  v_role text;
  v_status text;
  v_owner_name text;
  v_city text;
  v_state text;
  v_plan text;
  v_expires timestamptz;
  v_products jsonb;
  v_low_stock jsonb;
  v_recent jsonb;
  v_listings integer;
  v_low_count integer;
  v_pending integer;
  v_open_orders integer;
  v_revenue numeric;
  v_capabilities jsonb;
BEGIN
  v_caller := public.current_profile_id();
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_owner := coalesce(p_owner_id, v_caller);

  IF v_owner <> v_caller THEN
    SELECT role,status INTO v_role,v_status
    FROM public.business_staff
    WHERE owner_id=v_owner AND member_id=v_caller;
    IF NOT FOUND OR v_status <> 'ACTIVE' THEN RAISE EXCEPTION 'You are not active staff for this business'; END IF;
  END IF;

  SELECT plan,expires_at INTO v_plan,v_expires
  FROM public.business_subscriptions
  WHERE user_id=v_owner AND status='ACTIVE' AND expires_at>now()
  ORDER BY CASE plan WHEN 'ENTERPRISE' THEN 3 WHEN 'PREMIUM' THEN 2 ELSE 1 END DESC, expires_at DESC
  LIMIT 1;

  IF v_owner <> v_caller AND v_plan IS NULL THEN
    RAISE EXCEPTION 'This business no longer has an active Business membership';
  END IF;

  SELECT full_name,city,state INTO v_owner_name,v_city,v_state
  FROM public.profiles WHERE id=v_owner;
  IF v_owner_name IS NULL THEN RAISE EXCEPTION 'Business owner not found'; END IF;

  SELECT count(*) INTO v_listings FROM public.products WHERE seller_id=v_owner;
  SELECT count(*) INTO v_low_count FROM public.products WHERE seller_id=v_owner AND quantity>0 AND quantity<=3;
  SELECT count(*) INTO v_pending FROM public.products WHERE seller_id=v_owner AND moderation_status='PENDING';
  SELECT count(*) INTO v_open_orders FROM public.orders
  WHERE seller_id=v_owner AND status IN ('PENDING','PAID_ESCROW','SHIPPED','OUT_FOR_DELIVERY');
  SELECT coalesce(sum(total_amount),0) INTO v_revenue FROM public.orders
  WHERE seller_id=v_owner AND status='DELIVERED_SUCCESS';

  SELECT coalesce(jsonb_agg(x.item ORDER BY x.created_at DESC),'[]'::jsonb)
  INTO v_products
  FROM (
    SELECT jsonb_build_object(
      'id',p.id,'title',p.title,'price',p.price,'quantity',p.quantity,
      'stockStatus',p.stock_status,'image',coalesce(p.images->>0,''),
      'moderationStatus',coalesce(p.moderation_status,'APPROVED')
    ) AS item,p.created_at
    FROM public.products p WHERE p.seller_id=v_owner
    ORDER BY p.created_at DESC LIMIT 8
  ) x;

  SELECT coalesce(jsonb_agg(x.item ORDER BY x.quantity ASC),'[]'::jsonb)
  INTO v_low_stock
  FROM (
    SELECT jsonb_build_object(
      'id',p.id,'title',p.title,'price',p.price,'quantity',p.quantity,
      'stockStatus',p.stock_status,'image',coalesce(p.images->>0,''),
      'moderationStatus',coalesce(p.moderation_status,'APPROVED')
    ) AS item,p.quantity
    FROM public.products p
    WHERE p.seller_id=v_owner AND p.quantity>0 AND p.quantity<=3
    ORDER BY p.quantity ASC LIMIT 5
  ) x;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',o.id,'status',o.status,'amount',o.total_amount,'createdAt',o.created_at
  ) ORDER BY o.created_at DESC),'[]'::jsonb)
  INTO v_recent
  FROM (
    SELECT id,status,total_amount,created_at
    FROM public.orders WHERE seller_id=v_owner
    ORDER BY created_at DESC LIMIT 8
  ) o;

  v_capabilities := CASE
    WHEN v_owner=v_caller THEN '["analytics","inventory","team"]'::jsonb
    WHEN v_role='MANAGER' THEN '["analytics","inventory","team"]'::jsonb
    WHEN v_role='INVENTORY' THEN '["analytics","inventory"]'::jsonb
    ELSE '["analytics"]'::jsonb
  END;

  RETURN jsonb_build_object(
    'success',true,
    'ownerId',v_owner,
    'businessName',v_owner_name,
    'location',concat_ws(', ',nullif(v_city,''),nullif(v_state,'')),
    'role',v_role,
    'capabilities',v_capabilities,
    'plan',v_plan,
    'expiresAt',v_expires,
    'stats',jsonb_build_object(
      'listings',v_listings,'lowStock',v_low_count,'pendingModeration',v_pending,
      'openOrders',v_open_orders,'revenue',v_revenue
    ),
    'lowStock',v_low_stock,
    'listings',v_products,
    'recentOrders',v_recent
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_business_staff_overview(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_business_staff_overview(bigint) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
