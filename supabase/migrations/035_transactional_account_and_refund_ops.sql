-- 035 — Atomic account and refund operations exposed through Rust.
BEGIN;

CREATE OR REPLACE FUNCTION public.redeem_good_points(p_cost integer, p_reason text DEFAULT 'Redeemed reward')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_id bigint;
  v_balance integer;
  v_next integer;
  v_reason text;
BEGIN
  v_profile_id := public.current_profile_id();
  IF v_profile_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_cost IS NULL OR p_cost <= 0 OR p_cost > 100000 THEN RAISE EXCEPTION 'Invalid redemption cost'; END IF;
  v_reason := left(trim(coalesce(nullif(p_reason, ''), 'Redeemed reward')), 240);

  SELECT coalesce(good_points, 0) INTO v_balance
  FROM public.profiles WHERE id = v_profile_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  IF v_balance < p_cost THEN RAISE EXCEPTION 'Insufficient GoodPoints. You need % GP.', p_cost; END IF;

  v_next := v_balance - p_cost;
  UPDATE public.profiles SET good_points = v_next, updated_at = now() WHERE id = v_profile_id;
  INSERT INTO public.good_points_transactions(user_id, points, reason) VALUES (v_profile_id, -p_cost, v_reason);
  INSERT INTO public.notifications(user_id, title, message, type, is_read)
  VALUES (v_profile_id, 'GoodPoints redeemed',
    'You redeemed ' || p_cost::text || ' GoodPoints. Your reward is ready in Settings → GoodPoints.',
    'POINTS', false);
  RETURN jsonb_build_object('success', true, 'balance', v_next);
END;
$$;
REVOKE ALL ON FUNCTION public.redeem_good_points(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_good_points(integer, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_my_account_suspended(p_suspended boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_profile_id bigint;
BEGIN
  v_profile_id := public.current_profile_id();
  IF v_profile_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.profiles SET is_suspended = coalesce(p_suspended, true), updated_at = now()
  WHERE id = v_profile_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile not found'; END IF;
  RETURN jsonb_build_object('success', true, 'suspended', coalesce(p_suspended, true));
END;
$$;
REVOKE ALL ON FUNCTION public.set_my_account_suspended(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_account_suspended(boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_order_refund(p_order_id bigint, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_id bigint;
  v_order public.orders%ROWTYPE;
  v_transaction text;
  v_refund_id bigint;
  v_reference text;
BEGIN
  v_profile_id := public.current_profile_id();
  IF v_profile_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_order_id IS NULL OR p_order_id <= 0 OR length(trim(coalesce(p_reason, ''))) < 10 THEN
    RAISE EXCEPTION 'Order and a 10+ character reason are required';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_order.buyer_id <> v_profile_id THEN RAISE EXCEPTION 'Only the buyer can request this refund'; END IF;
  IF v_order.status NOT IN ('PAID_ESCROW', 'SHIPPED', 'OUT_FOR_DELIVERY', 'PARTIAL_DEPOSIT_PAID') THEN
    RAISE EXCEPTION 'This order is not eligible for a refund request';
  END IF;
  IF EXISTS (SELECT 1 FROM public.refunds WHERE order_id = p_order_id AND status = 'PENDING') THEN
    RAISE EXCEPTION 'A refund request is already under review';
  END IF;

  SELECT transaction_id INTO v_transaction
  FROM public.payment_transactions WHERE order_id = p_order_id
  ORDER BY created_at DESC LIMIT 1;

  v_reference := 'GSR-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISS') || '-' ||
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  INSERT INTO public.refunds(refund_number, transaction_id, order_id, amount, reason, status)
  VALUES (
    v_reference,
    coalesce(v_transaction, 'REFUND-' || v_order.order_number),
    p_order_id,
    coalesce(v_order.total_amount, 0),
    left(trim(p_reason), 1000),
    'PENDING'
  )
  RETURNING id INTO v_refund_id;

  UPDATE public.orders SET status = 'REFUND_REQUESTED', updated_at = now() WHERE id = p_order_id;

  INSERT INTO public.notifications(user_id, title, message, type, is_read)
  VALUES
    (v_order.seller_id, 'Refund requested',
      'Buyer requested a refund on ' || v_order.order_number || ': ' || left(trim(p_reason), 500), 'ESCROW', false),
    (v_order.buyer_id, 'Refund request received',
      'Your refund request for ' || v_order.order_number || ' is under review. Funds remain protected in escrow.', 'ESCROW', false);

  RETURN jsonb_build_object('success', true, 'refundId', v_refund_id, 'reference', v_reference);
END;
$$;
REVOKE ALL ON FUNCTION public.request_order_refund(bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_order_refund(bigint, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
