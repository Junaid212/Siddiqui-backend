-- ============================================================================
-- Siddiqui.digital — Staging Foundation Validation Queries & Test Suite (Revised)
-- Target Staging Host: xnqcdwenfomhnfykmvra.supabase.co
--
-- SPECIFICATION & EXECUTION STATUS:
-- All test blocks below are structured TEST SPECIFICATIONS designed for safe
-- isolated execution against staging. In strict adherence to safety guidelines,
-- no migrations or commands have been executed on live infrastructure by the agent.
-- ============================================================================

-- ============================================================================
-- PART 1: STRUCTURAL & SCHEMA INTEGRITY VERIFICATION (READ-ONLY)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Table Count Verification (Must return exactly 21 public tables)
-- ----------------------------------------------------------------------------
SELECT count(*) AS total_public_tables,
       CASE WHEN count(*) = 21 THEN 'PASS' ELSE 'FAIL' END AS status
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- List all 21 tables alphabetically
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- ----------------------------------------------------------------------------
-- 2. Core Constraints & Business Enums Verification
-- ----------------------------------------------------------------------------
-- Check publication_status check constraint in ebooks (must include 'published' and 'available')
SELECT t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS constraint_definition
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
JOIN pg_namespace n ON t.relnamespace = n.oid
WHERE n.nspname = 'public' 
  AND (c.conname LIKE '%publication_status%' 
    OR c.conname LIKE '%edition_type%' 
    OR c.conname LIKE '%access_tier%'
    OR c.conname LIKE '%chk_entitlement_expiration_consistency%');

-- Check payment statuses check constraint in orders (must include all 9 gateway & refund statuses)
SELECT t.relname AS table_name, c.conname, pg_get_constraintdef(c.oid) AS constraint_definition
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
JOIN pg_namespace n ON t.relnamespace = n.oid
WHERE n.nspname = 'public' AND t.relname = 'orders' AND c.conname LIKE '%status%';

-- ----------------------------------------------------------------------------
-- 3. Data Types & Pricing Precision (No Universal Defaults)
-- ----------------------------------------------------------------------------
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND ((table_name = 'ebooks' AND column_name = 'price')
    OR (table_name = 'orders' AND column_name = 'amount')
    OR (table_name = 'orders' AND column_name = 'refund_amount'));

-- ----------------------------------------------------------------------------
-- 4. 12-Month Access Term Columns in Entitlements
-- ----------------------------------------------------------------------------
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_entitlements'
  AND column_name IN ('reader_access_expires_at', 'ask_sid_access_expires_at', 'expires_at', 'granted_at');

-- ----------------------------------------------------------------------------
-- 5. Partial Unique Index (Entitlement Upgrades, Renewals, Inactive Preservation)
-- ----------------------------------------------------------------------------
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'user_entitlements' AND indexname = 'idx_unique_active_entitlement';

-- ----------------------------------------------------------------------------
-- 6. First 200 Cohort Constraints & Audit Safety
-- ----------------------------------------------------------------------------
SELECT conname, pg_get_constraintdef(c.oid) AS constraint_definition
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
JOIN pg_namespace n ON t.relnamespace = n.oid
WHERE n.nspname = 'public' AND t.relname = 'first_200_cohort';

-- ----------------------------------------------------------------------------
-- 7. Row-Level Security (RLS) Coverage (All 21 Tables Must Have RLS Active)
-- ----------------------------------------------------------------------------
SELECT tablename, 
       rowsecurity,
       CASE WHEN rowsecurity = true THEN 'PASS' ELSE 'FAIL - RLS INACTIVE' END AS rls_status
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- ----------------------------------------------------------------------------
-- 8. Stored Functions Security Attributes (search_path & SECURITY DEFINER)
-- ----------------------------------------------------------------------------
SELECT proname, prosecdef, proconfig
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND proname IN (
    'is_admin', 
    'protect_profile_privilege_escalation', 
    'allocate_first_200_companion', 
    'consume_ask_sid_quota', 
    'sync_entitlement_expiration', 
    'link_user_entitlements',
    'handle_updated_at'
  );

-- ----------------------------------------------------------------------------
-- 9. Trigger Attachments
-- ----------------------------------------------------------------------------
SELECT event_object_table, trigger_name, action_timing, event_manipulation, action_statement
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name;

-- ----------------------------------------------------------------------------
-- 10. Seeded State Verification
-- ----------------------------------------------------------------------------
SELECT 'ask_sid_settings' AS table_name, count(*) AS row_count, 1 AS expected FROM public.ask_sid_settings
UNION ALL SELECT 'ebooks', count(*), 0 FROM public.ebooks
UNION ALL SELECT 'orders', count(*), 0 FROM public.orders
UNION ALL SELECT 'user_entitlements', count(*), 0 FROM public.user_entitlements
UNION ALL SELECT 'first_200_cohort', count(*), 0 FROM public.first_200_cohort;


-- ============================================================================
-- PART 2: TRANSACTIONAL TEST SCENARIOS (WITH SAFE ROLLBACK)
-- Note: Each scenario executes within an explicit transaction ending in ROLLBACK.
-- No mutations persist in the staging database.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TEST 1: Admin Privilege Escalation Prevention
-- Setup: Isolated staging auth user created in auth.users.
-- ----------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
    v_test_uid UUID := gen_random_uuid();
    v_escaped BOOLEAN := false;
BEGIN
    -- 1. Create isolated dummy auth user in auth.users
    INSERT INTO auth.users (id, email, aud, role, created_at, updated_at)
    VALUES (
        v_test_uid, 
        'staging_test_' || replace(v_test_uid::text, '-', '') || '@siddiqui.test', 
        'authenticated', 
        'authenticated', 
        now(), 
        now()
    );

    -- 2. Test INSERT escalation: Caller attempts to create profile with 'admin' account_type
    INSERT INTO public.profiles (id, email, full_name, account_type)
    VALUES (
        v_test_uid, 
        'staging_test_' || replace(v_test_uid::text, '-', '') || '@siddiqui.test', 
        'Staging Reader', 
        'admin'
    );
    
    -- Verify trigger neutralized self-promotion to 'reader'
    IF EXISTS (
        SELECT 1 FROM public.profiles WHERE id = v_test_uid AND account_type = 'admin'
    ) THEN
        RAISE EXCEPTION 'TEST 1.1 FAILED: Self-promotion on INSERT was not neutralized to reader!';
    END IF;
    RAISE NOTICE 'TEST 1.1 PASS: Profile INSERT escalation safely sanitized to reader.';

    -- 3. Test UPDATE escalation: Attempt to change account_type to 'admin'
    BEGIN
        UPDATE public.profiles
        SET account_type = 'admin'
        WHERE id = v_test_uid;
        
        IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_test_uid AND account_type = 'admin') THEN
            v_escaped := true;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            IF SQLERRM LIKE '%Privilege Escalation Blocked%' THEN
                RAISE NOTICE 'TEST 1.2 PASS: UPDATE privilege escalation blocked with expected exception: %', SQLERRM;
            ELSE
                RAISE EXCEPTION 'TEST 1.2 FAILED: Unexpected error (expected Privilege Escalation Blocked): % (%)', SQLERRM, SQLSTATE;
            END IF;
    END;

    IF v_escaped THEN
        RAISE EXCEPTION 'TEST 1.2 FAILED: User was able to promote account_type to admin!';
    END IF;

    RAISE NOTICE 'TEST 1 COMPLETE: Admin privilege escalation protections successfully verified.';
END;
$$;

ROLLBACK;


-- ----------------------------------------------------------------------------
-- TEST 2: First 200 Allocation — Real Mismatched-User, Exact Full Refund,
--         Partial Refund, and Invalid Upgrade Chains
-- ----------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
    v_book_id UUID := gen_random_uuid();
    v_other_book_id UUID := gen_random_uuid();
    v_buyer_uid UUID := gen_random_uuid();
    v_impostor_uid UUID := gen_random_uuid();
    v_buyer_email TEXT := 'cohort_tester@example.com';
    v_order_id UUID := gen_random_uuid();
    v_orig_order_id UUID := gen_random_uuid();
    v_upgrade_order_id UUID := gen_random_uuid();
    v_allocated_1 INTEGER;
    v_allocated_2 INTEGER;
    v_failed BOOLEAN := false;
BEGIN
    -- 1. Setup products
    INSERT INTO public.ebooks (id, sku, title, price, publication_status)
    VALUES 
        (v_book_id, 'TEST-SKU-001', 'Marketing Reclassified', 49.99, 'published'),
        (v_other_book_id, 'TEST-SKU-OTHER', 'Other Publication', 29.99, 'published');

    -- 2. Setup real isolated auth users
    INSERT INTO auth.users (id, email, aud, role) VALUES 
        (v_buyer_uid, v_buyer_email, 'authenticated', 'authenticated'),
        (v_impostor_uid, 'impostor@example.com', 'authenticated', 'authenticated');

    -- 3. Setup initial paid order
    INSERT INTO public.orders (
        id, order_number, user_id, email, customer_name, product_id, book_name, edition_type, 
        amount, currency, status, payment_provider, refund_status, refund_amount
    ) VALUES (
        v_order_id, 'ORD-TEST-001', v_buyer_uid, v_buyer_email, 'Cohort Tester', v_book_id, 'Marketing Reclassified', 'companion',
        49.99, 'USD', 'paid', 'stripe', 'none', 0
    );

    -- Check A: Real Mismatched User Test
    -- Order belongs to v_buyer_uid; caller supplies v_impostor_uid
    v_failed := false;
    BEGIN
        PERFORM public.allocate_first_200_companion(v_buyer_email, v_impostor_uid, v_order_id, v_book_id);
        v_failed := true;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%does not match order user_id%' THEN
            RAISE NOTICE 'TEST 2.A PASS: Mismatched user_id rejected as expected: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'TEST 2.A FAILED: Unexpected error (expected user_id mismatch): % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST 2.A FAILED: Allowed allocation with mismatched user_id!'; END IF;

    -- Check B: Legitimate Partial Refund Test
    -- Order refunded $10 out of $49.99 (e.g. price adjustment). Cohort allocation MUST succeed!
    UPDATE public.orders 
    SET status = 'partially_refunded', refund_status = 'partial', refund_amount = 10.00 
    WHERE id = v_order_id;

    v_allocated_1 := public.allocate_first_200_companion(v_buyer_email, v_buyer_uid, v_order_id, v_book_id);
    IF v_allocated_1 IS NULL OR v_allocated_1 < 1 OR v_allocated_1 > 200 THEN
        RAISE EXCEPTION 'TEST 2.B FAILED: Legitimate partial refund was rejected from cohort allocation! Got: %', v_allocated_1;
    END IF;
    RAISE NOTICE 'TEST 2.B PASS: Legitimate partial refund correctly permitted (allocated cohort #%).', v_allocated_1;

    -- Check C: Duplicate allocation idempotency for same unique buyer
    v_allocated_2 := public.allocate_first_200_companion(v_buyer_email, v_buyer_uid, v_order_id, v_book_id);
    IF v_allocated_2 <> v_allocated_1 THEN
        RAISE EXCEPTION 'TEST 2.C FAILED: Duplicate allocation returned different number (% vs %)!', v_allocated_1, v_allocated_2;
    END IF;
    RAISE NOTICE 'TEST 2.C PASS: Duplicate allocation request idempotently returned existing number (%).', v_allocated_2;

    -- Check D: Exact Full Refund Test (Buyer email MATCHES order email)
    -- Must prove the refund check itself rejects the order (not an email mismatch!)
    UPDATE public.orders 
    SET status = 'paid', refund_status = 'full', refund_amount = 49.99 
    WHERE id = v_order_id;

    -- Clear cohort table row so we test refund validation, not existing buyer return
    DELETE FROM public.first_200_cohort WHERE buyer_email = v_buyer_email;

    v_failed := false;
    BEGIN
        -- Calling with EXACT MATCHING buyer email and user_id
        PERFORM public.allocate_first_200_companion(v_buyer_email, v_buyer_uid, v_order_id, v_book_id);
        v_failed := true;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%fully refunded or cancelled%' THEN
            RAISE EXCEPTION 'TEST 2.D FAILED: Rejected for wrong reason (expected refund error): %', SQLERRM;
        END IF;
        RAISE NOTICE 'TEST 2.D PASS: Fully refunded order correctly rejected by refund check: %', SQLERRM;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST 2.D FAILED: Allowed allocation for fully refunded order!'; END IF;

    -- Check E: Invalid Upgrade Tests
    -- E.1: Setup original order
    INSERT INTO public.orders (
        id, order_number, email, customer_name, product_id, book_name, edition_type, 
        amount, currency, status, payment_provider, refund_status
    ) VALUES (
        v_orig_order_id, 'ORD-ORIG-001', 'upgrade_test@example.com', 'Upgrader', v_book_id, 'Marketing Reclassified', 'online',
        29.99, 'USD', 'paid', 'stripe', 'none'
    );

    -- Setup upgrade order
    INSERT INTO public.orders (
        id, order_number, email, customer_name, product_id, book_name, edition_type, 
        amount, currency, status, payment_provider, is_upgrade, original_order_id
    ) VALUES (
        v_upgrade_order_id, 'ORD-UPG-001', 'upgrade_test@example.com', 'Upgrader', v_book_id, 'Marketing Reclassified', 'upgrade',
        20.00, 'USD', 'paid', 'stripe', true, v_orig_order_id
    );

    -- E.2: Upgrade pointing to refunded original order
    UPDATE public.orders SET status = 'refunded', refund_status = 'full', refund_amount = 29.99 WHERE id = v_orig_order_id;
    v_failed := false;
    BEGIN
        PERFORM public.allocate_first_200_companion('upgrade_test@example.com', NULL, v_upgrade_order_id, v_book_id);
        v_failed := true;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%is not in a paid status%' OR SQLERRM LIKE '%fully refunded or cancelled%' THEN
            RAISE NOTICE 'TEST 2.E.1 PASS: Upgrade rejected because original order is refunded: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'TEST 2.E.1 FAILED: Unexpected error: % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST 2.E.1 FAILED: Allowed upgrade on refunded original order!'; END IF;

    -- E.3: Upgrade pointing to mismatched original buyer
    UPDATE public.orders SET status = 'paid', refund_status = 'none', refund_amount = 0, email = 'victim@example.com' WHERE id = v_orig_order_id;
    v_failed := false;
    BEGIN
        PERFORM public.allocate_first_200_companion('upgrade_test@example.com', NULL, v_upgrade_order_id, v_book_id);
        v_failed := true;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%does not match upgrade buyer%' THEN
            RAISE NOTICE 'TEST 2.E.2 PASS: Upgrade rejected because original buyer mismatched: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'TEST 2.E.2 FAILED: Unexpected error: % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST 2.E.2 FAILED: Allowed upgrade with mismatched original buyer!'; END IF;

    -- E.4: Upgrade pointing to original order for different book
    UPDATE public.orders SET email = 'upgrade_test@example.com', product_id = v_other_book_id WHERE id = v_orig_order_id;
    v_failed := false;
    BEGIN
        PERFORM public.allocate_first_200_companion('upgrade_test@example.com', NULL, v_upgrade_order_id, v_book_id);
        v_failed := true;
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM LIKE '%does not match upgrade book%' THEN
            RAISE NOTICE 'TEST 2.E.3 PASS: Upgrade rejected because original book mismatched: %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'TEST 2.E.3 FAILED: Unexpected error: % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST 2.E.3 FAILED: Allowed upgrade with mismatched original product!'; END IF;

    -- E.5: Valid upgrade order allocation
    UPDATE public.orders SET product_id = v_book_id WHERE id = v_orig_order_id;
    v_allocated_1 := public.allocate_first_200_companion('upgrade_test@example.com', NULL, v_upgrade_order_id, v_book_id);
    IF v_allocated_1 IS NULL THEN
        RAISE EXCEPTION 'TEST 2.E.4 FAILED: Valid upgrade order failed cohort allocation!';
    END IF;
    RAISE NOTICE 'TEST 2.E.4 PASS: Valid upgrade order successfully allocated cohort #%.', v_allocated_1;

    RAISE NOTICE 'TEST 2 COMPLETE: First 200 allocation guards, refunds, and upgrades successfully verified.';
END;
$$;

ROLLBACK;


-- ----------------------------------------------------------------------------
-- TEST 3: Entitlement Expiry with Deliberately Custom granted_at
-- ----------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
    v_book_id UUID := gen_random_uuid();
    v_custom_grant TIMESTAMPTZ := '2024-05-01 10:00:00+00';
    v_expected_expiry TIMESTAMPTZ := '2025-05-01 10:00:00+00';
    v_ent RECORD;
BEGIN
    INSERT INTO public.ebooks (id, sku, title, price, publication_status)
    VALUES (v_book_id, 'TEST-SKU-003', 'Expiry Book', 29.99, 'published');

    -- 1. Insert Digital Companion with custom granted_at
    INSERT INTO public.user_entitlements (
        email, book_id, access_tier, is_active, granted_at
    ) VALUES (
        'custom_grant_tester@example.com', v_book_id, 'companion', true, v_custom_grant
    ) RETURNING * INTO v_ent;

    IF v_ent.expires_at <> v_expected_expiry THEN
        RAISE EXCEPTION 'TEST 3.1 FAILED: Expected canonical expires_at %, got %', v_expected_expiry, v_ent.expires_at;
    END IF;
    IF v_ent.reader_access_expires_at <> v_expected_expiry THEN
        RAISE EXCEPTION 'TEST 3.1 FAILED: Expected reader_access_expires_at %, got %', v_expected_expiry, v_ent.reader_access_expires_at;
    END IF;
    IF v_ent.ask_sid_access_expires_at <> v_expected_expiry THEN
        RAISE EXCEPTION 'TEST 3.1 FAILED: Expected ask_sid_access_expires_at %, got %', v_expected_expiry, v_ent.ask_sid_access_expires_at;
    END IF;
    RAISE NOTICE 'TEST 3.1 PASS: Custom granted_at correctly derived all 12-month expiry fields to %.', v_expected_expiry;

    -- 2. Test Online Edition: Ask SID expiry must be locked to granted_at (zero access window)
    INSERT INTO public.user_entitlements (
        email, book_id, access_tier, is_active, granted_at
    ) VALUES (
        'online_only_tester@example.com', v_book_id, 'online', true, v_custom_grant
    ) RETURNING * INTO v_ent;

    IF v_ent.reader_access_expires_at <> v_expected_expiry THEN
        RAISE EXCEPTION 'TEST 3.2 FAILED: Online reader access not 12 months!';
    END IF;
    IF v_ent.ask_sid_access_expires_at > v_custom_grant THEN
        RAISE EXCEPTION 'TEST 3.2 FAILED: Online edition must never have Ask SID access! Got %', v_ent.ask_sid_access_expires_at;
    END IF;
    RAISE NOTICE 'TEST 3.2 PASS: Online Edition has zero Ask SID duration (ask_sid_access_expires_at = granted_at).';

    -- 3. Test UPDATE trying to force desynchronization
    UPDATE public.user_entitlements
    SET reader_access_expires_at = now() + interval '5 years'
    WHERE id = v_ent.id
    RETURNING * INTO v_ent;

    -- Trigger must re-derive reader_access_expires_at to match canonical expires_at
    IF v_ent.reader_access_expires_at <> v_ent.expires_at THEN
        RAISE EXCEPTION 'TEST 3.3 FAILED: Trigger failed to enforce consistency on manual UPDATE!';
    END IF;
    RAISE NOTICE 'TEST 3.3 PASS: Consistency trigger prevented desynchronization on UPDATE.';

    RAISE NOTICE 'TEST 3 COMPLETE: Custom granted_at and expiration derivation successfully verified.';
END;
$$;

ROLLBACK;


-- ----------------------------------------------------------------------------
-- TEST 4: Ask SID Canonical User Identity, Daily 5 & Lifetime 100/150 Quota
--
-- EXECUTION & PERMISSIONS SPECIFICATION:
-- The function public.consume_ask_sid_quota(...) is strictly restricted to service_role.
-- Direct execution by authenticated end-users or anonymous clients is blocked by PostgreSQL
-- privilege checks. In production, client requests reach Express API endpoints, which verify
-- JWT claims and invoke RPC as the trusted Supabase service_role.
--
-- STAGING OPERATOR EXECUTION INSTRUCTIONS:
-- Execute this test script as a privileged database operator (e.g. Supabase SQL Editor or
-- psql session as 'postgres'/'service_role'). Note that in PostgreSQL, SET [LOCAL] ROLE
-- service_role requires the executing session to hold service_role membership; an unprivileged
-- client will be rejected with SQLSTATE 42501.
-- The test explicitly validates:
-- 1. Negative Test: 'authenticated' and 'anon' roles are denied EXECUTE on the function.
-- 2. Positive Test: 'service_role' executes full quota validation (daily 5, lifetime 100/150).
-- ----------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
    v_book_id UUID := gen_random_uuid();
    v_user_uid UUID := gen_random_uuid();
    v_user_email TEXT := 'quota_canonical@example.com';
    v_ent_id UUID;
    v_order_id UUID := gen_random_uuid();
    v_result JSONB;
    v_i INTEGER;
    v_failed BOOLEAN := false;
BEGIN
    INSERT INTO public.ebooks (id, sku, title, price, publication_status)
    VALUES (v_book_id, 'TEST-SKU-004', 'Quota Book', 49.99, 'published');

    INSERT INTO auth.users (id, email, aud, role)
    VALUES (v_user_uid, v_user_email, 'authenticated', 'authenticated');

    -- Setup verified paid order to satisfy foreign-key dependencies for cohort and entitlement
    INSERT INTO public.orders (
        id, order_number, user_id, email, customer_name, product_id, book_name, edition_type, 
        amount, currency, status, payment_provider
    ) VALUES (
        v_order_id, 'ORD-TEST-004', v_user_uid, v_user_email, 'Quota Tester', v_book_id, 'Quota Book', 'companion',
        49.99, 'USD', 'paid', 'stripe'
    );

    -- Setup active Companion entitlement linked to v_user_uid and v_order_id
    -- NOTE: granted_at established 30 days in the past so historical logs are validly within the 12-month window
    INSERT INTO public.user_entitlements (
        user_id, email, book_id, access_tier, is_active, granted_at, order_id
    ) VALUES (
        v_user_uid, v_user_email, v_book_id, 'companion', true, now() - interval '30 days', v_order_id
    ) RETURNING id INTO v_ent_id;

    -- ------------------------------------------------------------------------
    -- STEP A: Negative Security Verification — Function Execution Permissions
    -- Prove that non-service_role callers cannot execute consume_ask_sid_quota
    -- ------------------------------------------------------------------------
    SET LOCAL ROLE authenticated;
    PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
        'sub', v_user_uid::text,
        'role', 'authenticated'
    )::text,
    true
);

    v_failed := false;
    BEGIN
        PERFORM public.consume_ask_sid_quota(v_user_uid, v_user_email, 'session_1', '127.0.0.1', 'Unauthorized call?', false);
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST 4.A.1 PASS: Authenticated role correctly denied EXECUTE on consume_ask_sid_quota (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST 4.A.1 PASS: Authenticated role denied EXECUTE (SQLSTATE 42501): %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'TEST 4.A.1 FAILED: Unexpected error (expected SQLSTATE 42501): % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN
        RAISE EXCEPTION 'TEST 4.A.1 FAILED: Authenticated user was able to execute consume_ask_sid_quota directly!';
    END IF;

    SET LOCAL ROLE anon;
    SET LOCAL "request.jwt.claims" = '{}';

    v_failed := false;
    BEGIN
        PERFORM public.consume_ask_sid_quota(NULL, '', 'session_1', '127.0.0.1', 'Anon call?', false);
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST 4.A.2 PASS: Anonymous role correctly denied EXECUTE on consume_ask_sid_quota (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST 4.A.2 PASS: Anonymous role denied EXECUTE (SQLSTATE 42501): %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'TEST 4.A.2 FAILED: Unexpected error (expected SQLSTATE 42501): % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN
        RAISE EXCEPTION 'TEST 4.A.2 FAILED: Anonymous user was able to execute consume_ask_sid_quota directly!';
    END IF;

    -- ------------------------------------------------------------------------
    -- STEP B: Positive Quota Engine Verification under 'service_role'
    -- ------------------------------------------------------------------------
    RESET ROLE;
    SET LOCAL ROLE service_role;

    -- 1. Test missing authenticated user identity for Companion access
    v_result := public.consume_ask_sid_quota(NULL, '', 'session_1', '127.0.0.1', 'Hello?', false);
    IF (v_result ->> 'allowed')::boolean = true OR v_result ->> 'reason' <> 'authentication_required' THEN
        RAISE EXCEPTION 'TEST 4.1 FAILED: Companion request without user_id was not rejected! Result: %', v_result;
    END IF;
    RAISE NOTICE 'TEST 4.1 PASS: Companion request without authenticated identity rejected: authentication_required.';

    -- 2. Daily Limit: Consume 5 questions
    FOR v_i IN 1..5 LOOP
        v_result := public.consume_ask_sid_quota(v_user_uid, v_user_email, 'session_1', '127.0.0.1', 'Daily ' || v_i, false);
        IF (v_result ->> 'allowed')::boolean <> true THEN
            RAISE EXCEPTION 'TEST 4.2 FAILED: Question % was blocked prematurely: %', v_i, v_result;
        END IF;
    END LOOP;

    -- 6th question on same UTC day must be blocked by daily limit
    v_result := public.consume_ask_sid_quota(v_user_uid, v_user_email, 'session_1', '127.0.0.1', 'Daily 6', false);
    IF (v_result ->> 'allowed')::boolean = true OR v_result ->> 'reason' <> 'daily_limit_reached' THEN
        RAISE EXCEPTION 'TEST 4.2 FAILED: 6th question was permitted, exceeding daily limit! Result: %', v_result;
    END IF;
    RAISE NOTICE 'TEST 4.2 PASS: Daily 5-question limit strictly enforced.';

    -- Clear today''s logs to allow testing lifetime limit independently of daily cap
    DELETE FROM public.ask_sid_usage_logs 
    WHERE user_id = v_user_uid 
      AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');

    -- 3. Standard Lifetime Limit (100 questions):
    -- Insert exactly 99 historical logs created after granted_at and before current UTC day
    INSERT INTO public.ask_sid_usage_logs (entitlement_id, user_id, email, session_id, ip_address, question, is_demo, access_level, created_at)
    SELECT v_ent_id, v_user_uid, v_user_email, 'session_1', '127.0.0.1', 'Past ' || s, false, 'full', now() - interval '2 days'
    FROM generate_series(1, 99) AS s;

    -- Question 100 is asked today: daily count = 0 (< 5), lifetime count = 99 (< 100) -> MUST SUCCEED
    v_result := public.consume_ask_sid_quota(v_user_uid, v_user_email, 'session_1', '127.0.0.1', 'Question 100', false);
    IF (v_result ->> 'allowed')::boolean <> true OR (v_result ->> 'lifetime_used')::integer <> 100 THEN
        RAISE EXCEPTION 'TEST 4.3 FAILED: 100th question was blocked: %', v_result;
    END IF;
    RAISE NOTICE 'TEST 4.3 PASS: 100th question successfully consumed (lifetime_used = 100).';

    -- Question 101: daily count = 1 (< 5), lifetime count = 100 (>= 100) -> MUST BE BLOCKED BY LIFETIME LIMIT
    v_result := public.consume_ask_sid_quota(v_user_uid, v_user_email, 'session_1', '127.0.0.1', 'Question 101', false);
    IF (v_result ->> 'allowed')::boolean = true OR v_result ->> 'reason' <> 'lifetime_limit_reached' THEN
        RAISE EXCEPTION 'TEST 4.3 FAILED: 101st question was not blocked by standard lifetime limit! Result: %', v_result;
    END IF;
    RAISE NOTICE 'TEST 4.3 PASS: Standard Companion 100 lifetime limit correctly enforced (blocked at question 101).';

    -- 4. First 200 Cohort Lifetime Limit (150 questions):
    -- Assign user to First 200 cohort with valid order_id and book_id
    INSERT INTO public.first_200_cohort (
        cohort_number, buyer_email, user_id, order_id, book_id, status, assigned_at
    ) VALUES (
        1, v_user_email, v_user_uid, v_order_id, v_book_id, 'active', now()
    );

    -- Question 101 as cohort member: daily count = 1 (< 5), lifetime count = 100 (< 150) -> MUST SUCCEED
    v_result := public.consume_ask_sid_quota(v_user_uid, v_user_email, 'session_1', '127.0.0.1', 'Cohort 101', false);
    IF (v_result ->> 'allowed')::boolean <> true OR (v_result ->> 'is_first_200')::boolean <> true OR (v_result ->> 'lifetime_used')::integer <> 101 THEN
        RAISE EXCEPTION 'TEST 4.4 FAILED: Cohort member question #101 was not permitted! Result: %', v_result;
    END IF;
    RAISE NOTICE 'TEST 4.4 PASS: First 200 Cohort member successfully permitted question 101.';

    -- Fast-forward logs to 149 questions:
    -- Current count: 99 past logs + 2 today logs (Q100 and Q101) = 101 questions.
    -- Insert 48 historical logs before today: 101 + 48 = 149 questions.
    INSERT INTO public.ask_sid_usage_logs (entitlement_id, user_id, email, session_id, ip_address, question, is_demo, access_level, created_at)
    SELECT v_ent_id, v_user_uid, v_user_email, 'session_1', '127.0.0.1', 'Cohort Past ' || s, false, 'full', now() - interval '3 days'
    FROM generate_series(102, 149) AS s;

    -- Question 150: daily count = 2 (< 5), lifetime count = 149 (< 150) -> MUST SUCCEED
    v_result := public.consume_ask_sid_quota(v_user_uid, v_user_email, 'session_1', '127.0.0.1', 'Cohort 150', false);
    IF (v_result ->> 'allowed')::boolean <> true OR (v_result ->> 'lifetime_used')::integer <> 150 THEN
        RAISE EXCEPTION 'TEST 4.4 FAILED: Cohort 150th question was blocked! Result: %', v_result;
    END IF;
    RAISE NOTICE 'TEST 4.4 PASS: First 200 Cohort 150th question permitted (lifetime_used = 150).';

    -- Question 151: daily count = 3 (< 5), lifetime count = 150 (>= 150) -> MUST BE BLOCKED BY LIFETIME LIMIT
    v_result := public.consume_ask_sid_quota(v_user_uid, v_user_email, 'session_1', '127.0.0.1', 'Cohort 151', false);
    IF (v_result ->> 'allowed')::boolean = true OR v_result ->> 'reason' <> 'lifetime_limit_reached' THEN
        RAISE EXCEPTION 'TEST 4.4 FAILED: Cohort 151st question was not blocked by 150 lifetime limit! Result: %', v_result;
    END IF;
    RAISE NOTICE 'TEST 4.4 PASS: First 200 Cohort 150 lifetime limit correctly enforced (blocked at question 151).';

    RESET ROLE;
    RAISE NOTICE 'TEST 4 COMPLETE: Quota engine permissions, canonical identity, daily and lifetime limits successfully verified.';
END;
$$;

ROLLBACK;


-- ----------------------------------------------------------------------------
-- TEST 5: Secure Payhip Entitlement Linking (Confirmed Email Requirement)
-- ----------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
    v_book_id UUID := gen_random_uuid();
    v_order_id UUID := gen_random_uuid();
    v_payhip_email TEXT := 'payhip_buyer@example.com';
    v_buyer_uid UUID := gen_random_uuid();
    v_unconfirmed_uid UUID := gen_random_uuid();
    v_attacker_uid UUID := gen_random_uuid();
    v_result JSONB;
    v_ent RECORD;
BEGIN
    INSERT INTO public.ebooks (id, sku, title, price, publication_status)
    VALUES (v_book_id, 'TEST-SKU-005', 'Payhip Book', 49.99, 'published');

    -- 1. Simulate Payhip webhook: creates unlinked order and entitlement
    INSERT INTO public.orders (
        id, order_number, email, customer_name, product_id, book_name, edition_type, 
        amount, currency, status, payment_provider
    ) VALUES (
        v_order_id, 'ORD-PAYHIP-001', v_payhip_email, 'Payhip Buyer', v_book_id, 'Payhip Book', 'companion',
        49.99, 'USD', 'paid', 'payhip'
    );

    INSERT INTO public.user_entitlements (
        email, book_id, access_tier, is_active, order_id, user_id
    ) VALUES (
        v_payhip_email, v_book_id, 'companion', true, v_order_id, NULL
    );

    -- 2. Negative Test: User with UNCONFIRMED email attempts to claim
    INSERT INTO auth.users (id, email, aud, role, email_confirmed_at)
    VALUES (v_unconfirmed_uid, v_payhip_email, 'authenticated', 'authenticated', NULL);

    SET LOCAL ROLE authenticated;
    PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
        'sub', v_unconfirmed_uid::text,
        'role', 'authenticated'
    )::text,
    true
);

    v_result := public.link_user_entitlements();
    IF (v_result ->> 'success')::boolean = true OR v_result ->> 'reason' <> 'unverified_email' THEN
        RAISE EXCEPTION 'TEST 5.1 FAILED: Unconfirmed email user was allowed to claim purchase! Result: %', v_result;
    END IF;
    RAISE NOTICE 'TEST 5.1 PASS: Unconfirmed email caller correctly rejected from claiming purchases.';

    -- 3. Negative Test: Attacker with different email attempts to claim
    RESET ROLE;
    INSERT INTO auth.users (id, email, aud, role, email_confirmed_at)
    VALUES (v_attacker_uid, 'attacker@example.com', 'authenticated', 'authenticated', now());

    SET LOCAL ROLE authenticated;
    PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
        'sub', v_attacker_uid::text,
        'role', 'authenticated'
    )::text,
    true
);

    v_result := public.link_user_entitlements();
    IF (v_result ->> 'entitlements_linked')::integer <> 0 THEN
        RAISE EXCEPTION 'TEST 5.2 FAILED: Attacker claimed victim purchases! Result: %', v_result;
    END IF;
    RAISE NOTICE 'TEST 5.2 PASS: Attacker with different email claimed 0 rows.';

    -- 4. Positive Test: Legitimate buyer with confirmed email claims purchases
    RESET ROLE;
    INSERT INTO auth.users (id, email, aud, role, email_confirmed_at)
    VALUES (v_buyer_uid, v_payhip_email, 'authenticated', 'authenticated', now());

    SET LOCAL ROLE authenticated;
    PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
        'sub', v_buyer_uid::text,
        'role', 'authenticated'
    )::text,
    true
);

    v_result := public.link_user_entitlements();
    IF (v_result ->> 'success')::boolean <> true OR (v_result ->> 'entitlements_linked')::integer <> 1 THEN
        RAISE EXCEPTION 'TEST 5.3 FAILED: Confirmed buyer failed to claim purchase! Result: %', v_result;
    END IF;
    RAISE NOTICE 'TEST 5.3 PASS: Confirmed buyer successfully claimed % entitlement and % order.', 
        v_result ->> 'entitlements_linked', v_result ->> 'orders_linked';

    RESET ROLE;
    SELECT * INTO v_ent FROM public.user_entitlements WHERE order_id = v_order_id;
    IF v_ent.user_id IS DISTINCT FROM v_buyer_uid THEN
        RAISE EXCEPTION 'TEST 5.4 FAILED: Entitlement was not updated with buyer user_id!';
    END IF;
    RAISE NOTICE 'TEST 5 COMPLETE: Secure Payhip entitlement linking successfully verified.';
END;
$$;

ROLLBACK;


-- ----------------------------------------------------------------------------
-- TEST 6: Diagnostic Questionnaire Relational Integrity & Option Mismatch
-- ----------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
    v_q1 UUID := gen_random_uuid();
    v_q2 UUID := gen_random_uuid();
    v_opt1 UUID := gen_random_uuid();
    v_opt2 UUID := gen_random_uuid();
    v_vote_id UUID := gen_random_uuid();
    v_failed BOOLEAN := false;
BEGIN
    -- 1. Create two separate questions
    INSERT INTO public.questions (id, question_text, order_index)
    VALUES 
        (v_q1, 'What is your primary market segment?', 1),
        (v_q2, 'How do you measure marketing ROI?', 2);

    -- 2. Create one option for each question
    INSERT INTO public.question_options (id, question_id, option_text, score, order_index)
    VALUES 
        (v_opt1, v_q1, 'B2B Enterprise', 10, 1),
        (v_opt2, v_q2, 'Customer Lifetime Value', 20, 1);

    -- 3. Legitimate vote: Option 1 belongs to Question 1 -> must succeed
    INSERT INTO public.question_votes (id, question_id, option_id, voter_ip)
    VALUES (v_vote_id, v_q1, v_opt1, '192.168.1.1');
    RAISE NOTICE 'TEST 6.1 PASS: Legitimate vote matching question and option succeeded.';

    -- 4. Cross-Question Vote: Option 2 belongs to Question 2, but vote specifies Question 1!
    -- Composite FK (option_id, question_id) must reject this!
    v_failed := false;
    BEGIN
        INSERT INTO public.question_votes (question_id, option_id, voter_ip)
        VALUES (v_q1, v_opt2, '192.168.1.1');
        v_failed := true;
    EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE 'TEST 6.2 PASS: Mismatched option rejected by composite foreign key constraint (SQLSTATE 23503): %', SQLERRM;
    WHEN OTHERS THEN
        IF SQLSTATE = '23503' THEN
            RAISE NOTICE 'TEST 6.2 PASS: Mismatched option rejected by composite foreign key constraint (SQLSTATE 23503): %', SQLERRM;
        ELSE
            RAISE EXCEPTION 'TEST 6.2 FAILED: Expected SQLSTATE 23503 (foreign_key_violation), got SQLSTATE %: %', SQLSTATE, SQLERRM;
        END IF;
    END;
    IF v_failed THEN
        RAISE EXCEPTION 'TEST 6.2 FAILED: Allowed vote with option_id from a different question!';
    END IF;

    RAISE NOTICE 'TEST 6 COMPLETE: Diagnostic questionnaire composite integrity successfully verified.';
END;
$$;

ROLLBACK;


-- ============================================================================
-- PART 3: COMPREHENSIVE ROW-LEVEL SECURITY (RLS) VERIFICATION SUITE
-- Tests positive admin operations, negative anonymous & non-admin denials,
-- privileged-field protection, and verifies that RLS denials raise SQLSTATE 42501.
--
-- EXECUTION & PERMISSIONS SPECIFICATION:
-- Staging operators must execute this transaction block from a privileged database connection
-- (e.g. Supabase SQL Editor as 'postgres' or backend database migration tool).
-- Context Note: In PostgreSQL, SET [LOCAL] ROLE service_role requires the executing session
-- user to possess service_role membership; an unprivileged connection will be rejected with
-- SQLSTATE 42501.
-- 1. Setup Phase: Initial seed catalog and admin user fixture are created under the privileged
--    session. Specifically, the test admin profile is assigned account_type = 'admin' via
--    temporary transition to service_role, and statically verified before testing.
-- 2. Section 1 (Anon): Evaluates policy enforcement under SET LOCAL ROLE anon.
-- 3. Section 2 (Non-Admin): Evaluates policy enforcement under SET LOCAL ROLE authenticated (as reader).
-- 4. Section 3 (Admin): Evaluates positive admin operations under SET LOCAL ROLE authenticated (as admin).
-- ============================================================================

BEGIN;

DO $$
DECLARE
    v_pub_book UUID := gen_random_uuid();
    v_dft_book UUID := gen_random_uuid();
    v_pub_chap UUID := gen_random_uuid();
    v_dft_chap UUID := gen_random_uuid();
    v_node_id UUID := gen_random_uuid();
    v_pub_blog UUID := gen_random_uuid();
    v_dft_blog UUID := gen_random_uuid();
    v_q1 UUID := gen_random_uuid();
    v_opt1 UUID := gen_random_uuid();
    v_q_admin UUID := gen_random_uuid();
    v_user_a_uid UUID := gen_random_uuid();
    v_user_b_uid UUID := gen_random_uuid();
    v_admin_uid UUID := gen_random_uuid();
    v_order_a UUID := gen_random_uuid();
    v_ent_a UUID := gen_random_uuid();
    v_sub_id UUID := gen_random_uuid();
    v_setting_bool BOOLEAN;
    v_count INTEGER;
    v_failed BOOLEAN := false;
BEGIN
    -- ------------------------------------------------------------------------
    -- 1. Setup seed catalog & private records as postgres superuser
    -- ------------------------------------------------------------------------
    INSERT INTO public.ebooks (id, sku, title, price, publication_status, active)
    VALUES 
        (v_pub_book, 'RLS-PUB-001', 'Published Book', 49.99, 'published', true),
        (v_dft_book, 'RLS-DFT-001', 'Draft Secret Book', 49.99, 'draft', true);

    INSERT INTO public.book_chapters (id, book_id, chapter_number, title, slug, content_markdown, status, is_preview)
    VALUES 
        (v_pub_chap, v_pub_book, 1, 'Published Chapter 1', 'pub-chap-1', 'Sample Chapter Content', 'published', true),
        (v_dft_chap, v_pub_book, 2, 'Unpublished Draft Chapter 2', 'dft-chap-2', 'Confidential Draft Content', 'draft', false);

    INSERT INTO public.book_knowledge_nodes (id, book_id, node_key, title, understanding, perspective)
    VALUES (v_node_id, v_pub_book, 'core-strategy-node', 'Core Strategy Node', 'Understanding grounded principles', 'Strategic executive perspective');

    INSERT INTO public.blogs (id, slug, title, content, status)
    VALUES 
        (v_pub_blog, 'pub-blog', 'Published Article', 'Content', 'published'),
        (v_dft_blog, 'dft-blog', 'Draft Article', 'Content', 'draft');

    INSERT INTO public.questions (id, question_text, order_index)
    VALUES (v_q1, 'Diagnostic Question', 1);

    INSERT INTO public.question_options (id, question_id, option_text, score, order_index)
    VALUES (v_opt1, v_q1, 'Option A', 10, 1);

    -- Seed coupon for RLS coupon policy validation
    INSERT INTO public.coupons (id, code, discount_percentage)
    VALUES ('COUPON-TEST', 'LAUNCH50', 50.00);

    -- Create test users in auth.users
    INSERT INTO auth.users (id, email, aud, role)
    VALUES 
        (v_user_a_uid, 'user_a@example.com', 'authenticated', 'authenticated'),
        (v_user_b_uid, 'user_b@example.com', 'authenticated', 'authenticated'),
        (v_admin_uid, 'admin_rls@siddiqui.test', 'authenticated', 'authenticated');

    -- Setup profiles
    INSERT INTO public.profiles (id, email, full_name, account_type)
    VALUES 
        (v_user_a_uid, 'user_a@example.com', 'User A', 'reader'),
        (v_user_b_uid, 'user_b@example.com', 'Reader User B', 'reader');

    -- Admin profile created via service_role to establish genuine admin account_type
    SET LOCAL ROLE service_role;
    INSERT INTO public.profiles (id, email, full_name, account_type)
    VALUES (v_admin_uid, 'admin_rls@siddiqui.test', 'Staging Admin', 'admin');
    RESET ROLE;

    -- Statically verify the admin profile was created with account_type = 'admin'
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles WHERE id = v_admin_uid AND account_type = 'admin'
    ) THEN
        RAISE EXCEPTION 'SETUP FAILED: Admin test profile was not established with account_type admin. Ensure session operator has service_role privileges.';
    END IF;

    INSERT INTO public.orders (
        id, order_number, user_id, email, customer_name, product_id, book_name, edition_type, amount, currency, status, payment_provider
    ) VALUES (
        v_order_a, 'ORD-RLS-A', v_user_a_uid, 'user_a@example.com', 'User A', v_pub_book, 'Published Book', 'companion', 49.99, 'USD', 'paid', 'stripe'
    );

    INSERT INTO public.user_entitlements (
        id, user_id, email, book_id, access_tier, is_active, order_id
    ) VALUES (
        v_ent_a, v_user_a_uid, 'user_a@example.com', v_pub_book, 'companion', true, v_order_a
    );

    -- first_200_cohort uses cohort_number as primary key (no id column)
    INSERT INTO public.first_200_cohort (
        cohort_number, buyer_email, user_id, order_id, book_id, status
    ) VALUES (
        1, 'user_a@example.com', v_user_a_uid, v_order_a, v_pub_book, 'active'
    );

    INSERT INTO public.questionnaire_submissions (
        id, user_id, profile, answers, total_score, perception_category
    ) VALUES (
        v_sub_id, v_user_a_uid, 'Executive', '{"q1": "a"}'::jsonb, 10, 'Leader'
    );

    -- ------------------------------------------------------------------------
    -- SECTION 1: ANONYMOUS ('anon') RLS VERIFICATION
    -- ------------------------------------------------------------------------
    SET LOCAL ROLE anon;
    SET LOCAL "request.jwt.claims" = '{}';

    -- A. Positive Public Reads
    SELECT count(*) INTO v_count FROM public.ebooks WHERE id = v_pub_book;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 1.A FAILED: Anon could not read published ebook!'; END IF;

    SELECT count(*) INTO v_count FROM public.book_chapters WHERE id = v_pub_chap;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 1.B FAILED: Anon could not read published chapter!'; END IF;

    SELECT count(*) INTO v_count FROM public.blogs WHERE id = v_pub_blog;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 1.C FAILED: Anon could not read published blog!'; END IF;

    SELECT count(*) INTO v_count FROM public.questions WHERE id = v_q1;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 1.D FAILED: Anon could not read questions!'; END IF;

    SELECT count(*) INTO v_count FROM public.question_options WHERE id = v_opt1;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 1.E FAILED: Anon could not read question options!'; END IF;

    SELECT count(*) INTO v_count FROM public.ask_sid_settings WHERE id = 'default';
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 1.F FAILED: Anon could not read ask_sid_settings!'; END IF;
    RAISE NOTICE 'TEST RLS 1.A-F PASS: Anonymous caller successfully reads published ebooks, chapters, blogs, questions, settings.';

    -- B. Negative Read Denials (Drafts, Internal Data, Sensitive Tables)
    SELECT count(*) INTO v_count FROM public.ebooks WHERE id = v_dft_book;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 1.G FAILED: Anon read draft ebook!'; END IF;

    SELECT count(*) INTO v_count FROM public.book_chapters WHERE id = v_dft_chap;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 1.H FAILED: Anon read unpublished chapter!'; END IF;

    SELECT count(*) INTO v_count FROM public.blogs WHERE id = v_dft_blog;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 1.I FAILED: Anon read draft blog!'; END IF;

    SELECT count(*) INTO v_count FROM public.book_knowledge_nodes WHERE book_id = v_pub_book;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 1.J FAILED: Anon read Ask SID knowledge nodes!'; END IF;

    SELECT count(*) INTO v_count FROM public.orders;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 1.K FAILED: Anon read orders table!'; END IF;

    SELECT count(*) INTO v_count FROM public.user_entitlements;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 1.L FAILED: Anon read user_entitlements table!'; END IF;

    SELECT count(*) INTO v_count FROM public.first_200_cohort;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 1.M FAILED: Anon read first_200_cohort table!'; END IF;

    SELECT count(*) INTO v_count FROM public.questionnaire_submissions;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 1.N FAILED: Anon read questionnaire submissions!'; END IF;

    SELECT count(*) INTO v_count FROM public.webhook_logs;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 1.O FAILED: Anon read webhook_logs!'; END IF;
    RAISE NOTICE 'TEST RLS 1.G-O PASS: Anonymous caller denied read access to all drafts and sensitive internal tables.';

    -- C. Negative Direct Insert Attempts into Sensitive Tables (Must Fail with SQLSTATE 42501)
    v_failed := false;
    BEGIN
        INSERT INTO public.orders (order_number, email, book_name, amount, payment_provider)
        VALUES ('ORD-ANON-INJECT', 'anon@test.com', 'Book', 1.00, 'stripe');
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 1.P PASS: Anon direct insert on orders blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 1.P PASS: Anon direct insert on orders blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 1.P FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 1.P FAILED: Anon allowed to insert into orders!'; END IF;

    v_failed := false;
    BEGIN
        INSERT INTO public.user_entitlements (email, book_id, access_tier, reader_access_expires_at, ask_sid_access_expires_at, expires_at)
        VALUES ('anon@test.com', v_pub_book, 'companion', now(), now(), now());
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 1.Q PASS: Anon direct insert on user_entitlements blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 1.Q PASS: Anon direct insert on user_entitlements blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 1.Q FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 1.Q FAILED: Anon allowed to insert into user_entitlements!'; END IF;

    v_failed := false;
    BEGIN
        INSERT INTO public.first_200_cohort (cohort_number, buyer_email, order_id, book_id)
        VALUES (200, 'anon@test.com', v_order_a, v_pub_book);
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 1.R PASS: Anon direct insert on first_200_cohort blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 1.R PASS: Anon direct insert on first_200_cohort blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 1.R FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 1.R FAILED: Anon allowed to insert into first_200_cohort!'; END IF;

    v_failed := false;
    BEGIN
        INSERT INTO public.book_knowledge_nodes (book_id, node_key, title, understanding, perspective)
        VALUES (v_pub_book, 'injected-node', 'Hacked', 'Und', 'Persp');
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 1.S PASS: Anon direct insert on book_knowledge_nodes blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 1.S PASS: Anon direct insert on book_knowledge_nodes blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 1.S FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 1.S FAILED: Anon allowed to insert into book_knowledge_nodes!'; END IF;

    v_failed := false;
    BEGIN
        INSERT INTO public.webhook_logs (provider, event_id, event_type)
        VALUES ('stripe', 'evt_anon_hack', 'payment.success');
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 1.T PASS: Anon direct insert on webhook_logs blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 1.T PASS: Anon direct insert on webhook_logs blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 1.T FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 1.T FAILED: Anon allowed to insert into webhook_logs!'; END IF;

    -- D. Sensitive Field Injection on Public Comment
    v_failed := false;
    BEGIN
        INSERT INTO public.blog_comments (blog_id, user_name, content, is_admin, is_approved, status)
        VALUES (v_pub_blog, 'Attacker', 'Privileged Comment', true, true, 'approved');
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 1.U PASS: Privileged comment injection rejected (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 1.U PASS: Privileged comment injection rejected (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 1.U FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 1.U FAILED: Anon allowed to inject admin/approved comment!'; END IF;

    -- E. Positive Permitted Writes for Anonymous
    INSERT INTO public.blog_comments (blog_id, user_name, content, is_admin, is_approved, status)
    VALUES (v_pub_blog, 'Legitimate Reader', 'Great book!', false, false, 'pending');

    -- Contact messages test insert: matching actual schema (no subject column)
    INSERT INTO public.contact_messages (name, email, message)
    VALUES ('Visitor', 'visitor@example.com', 'I would like more information.');

    -- Anonymous course click telemetry (user_id IS NULL)
    INSERT INTO public.course_clicks (course_title)
    VALUES ('Executive Marketing Masterclass');

    -- Anonymous read denial on coupons
    SELECT count(*) INTO v_count FROM public.coupons;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 1.W FAILED: Anon read coupons table!'; END IF;

    -- Anonymous direct insert denial on coupons
    v_failed := false;
    BEGIN
        INSERT INTO public.coupons (id, code, discount_percentage)
        VALUES ('COUPON-HACK', 'HACK100', 100.00);
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 1.X PASS: Anon direct insert on coupons blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 1.X PASS: Anon direct insert on coupons blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 1.X FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 1.X FAILED: Anon allowed to insert into coupons!'; END IF;

    RAISE NOTICE 'TEST RLS 1.V-X PASS: Legitimate public comment, contact message, course click, and coupon denials succeeded.';

    -- ------------------------------------------------------------------------
    -- SECTION 2: AUTHENTICATED NON-ADMIN ('authenticated' AS USER B)
    -- ------------------------------------------------------------------------
    RESET ROLE;
    SET LOCAL ROLE authenticated;
    PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
        'sub', v_user_b_uid::text,
        'role', 'authenticated'
    )::text,
    true
);

    -- A. Cross-User Data Isolation: User B cannot see User A's private records
    SELECT count(*) INTO v_count FROM public.orders WHERE id = v_order_a;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 2.A FAILED: User B read User A order!'; END IF;

    SELECT count(*) INTO v_count FROM public.user_entitlements WHERE id = v_ent_a;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 2.B FAILED: User B read User A entitlement!'; END IF;

    SELECT count(*) INTO v_count FROM public.first_200_cohort WHERE cohort_number = 1;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 2.C FAILED: User B read User A cohort membership!'; END IF;
    RAISE NOTICE 'TEST RLS 2.A-C PASS: Non-admin caller denied cross-user order, entitlement, and cohort access.';

    -- B. Draft chapters and knowledge nodes denial for authenticated non-admin
    SELECT count(*) INTO v_count FROM public.book_chapters WHERE id = v_dft_chap;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 2.D FAILED: Non-admin read draft chapter!'; END IF;

    SELECT count(*) INTO v_count FROM public.book_knowledge_nodes WHERE book_id = v_pub_book;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 2.E FAILED: Non-admin read Ask SID knowledge nodes!'; END IF;

    SELECT count(*) INTO v_count FROM public.questionnaire_submissions;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 2.F FAILED: Non-admin read questionnaire submissions table!'; END IF;

    SELECT count(*) INTO v_count FROM public.webhook_logs;
    IF v_count <> 0 THEN RAISE EXCEPTION 'TEST RLS 2.G FAILED: Non-admin read webhook_logs table!'; END IF;
    RAISE NOTICE 'TEST RLS 2.D-G PASS: Non-admin caller denied access to draft chapters, RAG knowledge nodes, submissions, webhook logs.';

    -- C. Negative Direct Inserts into Sensitive Tables for Non-Admin
    v_failed := false;
    BEGIN
        INSERT INTO public.orders (order_number, user_id, email, book_name, amount, payment_provider)
        VALUES ('ORD-B-DIRECT', v_user_b_uid, 'user_b@example.com', 'Book', 1.00, 'stripe');
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 2.H PASS: Non-admin direct insert on orders blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 2.H PASS: Non-admin direct insert on orders blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 2.H FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 2.H FAILED: Non-admin allowed to direct-insert into orders!'; END IF;

    v_failed := false;
    BEGIN
        INSERT INTO public.user_entitlements (user_id, email, book_id, access_tier, reader_access_expires_at, ask_sid_access_expires_at, expires_at)
        VALUES (v_user_b_uid, 'user_b@example.com', v_pub_book, 'companion', now(), now(), now());
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 2.I PASS: Non-admin direct insert on user_entitlements blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 2.I PASS: Non-admin direct insert on user_entitlements blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 2.I FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 2.I FAILED: Non-admin allowed to direct-insert into user_entitlements!'; END IF;

    -- D. Catalog and Questionnaire Modification Denial
    UPDATE public.ebooks SET title = 'Defaced' WHERE id = v_pub_book;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN RAISE EXCEPTION 'TEST RLS 2.J FAILED: Non-admin modified published ebook!'; END IF;

    UPDATE public.questions SET question_text = 'Hacked Question' WHERE id = v_q1;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN RAISE EXCEPTION 'TEST RLS 2.K FAILED: Non-admin modified question!'; END IF;

    UPDATE public.question_options SET score = 999 WHERE id = v_opt1;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN RAISE EXCEPTION 'TEST RLS 2.L FAILED: Non-admin modified question option score!'; END IF;
    RAISE NOTICE 'TEST RLS 2.J-L PASS: Non-admin updates on ebooks, questions, options affected 0 rows.';

    v_failed := false;
    BEGIN
        INSERT INTO public.ebooks (sku, title, price, publication_status)
        VALUES ('HACK-001', 'Hacked', 1.00, 'published');
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 2.M PASS: Non-admin insert on ebooks blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 2.M PASS: Non-admin insert on ebooks blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 2.M FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 2.M FAILED: Non-admin inserted ebook!'; END IF;

    v_failed := false;
    BEGIN
        INSERT INTO public.questions (question_text, order_index)
        VALUES ('Injected Question', 99);
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 2.N PASS: Non-admin insert on questions blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 2.N PASS: Non-admin insert on questions blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 2.N FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 2.N FAILED: Non-admin inserted question!'; END IF;

    -- E. Public Privileged-Record / Spoofing Insertion Denial
    -- User B attempts to spoof User A in questionnaire_submissions
    v_failed := false;
    BEGIN
        INSERT INTO public.questionnaire_submissions (user_id, profile, answers, total_score, perception_category)
        VALUES (v_user_a_uid, 'Founder', '{"q1": "opt1"}'::jsonb, 10, 'Visionary');
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 2.O PASS: Spoofed user_id submission blocked by RLS WITH CHECK (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 2.O PASS: Spoofed user_id submission blocked by RLS WITH CHECK (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 2.O FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 2.O FAILED: Non-admin allowed to submit questionnaire with spoofed user_id!'; END IF;

    -- User B attempts to spoof User A in consultations
    v_failed := false;
    BEGIN
        INSERT INTO public.consultations (user_id, name, email, date, time)
        VALUES (v_user_a_uid, 'Impostor', 'user_a@example.com', current_date, '14:00');
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 2.P PASS: Direct insert on consultations blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 2.P PASS: Direct insert on consultations blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 2.P FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 2.P FAILED: Non-admin allowed to direct insert into consultations!'; END IF;

    -- User B direct insert denial on coupons
    v_failed := false;
    BEGIN
        INSERT INTO public.coupons (id, code, discount_percentage)
        VALUES ('COUPON-HACK-B', 'HACK50', 50.00);
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 2.R PASS: Non-admin direct insert on coupons blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 2.R PASS: Non-admin direct insert on coupons blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 2.R FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 2.R FAILED: Non-admin allowed to direct insert into coupons!'; END IF;

    -- User B spoofed course_clicks insert denial
    v_failed := false;
    BEGIN
        INSERT INTO public.course_clicks (user_id, course_title)
        VALUES (v_user_a_uid, 'Spoofed Click');
        v_failed := true;
    EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'TEST RLS 2.S PASS: Spoofed user_id on course_clicks blocked (SQLSTATE 42501).';
    WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 2.S PASS: Spoofed user_id on course_clicks blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 2.S FAILED: Expected SQLSTATE 42501, got % (%)', SQLERRM, SQLSTATE;
        END IF;
    END;
    IF v_failed THEN RAISE EXCEPTION 'TEST RLS 2.S FAILED: Non-admin allowed to spoof user_id on course_clicks!'; END IF;

   
    -- F. Positive Permitted Writes and Restricted Activity Tracking for User B

    INSERT INTO public.questionnaire_submissions
        (user_id, profile, answers, total_score, perception_category)
    VALUES
        (v_user_b_uid, 'Founder', '{"q1": "opt1"}'::jsonb, 10, 'Visionary');

    -- user_activity is restricted to admin and service_role.
    -- Verify that a normal authenticated user cannot insert.
    v_failed := false;
    BEGIN
        INSERT INTO public.user_activity (user_id, email, activity_type)
        VALUES (v_user_b_uid, 'user_b@example.com', 'login');

        v_failed := true;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = '42501' THEN
            RAISE NOTICE 'TEST RLS 2.Q PASS: Non-admin user_activity insert blocked (SQLSTATE 42501).';
        ELSE
            RAISE EXCEPTION 'TEST RLS 2.Q FAILED: Expected SQLSTATE 42501, got % (%)',
                SQLERRM, SQLSTATE;
        END IF;
    END;

    IF v_failed THEN
        RAISE EXCEPTION 'TEST RLS 2.Q FAILED: Non-admin was allowed to insert into user_activity!';
    END IF;

    -- Verify permitted course-click insertion separately.
    INSERT INTO public.course_clicks (user_id, course_title)
    VALUES (v_user_b_uid, 'Executive AI Strategy');

    GET DIAGNOSTICS v_count = ROW_COUNT;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'TEST RLS 2.S FAILED: User B could not insert own course click!';
    END IF;

    RAISE NOTICE 'TEST RLS 2.Q-S PASS: Questionnaire and course-click writes succeeded; restricted activity tracking and spoofing denials verified.';


    -- ------------------------------------------------------------------------
    -- SECTION 3: POSITIVE ADMINISTRATOR ACCESS TESTS ('authenticated' AS ADMIN)
    -- ------------------------------------------------------------------------
    RESET ROLE;
    SET LOCAL ROLE authenticated;
    PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
        'sub', v_admin_uid::text,
        'role', 'authenticated'
    )::text,
    true
);

    -- Confirm public.is_admin() evaluates to true
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'TEST RLS 3.0 FAILED: is_admin() did not evaluate to true for administrator!';
    END IF;
    RAISE NOTICE 'TEST RLS 3.0 PASS: Administrator context confirmed (is_admin = true).';

    -- A. Administrative Reads across drafts and private records
    SELECT count(*) INTO v_count FROM public.ebooks WHERE id = v_dft_book;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.A FAILED: Admin could not read draft ebook!'; END IF;

    SELECT count(*) INTO v_count FROM public.book_chapters WHERE id = v_dft_chap;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.B FAILED: Admin could not read draft chapter!'; END IF;

    SELECT count(*) INTO v_count FROM public.blogs WHERE id = v_dft_blog;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.C FAILED: Admin could not read draft blog!'; END IF;

    SELECT count(*) INTO v_count FROM public.book_knowledge_nodes WHERE id = v_node_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.D FAILED: Admin could not read book knowledge nodes!'; END IF;

    SELECT count(*) INTO v_count FROM public.orders WHERE id = v_order_a;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.E FAILED: Admin could not read cross-user orders!'; END IF;

    SELECT count(*) INTO v_count FROM public.user_entitlements WHERE id = v_ent_a;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.F FAILED: Admin could not read cross-user entitlements!'; END IF;

    SELECT count(*) INTO v_count FROM public.first_200_cohort WHERE cohort_number = 1;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.G FAILED: Admin could not read cohort records!'; END IF;

    SELECT count(*) INTO v_count FROM public.questionnaire_submissions WHERE id = v_sub_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.H FAILED: Admin could not read questionnaire submissions!'; END IF;
    RAISE NOTICE 'TEST RLS 3.A-H PASS: Administrator successfully read drafts, knowledge nodes, cross-user orders, entitlements, cohort, submissions.';

    -- B. Administrative Writes & Updates
    UPDATE public.ebooks SET title = 'Admin Approved Title' WHERE id = v_dft_book;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.I FAILED: Admin update on ebooks affected % rows!', v_count; END IF;

    UPDATE public.book_chapters SET status = 'published' WHERE id = v_dft_chap;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.J FAILED: Admin update on book_chapters affected % rows!', v_count; END IF;

    INSERT INTO public.questions (id, question_text, order_index)
    VALUES (v_q_admin, 'Admin Strategic Question', 10);
    RAISE NOTICE 'TEST RLS 3.K PASS: Admin question insert succeeded.';

    UPDATE public.question_options SET score = 50 WHERE id = v_opt1;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.L FAILED: Admin update on question_options affected % rows!', v_count; END IF;

    UPDATE public.blog_comments SET is_approved = true, status = 'approved' WHERE blog_id = v_pub_blog;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count < 1 THEN RAISE EXCEPTION 'TEST RLS 3.M FAILED: Admin could not approve blog comments!'; END IF;

    -- Update valid JSONB key inside settings schema and verify updated value
    UPDATE public.ask_sid_settings 
    SET settings = jsonb_set(settings, '{askSidEnabled}', 'false'::jsonb),
        updated_at = now()
    WHERE id = 'default';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.N FAILED: Admin update on ask_sid_settings affected % rows (expected 1)!', v_count; END IF;

    SELECT (settings ->> 'askSidEnabled')::boolean INTO v_setting_bool
    FROM public.ask_sid_settings
    WHERE id = 'default';
    IF v_setting_bool IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'TEST RLS 3.N FAILED: settings.askSidEnabled did not persist updated false value!';
    END IF;

    -- Admin reads coupons and course clicks
    SELECT count(*) INTO v_count FROM public.coupons WHERE id = 'COUPON-TEST';
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.O FAILED: Admin could not read coupons!'; END IF;

    SELECT count(*) INTO v_count FROM public.course_clicks;
    IF v_count < 1 THEN RAISE EXCEPTION 'TEST RLS 3.P FAILED: Admin could not read course_clicks!'; END IF;

    -- Admin updates coupon
    UPDATE public.coupons SET discount_percentage = 40.00 WHERE id = 'COUPON-TEST';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'TEST RLS 3.Q FAILED: Admin update on coupons affected % rows (expected 1)!', v_count; END IF;

    RAISE NOTICE 'TEST RLS 3.I-Q PASS: Administrator successfully performed administrative writes, publishes, comment approvals, settings JSONB updates, coupon management, and telemetry inspections.';

    RESET ROLE;
    RAISE NOTICE 'PART 3 COMPLETE: Comprehensive RLS positive, negative, and field-protection suite successfully verified.';
END;
$$;

ROLLBACK;


-- ============================================================================
-- PART 4: MULTI-SESSION CONCURRENCY TEST SPECIFICATION
-- ============================================================================
/*
-------------------------------------------------------------------------------
MULTI-SESSION CONCURRENCY VERIFICATION SPECIFICATION:
-------------------------------------------------------------------------------
Due to PostgreSQL single-session serial execution, concurrency race conditions
MUST be verified using at least two simultaneous client connections.

TEST SCENARIO 1: Simultaneous Webhooks for Cohort Slot #200
  Connection A:
    BEGIN;
    SELECT public.allocate_first_200_companion('buyer_a@example.com', NULL, order_a, book_id);
    -- Hold transaction open for 200ms
  Connection B (simultaneous):
    BEGIN;
    SELECT public.allocate_first_200_companion('buyer_b@example.com', NULL, order_b, book_id);

  Observed Verification Requirement:
    - Connection B acquires advisory lock ONLY AFTER Connection A commits.
    - Connection A receives cohort #200.
    - Connection B receives NULL (cohort full, limit 200 respected; no 201).

TEST SCENARIO 2: Simultaneous Ask SID Submissions at Daily Limit (Question 5 & 6)
  Connection A & B simultaneously submit 5th question for same canonical user_id.
  Observed Verification Requirement:
    - Advisory lock (hashtext('ask_sid_user_' || user_id)) serializes execution.
    - Exactly one connection receives allowed: true (daily_used: 5).
    - The other connection receives allowed: false (reason: 'daily_limit_reached').

TEST SCENARIO 3: Simultaneous Entitlement Claims (link_user_entitlements)
  Setup:
    Two unlinked Payhip purchases exist for 'concurrent_buyer@example.com'.
    Connection A and Connection B both represent the authenticated buyer account
    and simultaneously call public.link_user_entitlements().
  Observed Verification Requirement:
    - Advisory lock (hashtext('claim_purchases_' || v_normalized_email)) serializes execution.
    - Connection A links the unlinked orders and entitlements (entitlements_linked: 2).
    - Connection B acquires lock after Connection A commits, observes 0 unlinked records,
      and exits cleanly with { success: true, entitlements_linked: 0, orders_linked: 0 }.
    - No duplicate claims, race conditions, or unhandled lock contentions occur.
-------------------------------------------------------------------------------
*/
