-- 039 — Atomic bulk inventory mutation for Business owners and authorized staff.
BEGIN;

CREATE OR REPLACE FUNCTION public.bulk_update_my_inventory(
  p_rows jsonb,
  p_owner_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor bigint;
  v_owner bigint;
  v_role text;
  v_plan text;
  v_value jsonb;
  v_product_id bigint;
  v_price numeric;
  v_quantity integer;
  v_stock text;
  v_seen bigint[] := ARRAY[]::bigint[];
  v_updated integer := 0;
  v_count integer;
BEGIN
  v_actor := public.current_profile_id();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_owner := coalesce(p_owner_id, v_actor);

  IF jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'Inventory rows must be an array'; END IF;
  v_count := jsonb_array_length(p_rows);
  IF v_count < 1 OR v_count > 250 THEN RAISE EXCEPTION 'Send between 1 and 250 inventory rows'; END IF;

  SELECT plan INTO v_plan
  FROM public.business_subscriptions
  WHERE user_id=v_owner AND status='ACTIVE' AND expires_at>now()
  ORDER BY CASE plan WHEN 'ENTERPRISE' THEN 3 WHEN 'PREMIUM' THEN 2 ELSE 1 END DESC, expires_at DESC
  LIMIT 1;
  IF v_plan IS NULL THEN RAISE EXCEPTION 'Bulk inventory requires an active Business membership'; END IF;

  IF v_owner <> v_actor THEN
    SELECT role INTO v_role
    FROM public.business_staff
    WHERE owner_id=v_owner AND member_id=v_actor AND status='ACTIVE'
    LIMIT 1;
    IF v_role NOT IN ('MANAGER','INVENTORY') THEN
      RAISE EXCEPTION 'You do not have inventory access for this business';
    END IF;
  END IF;

  -- Validate the entire payload before applying any mutation.
  FOR v_value IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(v_value) <> 'object' THEN RAISE EXCEPTION 'Every inventory row must be an object'; END IF;
    IF coalesce(v_value->>'productId','') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Invalid product id'; END IF;
    v_product_id := (v_value->>'productId')::bigint;
    IF v_product_id <= 0 OR v_product_id = ANY(v_seen) THEN RAISE EXCEPTION 'Invalid or duplicate product id'; END IF;
    v_seen := array_append(v_seen,v_product_id);

    IF nullif(v_value->>'price','') IS NOT NULL THEN
      IF (v_value->>'price') !~ '^[0-9]+([.][0-9]{1,2})?$'
        OR (v_value->>'price')::numeric < 1
        OR (v_value->>'price')::numeric > 1000000000 THEN
        RAISE EXCEPTION 'Invalid product price';
      END IF;
    END IF;
    IF nullif(v_value->>'quantity','') IS NOT NULL THEN
      IF (v_value->>'quantity') !~ '^[0-9]+$'
        OR (v_value->>'quantity')::integer > 100000000 THEN
        RAISE EXCEPTION 'Invalid product quantity';
      END IF;
    END IF;
    v_stock := upper(coalesce(v_value->>'stockStatus',''));
    IF v_stock <> '' AND v_stock NOT IN ('IN_STOCK','LOW_STOCK','OUT_OF_STOCK','SOLD','UNAVAILABLE') THEN
      RAISE EXCEPTION 'Invalid stock status';
    END IF;
    IF nullif(v_value->>'price','') IS NULL
      AND nullif(v_value->>'quantity','') IS NULL
      AND v_stock = '' THEN
      RAISE EXCEPTION 'Each inventory row must change price, quantity or stock status';
    END IF;
  END LOOP;

  -- Lock and update in stable product-id order to reduce deadlock risk.
  FOR v_value IN
    SELECT value FROM jsonb_array_elements(p_rows)
    ORDER BY (value->>'productId')::bigint
  LOOP
    v_product_id := (v_value->>'productId')::bigint;
    PERFORM 1 FROM public.products WHERE id=v_product_id AND seller_id=v_owner FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'One or more listings do not belong to this business'; END IF;

    v_price := CASE WHEN nullif(v_value->>'price','') IS NULL THEN NULL ELSE round((v_value->>'price')::numeric,0) END;
    v_quantity := CASE WHEN nullif(v_value->>'quantity','') IS NULL THEN NULL ELSE (v_value->>'quantity')::integer END;
    v_stock := upper(coalesce(v_value->>'stockStatus',''));

    UPDATE public.products SET
      price=coalesce(v_price,price),
      quantity=coalesce(v_quantity,quantity),
      stock_status=CASE
        WHEN v_stock<>'' THEN v_stock
        WHEN v_quantity=0 THEN 'OUT_OF_STOCK'
        ELSE stock_status
      END,
      updated_at=now()
    WHERE id=v_product_id AND seller_id=v_owner;
    v_updated := v_updated + 1;
  END LOOP;

  INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,details)
  VALUES(
    v_actor,'BULK_UPDATE_INVENTORY','PRODUCT',v_seen[1],
    v_updated::text||' listings updated through the Rust Business inventory API for seller #'||v_owner::text
  );

  RETURN jsonb_build_object('success',true,'updated',v_updated);
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_update_my_inventory(jsonb,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_update_my_inventory(jsonb,bigint) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
