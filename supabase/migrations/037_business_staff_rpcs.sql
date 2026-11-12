-- 037 — Move Business staff writes and entitlement checks into Postgres RPCs.
BEGIN;

CREATE OR REPLACE FUNCTION public.list_my_business_staff()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner bigint;
  v_plan text;
  v_expires timestamptz;
  v_staff jsonb;
  v_memberships jsonb;
BEGIN
  v_owner := public.current_profile_id();
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT plan, expires_at INTO v_plan, v_expires
  FROM public.business_subscriptions
  WHERE user_id = v_owner AND status = 'ACTIVE' AND expires_at > now()
  ORDER BY CASE plan WHEN 'ENTERPRISE' THEN 3 WHEN 'PREMIUM' THEN 2 ELSE 1 END DESC, expires_at DESC
  LIMIT 1;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', s.id, 'memberId', s.member_id,
      'name', coalesce(p.full_name, 'Team member'),
      'email', coalesce(p.email, ''),
      'role', s.role, 'status', s.status, 'createdAt', s.created_at
    ) ORDER BY s.created_at ASC
  ), '[]'::jsonb)
  INTO v_staff
  FROM public.business_staff s
  LEFT JOIN public.profiles p ON p.id = s.member_id
  WHERE s.owner_id = v_owner;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', s.id, 'ownerId', s.owner_id,
      'businessName', coalesce(p.full_name, 'Business owner'),
      'role', s.role, 'status', s.status
    ) ORDER BY s.created_at ASC
  ), '[]'::jsonb)
  INTO v_memberships
  FROM public.business_staff s
  LEFT JOIN public.profiles p ON p.id = s.owner_id
  WHERE s.member_id = v_owner;

  RETURN jsonb_build_object(
    'success', true,
    'canManage', v_plan IS NOT NULL,
    'businessPlan', v_plan,
    'expiresAt', v_expires,
    'staff', v_staff,
    'memberships', v_memberships
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.add_my_business_staff(p_email text, p_role text DEFAULT 'ANALYST')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner bigint;
  v_member public.profiles%ROWTYPE;
  v_staff public.business_staff%ROWTYPE;
  v_email text;
  v_role text;
  v_plan text;
BEGIN
  v_owner := public.current_profile_id();
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  v_email := lower(trim(coalesce(p_email, '')));
  v_role := upper(coalesce(p_role, 'ANALYST'));
  IF v_email = '' OR position('@' in v_email) < 2 OR length(v_email) > 254 THEN
    RAISE EXCEPTION 'Enter the email of an existing GoodSale account';
  END IF;
  IF v_role NOT IN ('MANAGER','INVENTORY','ANALYST') THEN RAISE EXCEPTION 'Invalid staff role'; END IF;

  SELECT plan INTO v_plan FROM public.business_subscriptions
  WHERE user_id=v_owner AND status='ACTIVE' AND expires_at>now()
  ORDER BY CASE plan WHEN 'ENTERPRISE' THEN 3 WHEN 'PREMIUM' THEN 2 ELSE 1 END DESC, expires_at DESC
  LIMIT 1;
  IF v_plan IS NULL THEN RAISE EXCEPTION 'Staff access requires an active Business membership'; END IF;

  SELECT * INTO v_member FROM public.profiles
  WHERE lower(coalesce(email,''))=v_email LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'No GoodSale account uses that email. Ask them to sign up first.'; END IF;
  IF v_member.id=v_owner THEN RAISE EXCEPTION 'You cannot add yourself as staff'; END IF;

  INSERT INTO public.business_staff(owner_id,member_id,role,status,invited_by)
  VALUES(v_owner,v_member.id,v_role,'ACTIVE',v_owner)
  ON CONFLICT(owner_id,member_id) DO UPDATE
    SET role=EXCLUDED.role,status='ACTIVE',updated_at=now()
  RETURNING * INTO v_staff;

  INSERT INTO public.notifications(user_id,title,message,type,is_read)
  VALUES(v_member.id,'Business staff access',
    'You were added as '||lower(v_role)||' staff. Sign in and open Settings to see the business you support.',
    'ACCOUNT',false);
  INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,details)
  VALUES(v_owner,'BUSINESS_STAFF_ADD','PROFILE',v_member.id,'Added '||v_email||' as '||v_role);

  RETURN jsonb_build_object('success',true,'id',v_staff.id,'memberId',v_member.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_my_business_staff(
  p_staff_id bigint, p_role text DEFAULT NULL, p_status text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner bigint;
  v_role text;
  v_status text;
  v_member bigint;
  v_staff public.business_staff%ROWTYPE;
BEGIN
  v_owner := public.current_profile_id();
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_staff_id IS NULL OR p_staff_id<=0 THEN RAISE EXCEPTION 'Staff id is required'; END IF;
  v_role := CASE WHEN p_role IS NULL THEN NULL ELSE upper(p_role) END;
  v_status := CASE WHEN p_status IS NULL THEN NULL ELSE upper(p_status) END;
  IF v_role IS NOT NULL AND v_role NOT IN ('MANAGER','INVENTORY','ANALYST') THEN RAISE EXCEPTION 'Invalid staff role'; END IF;
  IF v_status IS NOT NULL AND v_status NOT IN ('ACTIVE','SUSPENDED') THEN RAISE EXCEPTION 'Invalid staff status'; END IF;
  IF v_role IS NULL AND v_status IS NULL THEN RAISE EXCEPTION 'Nothing to update'; END IF;

  UPDATE public.business_staff
  SET role=coalesce(v_role,role),status=coalesce(v_status,status),updated_at=now()
  WHERE id=p_staff_id AND owner_id=v_owner
  RETURNING * INTO v_staff;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;

  RETURN jsonb_build_object('success',true,'id',v_staff.id,'memberId',v_staff.member_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_my_business_staff(p_staff_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner bigint;
  v_member bigint;
BEGIN
  v_owner := public.current_profile_id();
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  DELETE FROM public.business_staff
  WHERE id=p_staff_id AND owner_id=v_owner
  RETURNING member_id INTO v_member;
  IF v_member IS NULL THEN RAISE EXCEPTION 'Staff member not found'; END IF;

  INSERT INTO public.audit_logs(user_id,action,entity_type,entity_id,details)
  VALUES(v_owner,'BUSINESS_STAFF_REMOVE','PROFILE',v_member,'Removed business staff access');

  RETURN jsonb_build_object('success',true,'memberId',v_member);
END;
$$;

REVOKE ALL ON FUNCTION public.list_my_business_staff() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_my_business_staff(text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_my_business_staff(bigint,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_my_business_staff(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_my_business_staff() TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_my_business_staff(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_my_business_staff(bigint,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_my_business_staff(bigint) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
