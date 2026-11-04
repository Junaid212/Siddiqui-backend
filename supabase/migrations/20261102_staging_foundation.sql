-- ============================================================================
-- Siddiqui.digital — Staging Foundation Migration (Phase 1) - REVISED & HARDENED
-- Target Staging Host: xnqcdwenfomhnfykmvra.supabase.co
-- Mode: Strictly Idempotent, Safe search_path, Privilege Escalation Protected
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Helper Functions & Extensions
-- ----------------------------------------------------------------------------
-- Note: Extensions in Supabase are pre-installed in extensions/public schema
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Reusable trigger function for updated_at timestamps (safe search_path)
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Secure helper function to check admin privileges (checks JWT claims & profiles.account_type)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
    -- Unauthenticated / anonymous callers are never administrators
    IF auth.uid() IS NULL THEN
        RETURN false;
    END IF;

    -- Check 1: Supabase auth.jwt() app_metadata role
    IF coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin' THEN
        RETURN true;
    END IF;
    
    -- Check 2: Profiles table account_type = 'admin'
    IF EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND account_type = 'admin'
    ) THEN
        RETURN true;
    END IF;
    
    RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

-- Safe to grant to anon because unauthenticated callers immediately return false
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 1. Profiles Table & Admin Escalation Protection
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    full_name TEXT,
    avatar_url TEXT,
    account_type TEXT NOT NULL DEFAULT 'reader' CHECK (account_type IN ('reader', 'admin', 'advisory_client')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_account_type ON public.profiles(account_type);

-- Privilege Escalation Guard Trigger: Prevents non-admins from promoting themselves to admin
CREATE OR REPLACE FUNCTION public.protect_profile_privilege_escalation()
RETURNS TRIGGER AS $$
BEGIN
    -- On INSERT: non-admins cannot create a profile with account_type other than 'reader'
    IF TG_OP = 'INSERT' THEN
        IF NEW.account_type <> 'reader' THEN
            IF NOT (coalesce(current_setting('role', true), '') = 'service_role' OR public.is_admin()) THEN
                NEW.account_type := 'reader';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    -- On UPDATE: non-admins cannot change account_type
    IF TG_OP = 'UPDATE' THEN
        IF NEW.account_type IS DISTINCT FROM OLD.account_type THEN
            IF NOT (coalesce(current_setting('role', true), '') = 'service_role' OR public.is_admin()) THEN
                RAISE EXCEPTION 'Privilege Escalation Blocked: Only an authorized administrator can modify account_type.';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.protect_profile_privilege_escalation() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.protect_profile_privilege_escalation() TO authenticated, service_role;

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_protect_profile_privilege_escalation ON public.profiles;
CREATE TRIGGER trg_protect_profile_privilege_escalation
    BEFORE INSERT OR UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privilege_escalation();

-- ----------------------------------------------------------------------------
-- 2. Digital Publications / Book CMS (ebooks)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ebooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE,
    title TEXT NOT NULL,
    subtitle TEXT,
    author TEXT NOT NULL DEFAULT 'M. Q. Siddiqui',
    product_type TEXT NOT NULL DEFAULT 'ebook',
    -- Explicit pricing: NO universal default price. Specific edition pricing configured per product
    price NUMERIC(10, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    format TEXT NOT NULL DEFAULT 'PDF',
    short_description TEXT,
    description TEXT,
    cover_image TEXT,
    file_path TEXT,
    publication_status TEXT NOT NULL DEFAULT 'draft' CHECK (publication_status IN ('published', 'available', 'draft', 'scheduled', 'archived')),
    active BOOLEAN NOT NULL DEFAULT true,
    download_limit INTEGER NOT NULL DEFAULT 3,
    download_expiry_hours INTEGER NOT NULL DEFAULT 72,
    
    -- Publication CMS & Content Sections
    why_this_book_matters TEXT,
    who_its_for JSONB NOT NULL DEFAULT '[]'::jsonb,
    what_readers_will_learn JSONB NOT NULL DEFAULT '[]'::jsonb,
    author_note TEXT,
    faq JSONB NOT NULL DEFAULT '[]'::jsonb,
    related_learning JSONB NOT NULL DEFAULT '[]'::jsonb,
    related_frameworks JSONB NOT NULL DEFAULT '[]'::jsonb,
    related_blogs JSONB NOT NULL DEFAULT '[]'::jsonb,
    access_options JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ebooks_slug ON public.ebooks(slug);
CREATE INDEX IF NOT EXISTS idx_ebooks_active_status ON public.ebooks(active, publication_status);

DROP TRIGGER IF EXISTS trg_ebooks_updated_at ON public.ebooks;
CREATE TRIGGER trg_ebooks_updated_at
    BEFORE UPDATE ON public.ebooks
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Book Chapters & Reader Content (Book CMS)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.book_chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id UUID NOT NULL REFERENCES public.ebooks(id) ON DELETE CASCADE,
    chapter_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    summary TEXT,
    content_markdown TEXT,
    content_html TEXT,
    page_start INTEGER,
    page_end INTEGER,
    is_preview BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('published', 'available', 'draft', 'scheduled', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(book_id, chapter_number),
    UNIQUE(book_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_book_chapters_book_status ON public.book_chapters(book_id, status);

DROP TRIGGER IF EXISTS trg_book_chapters_updated_at ON public.book_chapters;
CREATE TRIGGER trg_book_chapters_updated_at
    BEFORE UPDATE ON public.book_chapters
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Ask SID Grounded Principle Library & Knowledge Index
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.book_knowledge_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    book_id UUID NOT NULL REFERENCES public.ebooks(id) ON DELETE CASCADE,
    chapter_id UUID REFERENCES public.book_chapters(id) ON DELETE SET NULL,
    node_key TEXT NOT NULL,
    title TEXT NOT NULL,
    keywords TEXT[] NOT NULL DEFAULT '{}',
    concepts TEXT[] NOT NULL DEFAULT '{}',
    book_reference_chapter TEXT,
    book_reference_section TEXT,
    book_reference_page TEXT,
    understanding TEXT NOT NULL,
    perspective TEXT NOT NULL,
    questions_to_consider JSONB NOT NULL DEFAULT '[]'::jsonb,
    possible_direction TEXT,
    requires_advisory BOOLEAN NOT NULL DEFAULT false,
    published BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(book_id, node_key)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_lookup ON public.book_knowledge_nodes(book_id, node_key);
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_published ON public.book_knowledge_nodes(published);

DROP TRIGGER IF EXISTS trg_book_knowledge_nodes_updated_at ON public.book_knowledge_nodes;
CREATE TRIGGER trg_book_knowledge_nodes_updated_at
    BEFORE UPDATE ON public.book_knowledge_nodes
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ----------------------------------------------------------------------------
-- 5. Orders Table (Checkout, Downloads & Webhooks)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    order_number TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    customer_name TEXT NOT NULL DEFAULT 'Valued Reader',
    product_id UUID REFERENCES public.ebooks(id) ON DELETE SET NULL,
    book_name TEXT NOT NULL,
    edition_type TEXT NOT NULL DEFAULT 'companion' CHECK (edition_type IN ('online', 'companion', 'upgrade')),
    -- Supports precise decimal currency calculations ($49.99, $29.99, $20.00)
    amount NUMERIC(10, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    -- Complete set of all payment statuses handled across Stripe, PayPal, Payhip, and manual orders
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'successful', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded', 'disputed')),
    
    -- Payment Gateway Identifiers
    payment_provider TEXT NOT NULL CHECK (payment_provider IN ('stripe', 'paypal', 'payhip', 'manual')),
    provider_transaction_id TEXT,
    stripe_session_id TEXT,
    stripe_payment_intent_id TEXT,
    paypal_order_id TEXT,
    paypal_capture_id TEXT,
    payhip_transaction_id TEXT,
    
    -- Access, Cohorts & Download Rules
    is_upgrade BOOLEAN NOT NULL DEFAULT false,
    original_order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
    early_access_number INTEGER CHECK (early_access_number IS NULL OR (early_access_number >= 1 AND early_access_number <= 200)),
    download_token TEXT UNIQUE,
    download_expires_at TIMESTAMPTZ,
    download_count INTEGER NOT NULL DEFAULT 0,
    download_limit INTEGER NOT NULL DEFAULT 3,
    access_expires_at TIMESTAMPTZ,
    
    -- Refund Status & Auditing
    refund_status TEXT CHECK (refund_status IS NULL OR refund_status IN ('none', 'partial', 'full')),
    refund_amount NUMERIC(10, 2) DEFAULT 0,
    refunded_at TIMESTAMPTZ,
    
    marketing_opt_in BOOLEAN NOT NULL DEFAULT false,
    raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_email ON public.orders(email);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON public.orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_download_token ON public.orders(download_token);
CREATE INDEX IF NOT EXISTS idx_orders_early_access ON public.orders(early_access_number);

DROP TRIGGER IF EXISTS trg_orders_updated_at ON public.orders;
CREATE TRIGGER trg_orders_updated_at
    BEFORE UPDATE ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ----------------------------------------------------------------------------
-- 6. User Entitlements (12-Month Access for Reader & Ask SID)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    book_id UUID NOT NULL REFERENCES public.ebooks(id) ON DELETE CASCADE,
    access_tier TEXT NOT NULL CHECK (access_tier IN ('online', 'companion')),
    order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
    
    -- First 200 Unique Companion Buyer Tracking
    is_early_access_200 BOOLEAN NOT NULL DEFAULT false,
    early_access_number INTEGER CHECK (early_access_number IS NULL OR (early_access_number >= 1 AND early_access_number <= 200)),
    
    is_active BOOLEAN NOT NULL DEFAULT true,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- Reader Access: Synchronized directly with canonical expires_at
    reader_access_expires_at TIMESTAMPTZ NOT NULL,
    
    -- Ask SID AI Access: Synchronized directly with canonical expires_at (Digital Companion only)
    ask_sid_access_expires_at TIMESTAMPTZ NOT NULL,
    
    -- Overall Canonical Entitlement expiration: 12 months from granted_at
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT CHECK (revocation_reason IS NULL OR revocation_reason IN ('full_refund', 'chargeback', 'expired', 'upgraded', 'administrative')),
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Invariant consistency check: reader expiry matches expires_at; Online never gets Ask SID
    CONSTRAINT chk_entitlement_expiration_consistency CHECK (
        reader_access_expires_at = expires_at AND (
            (access_tier = 'companion' AND ask_sid_access_expires_at = expires_at)
            OR (access_tier = 'online' AND ask_sid_access_expires_at <= granted_at)
        )
    )
);

-- Partial index: allows multiple historical/revoked rows while guaranteeing strictly ONE active entitlement per tier
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_entitlement 
    ON public.user_entitlements(email, book_id, access_tier) 
    WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_entitlements_user_book ON public.user_entitlements(user_id, book_id, is_active);
CREATE INDEX IF NOT EXISTS idx_entitlements_email_book ON public.user_entitlements(email, book_id, is_active);
CREATE INDEX IF NOT EXISTS idx_entitlements_cohort ON public.user_entitlements(is_early_access_200, early_access_number);

DROP TRIGGER IF EXISTS trg_user_entitlements_updated_at ON public.user_entitlements;
CREATE TRIGGER trg_user_entitlements_updated_at
    BEFORE UPDATE ON public.user_entitlements
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Canonical Entitlement Expiration Synchronizer:
-- Derives reader and Companion Ask SID expiry from granted_at / canonical expires_at.
-- Respects custom granted_at values and ensures relevant updates cannot leave expiry fields inconsistent.
CREATE OR REPLACE FUNCTION public.sync_entitlement_expiration()
RETURNS TRIGGER AS $$
BEGIN
    -- 1. Ensure granted_at is established
    IF NEW.granted_at IS NULL THEN
        NEW.granted_at := now();
    END IF;

    -- 2. Establish canonical 12-month expiration:
    -- If expires_at is null OR if granted_at was modified without an explicit distinct expires_at update
    IF NEW.expires_at IS NULL OR (TG_OP = 'UPDATE' AND NEW.granted_at IS DISTINCT FROM OLD.granted_at AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at) THEN
        NEW.expires_at := NEW.granted_at + interval '12 months';
    END IF;

    -- 3. Always derive reader access expiration directly from canonical expires_at
    NEW.reader_access_expires_at := NEW.expires_at;

    -- 4. Always derive Ask SID access expiration:
    -- Companion Edition gets exactly canonical expires_at (12 months).
    -- Online Edition NEVER receives Ask SID access (locked to granted_at, meaning 0 duration).
    IF NEW.access_tier = 'companion' THEN
        NEW.ask_sid_access_expires_at := NEW.expires_at;
    ELSE
        NEW.ask_sid_access_expires_at := NEW.granted_at;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_sync_entitlement_expiration ON public.user_entitlements;
CREATE TRIGGER trg_sync_entitlement_expiration
    BEFORE INSERT OR UPDATE ON public.user_entitlements
    FOR EACH ROW EXECUTE FUNCTION public.sync_entitlement_expiration();

-- Secure Payhip & Guest Entitlement Claiming Function
-- Requires an authenticated caller with a confirmed email in auth.users.
-- Claims unlinked purchases matching the verified email.
CREATE OR REPLACE FUNCTION public.link_user_entitlements()
RETURNS JSONB AS $$
DECLARE
    v_user_id UUID;
    v_auth_email TEXT;
    v_confirmed_at TIMESTAMPTZ;
    v_normalized_email TEXT;
    v_entitlements_linked INTEGER := 0;
    v_orders_linked INTEGER := 0;
    v_cohort_linked INTEGER := 0;
BEGIN
    v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'authentication_required',
            'message', 'Authentication required to claim purchases.'
        );
    END IF;

    -- Look up the authenticated user directly in auth.users to ensure email is confirmed
    SELECT email, coalesce(email_confirmed_at, confirmed_at)
    INTO v_auth_email, v_confirmed_at
    FROM auth.users
    WHERE id = v_user_id;

    IF v_auth_email IS NULL OR v_confirmed_at IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'reason', 'unverified_email',
            'message', 'Claim failed: Your email address must be confirmed before claiming purchases.'
        );
    END IF;

    v_normalized_email := lower(trim(v_auth_email));

    -- Transactional Advisory Lock: Serialize concurrent claim requests for the same confirmed buyer email
    PERFORM pg_advisory_xact_lock(hashtext('claim_purchases_' || v_normalized_email));

    -- Atomically claim unlinked user_entitlements matching the confirmed auth.users email
    WITH updated_e AS (
        UPDATE public.user_entitlements
        SET user_id = v_user_id,
            updated_at = now()
        WHERE user_id IS NULL
          AND lower(trim(email)) = v_normalized_email
        RETURNING id
    )
    SELECT count(*) INTO v_entitlements_linked FROM updated_e;

    -- Atomically claim unlinked orders matching the confirmed auth.users email
    WITH updated_o AS (
        UPDATE public.orders
        SET user_id = v_user_id,
            updated_at = now()
        WHERE user_id IS NULL
          AND lower(trim(email)) = v_normalized_email
        RETURNING id
    )
    SELECT count(*) INTO v_orders_linked FROM updated_o;

    -- Atomically claim unlinked cohort position matching the confirmed auth.users email
    WITH updated_c AS (
        UPDATE public.first_200_cohort
        SET user_id = v_user_id
        WHERE user_id IS NULL
          AND lower(trim(buyer_email)) = v_normalized_email
        RETURNING cohort_number
    )
    SELECT count(*) INTO v_cohort_linked FROM updated_c;

    RETURN jsonb_build_object(
        'success', true,
        'user_id', v_user_id,
        'email', v_normalized_email,
        'entitlements_linked', v_entitlements_linked,
        'orders_linked', v_orders_linked,
        'cohort_linked', v_cohort_linked
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp;

REVOKE EXECUTE ON FUNCTION public.link_user_entitlements() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.link_user_entitlements() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. First 200 Companion Cohort (Strict Order Verification & Immutable Allocation)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.first_200_cohort (
    cohort_number INTEGER PRIMARY KEY CHECK (cohort_number BETWEEN 1 AND 200),
    buyer_email TEXT UNIQUE NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
    book_id UUID NOT NULL REFERENCES public.ebooks(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'refunded', 'revoked')),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    refunded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_first_200_cohort_email ON public.first_200_cohort(buyer_email);
CREATE INDEX IF NOT EXISTS idx_first_200_cohort_status ON public.first_200_cohort(status);

-- Concurrency-safe atomic allocation function with order verification and advisory locking
CREATE OR REPLACE FUNCTION public.allocate_first_200_companion(
    p_buyer_email TEXT,
    p_user_id UUID,
    p_order_id UUID,
    p_book_id UUID
) RETURNS INTEGER AS $$
DECLARE
    v_normalized_email TEXT;
    v_existing_number INTEGER;
    v_next_number INTEGER;
    v_order RECORD;
    v_orig_order RECORD;
    v_effective_user_id UUID;
BEGIN
    v_normalized_email := lower(trim(p_buyer_email));

    -- Transaction-level advisory lock prevents concurrent race conditions across simultaneous webhooks
    PERFORM pg_advisory_xact_lock(hashtext('first_200_cohort_allocation_lock'));

    -- 1. Verify the order exists AND lock the order row while validating payment eligibility
    SELECT * INTO v_order
    FROM public.orders
    WHERE id = p_order_id
    FOR UPDATE;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Order verification failed: Order % does not exist.', p_order_id;
    END IF;

    -- 2. Reject fully refunded or cancelled orders, while preserving legitimate partial refunds
    IF v_order.status IN ('refunded', 'cancelled', 'failed', 'expired') 
       OR coalesce(v_order.refund_status, 'none') = 'full'
       OR (coalesce(v_order.refund_amount, 0) >= v_order.amount AND v_order.amount > 0) THEN
        RAISE EXCEPTION 'Order verification failed: Order % has been fully refunded or cancelled (status: %, refund_status: %, refund_amount: %, amount: %).', 
            p_order_id, v_order.status, coalesce(v_order.refund_status, 'none'), coalesce(v_order.refund_amount, 0), v_order.amount;
    END IF;

    -- 3. Verify order is paid / successful / legitimate partial refund
    IF v_order.status NOT IN ('paid', 'successful', 'partially_refunded') THEN
        RAISE EXCEPTION 'Order verification failed: Order % is not paid or successful (status: %).', p_order_id, v_order.status;
    END IF;

    -- 4. Verify buyer email matches order email
    IF lower(trim(v_order.email)) <> v_normalized_email THEN
        RAISE EXCEPTION 'Order verification failed: Buyer email % does not match order email %.', v_normalized_email, v_order.email;
    END IF;

    -- 5. Validate p_user_id against orders.user_id where applicable
    IF p_user_id IS NOT NULL AND v_order.user_id IS NOT NULL AND p_user_id IS DISTINCT FROM v_order.user_id THEN
        RAISE EXCEPTION 'Order verification failed: Provided user_id % does not match order user_id %.', p_user_id, v_order.user_id;
    END IF;
    v_effective_user_id := coalesce(p_user_id, v_order.user_id);

    -- 6. Verify product identity using IS DISTINCT FROM
    IF v_order.product_id IS DISTINCT FROM p_book_id THEN
        RAISE EXCEPTION 'Order verification failed: Order product % does not match book %.', v_order.product_id, p_book_id;
    END IF;

    -- 7. Verify Companion edition or valid Companion upgrade
    IF v_order.edition_type NOT IN ('companion', 'upgrade') THEN
        RAISE EXCEPTION 'Order verification failed: Edition % is not eligible for First 200 Companion cohort.', v_order.edition_type;
    END IF;

    -- 8. If this is an upgrade order, validate against original paid order
    IF v_order.edition_type = 'upgrade' OR v_order.is_upgrade = true THEN
        IF v_order.original_order_id IS NULL THEN
            RAISE EXCEPTION 'Order verification failed: Upgrade order % is missing original_order_id.', p_order_id;
        END IF;

        SELECT * INTO v_orig_order
        FROM public.orders
        WHERE id = v_order.original_order_id
        FOR SHARE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Order verification failed: Original order % for upgrade does not exist.', v_order.original_order_id;
        END IF;

        IF lower(trim(v_orig_order.email)) <> v_normalized_email THEN
            RAISE EXCEPTION 'Order verification failed: Original order buyer % does not match upgrade buyer %.', v_orig_order.email, v_normalized_email;
        END IF;

        IF v_orig_order.product_id IS DISTINCT FROM p_book_id THEN
            RAISE EXCEPTION 'Order verification failed: Original order product % does not match upgrade book %.', v_orig_order.product_id, p_book_id;
        END IF;

        IF v_orig_order.status NOT IN ('paid', 'successful', 'partially_refunded') THEN
            RAISE EXCEPTION 'Order verification failed: Original order % is not in a paid status (status: %).', v_orig_order.id, v_orig_order.status;
        END IF;

        IF v_orig_order.status IN ('refunded', 'cancelled', 'failed', 'expired') 
           OR coalesce(v_orig_order.refund_status, 'none') = 'full'
           OR (coalesce(v_orig_order.refund_amount, 0) >= v_orig_order.amount AND v_orig_order.amount > 0) THEN
            RAISE EXCEPTION 'Order verification failed: Original order % is fully refunded or cancelled.', v_orig_order.id;
        END IF;
    END IF;
    
    -- 9. Check if this unique buyer already holds an assigned cohort number
    SELECT cohort_number INTO v_existing_number
    FROM public.first_200_cohort
    WHERE buyer_email = v_normalized_email;
    
    IF v_existing_number IS NOT NULL THEN
        RETURN v_existing_number;
    END IF;
    
    -- 10. Find next monotonic cohort number (preserves audit history without blind gap recycling)
    SELECT coalesce(max(cohort_number), 0) + 1 INTO v_next_number
    FROM public.first_200_cohort;
    
    IF v_next_number > 200 THEN
        RETURN NULL; -- Cohort full (all 200 allocated)
    END IF;
    
    INSERT INTO public.first_200_cohort (
        cohort_number, buyer_email, user_id, order_id, book_id, status, assigned_at
    ) VALUES (
        v_next_number, v_normalized_email, v_effective_user_id, p_order_id, p_book_id, 'active', now()
    );
    
    RETURN v_next_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Revoke execution from public, anon, and authenticated users. Only service role can allocate cohort numbers.
REVOKE EXECUTE ON FUNCTION public.allocate_first_200_companion(TEXT, UUID, UUID, UUID) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_first_200_companion(TEXT, UUID, UUID, UUID) TO service_role;

-- ----------------------------------------------------------------------------
-- 8. Ask SID Settings & Persistent Usage Logs (Concurrency-Safe Quota Engine)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ask_sid_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default settings row if not present
INSERT INTO public.ask_sid_settings (id, settings, updated_at)
VALUES ('default', '{
    "askSidEnabled": true,
    "publicDemoEnabled": true,
    "demoQuestionLimit": 1,
    "standardDailyLimit": 5,
    "standardLifetimeLimit": 100,
    "cohortLifetimeLimit": 150,
    "fullAccessProductId": "04b84648-3609-4b31-9ded-2486bacf1e74",
    "onlineEditionProductId": "prod_online_reading_001",
    "upgradeCtaText": "Unlock Full Ask SID with the Digital Companion Edition ($49.99)",
    "upgradeUrl": "/publications/marketing-reclassified",
    "advisoryCtaEnabled": true,
    "advisoryUrl": "/consultation"
}'::jsonb, now())
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ask_sid_usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entitlement_id UUID REFERENCES public.user_entitlements(id) ON DELETE SET NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    email TEXT,
    session_id TEXT,
    ip_address TEXT NOT NULL,
    question TEXT NOT NULL,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    access_level TEXT NOT NULL CHECK (access_level IN ('demo', 'online_only', 'full')),
    node_key_matched TEXT,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ask_sid_usage_user ON public.ask_sid_usage_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ask_sid_usage_email ON public.ask_sid_usage_logs(email, created_at);
CREATE INDEX IF NOT EXISTS idx_ask_sid_usage_ip ON public.ask_sid_usage_logs(ip_address, created_at);
CREATE INDEX IF NOT EXISTS idx_ask_sid_usage_session ON public.ask_sid_usage_logs(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ask_sid_usage_entitlement ON public.ask_sid_usage_logs(entitlement_id);

-- Concurrency-Safe Ask SID Quota Verification & Consumption Engine
CREATE OR REPLACE FUNCTION public.consume_ask_sid_quota(
    p_user_id UUID,
    p_email TEXT,
    p_session_id TEXT,
    p_ip_address TEXT,
    p_question TEXT,
    p_is_demo BOOLEAN DEFAULT false
) RETURNS JSONB AS $$
DECLARE
    v_canonical_user_id UUID;
    v_lock_key BIGINT;
    v_entitlement RECORD;
    v_is_cohort BOOLEAN := false;
    v_daily_limit INTEGER := 5;
    v_lifetime_limit INTEGER := 100;
    v_daily_count INTEGER := 0;
    v_lifetime_count INTEGER := 0;
    v_demo_count INTEGER := 0;
    v_demo_limit INTEGER := 1;
    v_log_id UUID;
    v_today_start TIMESTAMPTZ;
    v_effective_ip TEXT;
BEGIN
    v_effective_ip := coalesce(nullif(trim(p_ip_address), ''), '127.0.0.1');
    v_today_start := (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');

    -- Branch A: Demo / Anonymous Quota Path (Completely Separate From Companion Quota)
    IF p_is_demo THEN
        v_lock_key := hashtext('ask_sid_demo_' || coalesce(nullif(trim(p_session_id), ''), v_effective_ip));
        PERFORM pg_advisory_xact_lock(v_lock_key);

        SELECT count(*) INTO v_demo_count
        FROM public.ask_sid_usage_logs
        WHERE is_demo = true
          AND (ip_address = v_effective_ip OR (p_session_id IS NOT NULL AND session_id = p_session_id))
          AND created_at >= v_today_start;

        IF v_demo_count >= v_demo_limit THEN
            RETURN jsonb_build_object(
                'allowed', false,
                'reason', 'demo_limit_reached',
                'daily_limit', v_demo_limit,
                'daily_used', v_demo_count,
                'message', 'Demo question limit reached for today. Sign in with a Digital Companion entitlement for full access.'
            );
        END IF;

        INSERT INTO public.ask_sid_usage_logs (
            user_id, email, ip_address, session_id, question, is_demo, access_level, created_at
        ) VALUES (
            auth.uid(), nullif(lower(trim(p_email)), ''), v_effective_ip, p_session_id, p_question, true, 'demo', now()
        ) RETURNING id INTO v_log_id;

        RETURN jsonb_build_object(
            'allowed', true,
            'log_id', v_log_id,
            'is_demo', true,
            'demo_remaining', v_demo_limit - (v_demo_count + 1)
        );
    END IF;

    -- Branch B: Canonical Companion Access Path
    -- Requires authenticated user identity (auth.uid() or explicit p_user_id)
    v_canonical_user_id := coalesce(auth.uid(), p_user_id);

    IF v_canonical_user_id IS NULL THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'authentication_required',
            'message', 'Ask SID Companion access requires an authenticated user identity.'
        );
    END IF;

    -- Canonical Advisory Lock based strictly on user_id:
    -- Identity switching (IP, session, client email) CANNOT bypass this lock
    v_lock_key := hashtext('ask_sid_user_' || v_canonical_user_id::text);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- 1. Check user entitlement & 12-month access validity strictly by canonical user_id
    SELECT e.*, (c.cohort_number IS NOT NULL AND c.status = 'active') AS is_cohort_member
    INTO v_entitlement
    FROM public.user_entitlements e
    LEFT JOIN public.first_200_cohort c ON c.user_id = v_canonical_user_id
    WHERE e.user_id = v_canonical_user_id
      AND e.access_tier = 'companion'
      AND e.is_active = true
      AND e.ask_sid_access_expires_at > now()
    ORDER BY e.granted_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'unauthorized',
            'message', 'Ask SID Companion access requires an active, unexpired 12-month Digital Companion Edition entitlement.'
        );
    END IF;

    -- 2. Determine lifetime limit (150 for First 200 cohort, 100 for standard)
    IF v_entitlement.is_cohort_member THEN
        v_is_cohort := true;
        v_lifetime_limit := 150;
    ELSE
        v_lifetime_limit := 100;
    END IF;

    -- 3. Daily question count: uses same canonical user_id & active entitlement grant
    SELECT count(*) INTO v_daily_count
    FROM public.ask_sid_usage_logs
    WHERE user_id = v_canonical_user_id
      AND created_at >= greatest(v_today_start, v_entitlement.granted_at)
      AND is_demo = false;

    IF v_daily_count >= v_daily_limit THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'daily_limit_reached',
            'daily_limit', v_daily_limit,
            'daily_used', v_daily_count,
            'message', 'Daily question quota reached (5 questions per day). Your quota resets at 00:00 UTC.'
        );
    END IF;

    -- 4. Lifetime question count: uses same canonical user_id & active entitlement grant
    SELECT count(*) INTO v_lifetime_count
    FROM public.ask_sid_usage_logs
    WHERE user_id = v_canonical_user_id
      AND created_at >= v_entitlement.granted_at
      AND is_demo = false;

    IF v_lifetime_count >= v_lifetime_limit THEN
        RETURN jsonb_build_object(
            'allowed', false,
            'reason', 'lifetime_limit_reached',
            'lifetime_limit', v_lifetime_limit,
            'lifetime_used', v_lifetime_count,
            'is_first_200', v_is_cohort,
            'message', 'Lifetime question quota reached for this 12-month access period (' || v_lifetime_limit || ' questions).'
        );
    END IF;

    -- 5. Record verified usage atomically
    INSERT INTO public.ask_sid_usage_logs (
        entitlement_id, user_id, email, session_id, ip_address, question, is_demo, access_level, created_at
    ) VALUES (
        v_entitlement.id, v_canonical_user_id, v_entitlement.email, p_session_id, v_effective_ip, p_question, false, 'full', now()
    ) RETURNING id INTO v_log_id;

    RETURN jsonb_build_object(
        'allowed', true,
        'log_id', v_log_id,
        'daily_used', v_daily_count + 1,
        'daily_remaining', v_daily_limit - (v_daily_count + 1),
        'lifetime_used', v_lifetime_count + 1,
        'lifetime_remaining', v_lifetime_limit - (v_lifetime_count + 1),
        'is_first_200', v_is_cohort,
        'access_expires_at', v_entitlement.ask_sid_access_expires_at
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- SECURITY MODEL: Quota engine execution is strictly restricted to service_role.
-- The backend API server authenticates client JWTs, verifies identities, and calls RPC as service role.
REVOKE EXECUTE ON FUNCTION public.consume_ask_sid_quota(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ask_sid_quota(UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO service_role;

-- ----------------------------------------------------------------------------
-- 9. Webhook Processing & Idempotency Logs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal', 'payhip')),
    event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    processed BOOLEAN NOT NULL DEFAULT false,
    processed_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_provider_event ON public.webhook_logs(provider, event_id);

-- ----------------------------------------------------------------------------
-- 10. Consultations Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.consultations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    date DATE NOT NULL,
    time TEXT NOT NULL,
    service_type TEXT NOT NULL DEFAULT 'advisory',
    status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'confirmed', 'completed', 'cancelled', 'no-show')),
    notes TEXT,
    ics_uid TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultations_date_time ON public.consultations(date, time, status);
CREATE INDEX IF NOT EXISTS idx_consultations_email ON public.consultations(email);

DROP TRIGGER IF EXISTS trg_consultations_updated_at ON public.consultations;
CREATE TRIGGER trg_consultations_updated_at
    BEFORE UPDATE ON public.consultations
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- ----------------------------------------------------------------------------
-- 11. Diagnostic Questionnaire Engine
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_text TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.question_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
    option_text TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    votes INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_question_options_id_question UNIQUE (id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_question_options_qid ON public.question_options(question_id);

CREATE TABLE IF NOT EXISTS public.question_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID NOT NULL,
    option_id UUID NOT NULL,
    voter_ip TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_question_votes_question FOREIGN KEY (question_id) REFERENCES public.questions(id) ON DELETE CASCADE,
    CONSTRAINT fk_question_votes_option_and_question FOREIGN KEY (option_id, question_id) REFERENCES public.question_options(id, question_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.questionnaire_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    profile TEXT NOT NULL,
    answers JSONB NOT NULL DEFAULT '{}'::jsonb,
    total_score INTEGER NOT NULL DEFAULT 0,
    perception_category TEXT NOT NULL,
    voter_ip TEXT,
    session_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON public.questionnaire_submissions(created_at);

-- ----------------------------------------------------------------------------
-- 12. Blogs & Moderated Comments
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blogs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    standfirst TEXT,
    summary TEXT,
    content TEXT NOT NULL,
    topic TEXT,
    topic2 TEXT,
    published_date TIMESTAMPTZ,
    reading_time INTEGER,
    author_byline TEXT DEFAULT 'M. Q. Siddiqui',
    image_url TEXT,
    image_path TEXT,
    image_caption TEXT,
    image_alt TEXT,
    pull_quote TEXT,
    pull_quote_author TEXT,
    pull_quote_position TEXT,
    concluding_insight TEXT,
    sub_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_featured BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'available', 'scheduled', 'archived')),
    scheduled_for TIMESTAMPTZ,
    related_to_book BOOLEAN NOT NULL DEFAULT false,
    book_concept TEXT,
    related_blog_ids TEXT[] DEFAULT '{}',
    seo_title TEXT,
    seo_description TEXT,
    linkedin_url TEXT,
    instagram_url TEXT,
    facebook_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blogs_slug ON public.blogs(slug);
CREATE INDEX IF NOT EXISTS idx_blogs_status ON public.blogs(status, published_date);

DROP TRIGGER IF EXISTS trg_blogs_updated_at ON public.blogs;
CREATE TRIGGER trg_blogs_updated_at
    BEFORE UPDATE ON public.blogs
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TABLE IF NOT EXISTS public.blog_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blog_id UUID NOT NULL REFERENCES public.blogs(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES public.blog_comments(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    admin_id UUID,
    user_name TEXT NOT NULL,
    content TEXT NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT false,
    is_approved BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blog_comments_blog ON public.blog_comments(blog_id, status);

-- ----------------------------------------------------------------------------
-- 13. Coupons, Contact Messages & Telemetry
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coupons (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    discount_percentage NUMERIC(5, 2) NOT NULL,
    discount_type TEXT NOT NULL DEFAULT 'percentage' CHECK (discount_type IN ('percentage', 'fixed')),
    description TEXT,
    min_order_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
    max_uses INTEGER,
    times_used INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_coupons_updated_at ON public.coupons;
CREATE TRIGGER trg_coupons_updated_at
    BEFORE UPDATE ON public.coupons
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TABLE IF NOT EXISTS public.contact_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    subject TEXT,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.course_clicks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    course_title TEXT NOT NULL,
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    email TEXT,
    activity_type TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 14. Comprehensive Row-Level Security (RLS) Policies
-- ============================================================================

-- Enable RLS across all 21 tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ebooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_knowledge_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.first_200_cohort ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ask_sid_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ask_sid_usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consultations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questionnaire_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blog_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_activity ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- PROFILES POLICIES (No Self-Promotion to Admin)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
    FOR SELECT TO authenticated USING (auth.uid() = id OR public.is_admin());

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE TO authenticated USING (auth.uid() = id OR public.is_admin());

DROP POLICY IF EXISTS "profiles_service_role" ON public.profiles;
CREATE POLICY "profiles_service_role" ON public.profiles
    FOR ALL TO service_role USING (true);

-- ----------------------------------------------------------------------------
-- EBOOKS POLICIES (Admin required to modify, published visible to public)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "ebooks_select_public" ON public.ebooks;
CREATE POLICY "ebooks_select_public" ON public.ebooks
    FOR SELECT TO public USING (
        active = true AND publication_status IN ('published', 'available')
    );

DROP POLICY IF EXISTS "ebooks_admin_modify" ON public.ebooks;
CREATE POLICY "ebooks_admin_modify" ON public.ebooks
    FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "ebooks_service_role" ON public.ebooks;
CREATE POLICY "ebooks_service_role" ON public.ebooks
    FOR ALL TO service_role USING (true);

-- ----------------------------------------------------------------------------
-- BOOK CHAPTERS POLICIES
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "book_chapters_select_preview" ON public.book_chapters;
CREATE POLICY "book_chapters_select_preview" ON public.book_chapters
    FOR SELECT TO public USING (
        status IN ('published', 'available') AND is_preview = true
    );

DROP POLICY IF EXISTS "book_chapters_select_entitled" ON public.book_chapters;
CREATE POLICY "book_chapters_select_entitled" ON public.book_chapters
    FOR SELECT TO authenticated USING (
        status IN ('published', 'available') AND EXISTS (
            SELECT 1 FROM public.user_entitlements e
            WHERE e.user_id = auth.uid()
              AND e.book_id = public.book_chapters.book_id
              AND e.is_active = true
              AND e.reader_access_expires_at > now()
        )
    );

DROP POLICY IF EXISTS "book_chapters_admin_modify" ON public.book_chapters;
CREATE POLICY "book_chapters_admin_modify" ON public.book_chapters
    FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "book_chapters_service_role" ON public.book_chapters;
CREATE POLICY "book_chapters_service_role" ON public.book_chapters
    FOR ALL TO service_role USING (true);

-- ----------------------------------------------------------------------------
-- BOOK KNOWLEDGE NODES (Ask SID backend RAG engine only)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "knowledge_nodes_service_role" ON public.book_knowledge_nodes;
CREATE POLICY "knowledge_nodes_service_role" ON public.book_knowledge_nodes
    FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "knowledge_nodes_admin_select" ON public.book_knowledge_nodes;
CREATE POLICY "knowledge_nodes_admin_select" ON public.book_knowledge_nodes
    FOR SELECT TO authenticated USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- ORDERS POLICIES
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "orders_select_own" ON public.orders;
CREATE POLICY "orders_select_own" ON public.orders
    FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_admin());

DROP POLICY IF EXISTS "orders_service_role" ON public.orders;
CREATE POLICY "orders_service_role" ON public.orders
    FOR ALL TO service_role USING (true);

-- ----------------------------------------------------------------------------
-- USER ENTITLEMENTS & COHORT POLICIES
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "entitlements_select_own" ON public.user_entitlements;
CREATE POLICY "entitlements_select_own" ON public.user_entitlements
    FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_admin());

DROP POLICY IF EXISTS "entitlements_service_role" ON public.user_entitlements;
CREATE POLICY "entitlements_service_role" ON public.user_entitlements
    FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "cohort_select_own" ON public.first_200_cohort;
CREATE POLICY "cohort_select_own" ON public.first_200_cohort
    FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_admin());

DROP POLICY IF EXISTS "cohort_service_role" ON public.first_200_cohort;
CREATE POLICY "cohort_service_role" ON public.first_200_cohort
    FOR ALL TO service_role USING (true);

-- ----------------------------------------------------------------------------
-- ASK SID SETTINGS & USAGE LOGS POLICIES
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "ask_sid_settings_select_public" ON public.ask_sid_settings;
CREATE POLICY "ask_sid_settings_select_public" ON public.ask_sid_settings
    FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "ask_sid_settings_admin" ON public.ask_sid_settings;
CREATE POLICY "ask_sid_settings_admin" ON public.ask_sid_settings
    FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "ask_sid_settings_service_role" ON public.ask_sid_settings;
CREATE POLICY "ask_sid_settings_service_role" ON public.ask_sid_settings
    FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "ask_sid_usage_service_role" ON public.ask_sid_usage_logs;
CREATE POLICY "ask_sid_usage_service_role" ON public.ask_sid_usage_logs
    FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "ask_sid_usage_admin_select" ON public.ask_sid_usage_logs;
CREATE POLICY "ask_sid_usage_admin_select" ON public.ask_sid_usage_logs
    FOR SELECT TO authenticated USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- WEBHOOK LOGS POLICIES (Strictly service role)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "webhook_logs_service_role" ON public.webhook_logs;
CREATE POLICY "webhook_logs_service_role" ON public.webhook_logs
    FOR ALL TO service_role USING (true);

-- ----------------------------------------------------------------------------
-- CONSULTATIONS POLICIES
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "consultations_select_own" ON public.consultations;
CREATE POLICY "consultations_select_own" ON public.consultations
    FOR SELECT TO authenticated USING (auth.uid() = user_id OR public.is_admin());

DROP POLICY IF EXISTS "consultations_service_role" ON public.consultations;
CREATE POLICY "consultations_service_role" ON public.consultations
    FOR ALL TO service_role USING (true);

-- ----------------------------------------------------------------------------
-- QUESTIONNAIRE POLICIES
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "questions_select_public" ON public.questions;
CREATE POLICY "questions_select_public" ON public.questions FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "questions_admin" ON public.questions;
CREATE POLICY "questions_admin" ON public.questions FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "question_options_select_public" ON public.question_options;
CREATE POLICY "question_options_select_public" ON public.question_options FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "question_options_admin" ON public.question_options;
CREATE POLICY "question_options_admin" ON public.question_options FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "question_votes_insert_public" ON public.question_votes;
CREATE POLICY "question_votes_insert_public" ON public.question_votes 
    FOR INSERT TO public 
    WITH CHECK (
        length(trim(voter_ip)) > 0 
        AND question_id IS NOT NULL 
        AND option_id IS NOT NULL
    );

DROP POLICY IF EXISTS "submissions_insert_public" ON public.questionnaire_submissions;
CREATE POLICY "submissions_insert_public" ON public.questionnaire_submissions 
    FOR INSERT TO public 
    WITH CHECK (
        length(trim(profile)) > 0 
        AND length(trim(perception_category)) > 0 
        AND (user_id IS NULL OR user_id = auth.uid())
    );

DROP POLICY IF EXISTS "submissions_select_admin" ON public.questionnaire_submissions;
CREATE POLICY "submissions_select_admin" ON public.questionnaire_submissions FOR SELECT TO authenticated USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- BLOGS & COMMENTS POLICIES
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "blogs_select_public" ON public.blogs;
CREATE POLICY "blogs_select_public" ON public.blogs
    FOR SELECT TO public USING (
        status IN ('published', 'available') AND (published_date IS NULL OR published_date <= now())
    );

DROP POLICY IF EXISTS "blogs_admin_modify" ON public.blogs;
CREATE POLICY "blogs_admin_modify" ON public.blogs FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "comments_select_approved" ON public.blog_comments;
CREATE POLICY "comments_select_approved" ON public.blog_comments
    FOR SELECT TO public USING (
        status = 'approved' AND is_approved = true
    );

DROP POLICY IF EXISTS "comments_select_own" ON public.blog_comments;
CREATE POLICY "comments_select_own" ON public.blog_comments
    FOR SELECT TO authenticated USING (
        auth.uid() = user_id
    );

DROP POLICY IF EXISTS "comments_insert_public" ON public.blog_comments;
CREATE POLICY "comments_insert_public" ON public.blog_comments 
    FOR INSERT TO public 
    WITH CHECK (
        is_admin = false 
        AND is_approved = false 
        AND status = 'pending' 
        AND admin_id IS NULL 
        AND length(trim(content)) > 0 
        AND length(trim(user_name)) > 0 
        AND (user_id IS NULL OR user_id = auth.uid())
    );

DROP POLICY IF EXISTS "comments_admin_manage" ON public.blog_comments;
CREATE POLICY "comments_admin_manage" ON public.blog_comments FOR ALL TO authenticated USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- COUPONS, CONTACT & TELEMETRY POLICIES
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "coupons_admin_manage" ON public.coupons;
CREATE POLICY "coupons_admin_manage" ON public.coupons FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "contact_messages_insert_public" ON public.contact_messages;
CREATE POLICY "contact_messages_insert_public" ON public.contact_messages 
    FOR INSERT TO public 
    WITH CHECK (
        length(trim(name)) > 0 
        AND length(trim(email)) >= 5 
        AND position('@' in email) > 1 
        AND length(trim(message)) > 0
    );

DROP POLICY IF EXISTS "contact_messages_admin" ON public.contact_messages;
CREATE POLICY "contact_messages_admin" ON public.contact_messages FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "course_clicks_insert_public" ON public.course_clicks;
CREATE POLICY "course_clicks_insert_public" ON public.course_clicks 
    FOR INSERT TO public 
    WITH CHECK (
        length(trim(course_title)) > 0 
        AND (user_id IS NULL OR user_id = auth.uid())
    );

DROP POLICY IF EXISTS "course_clicks_admin" ON public.course_clicks;
CREATE POLICY "course_clicks_admin" ON public.course_clicks FOR ALL TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "user_activity_admin" ON public.user_activity;
CREATE POLICY "user_activity_admin" ON public.user_activity FOR ALL TO authenticated USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- SERVICE ROLE EXPLICIT UNRESTRICTED OVERARCHING ACCESS
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "sr_profiles" ON public.profiles;
CREATE POLICY "sr_profiles" ON public.profiles FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_ebooks" ON public.ebooks;
CREATE POLICY "sr_ebooks" ON public.ebooks FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_chapters" ON public.book_chapters;
CREATE POLICY "sr_chapters" ON public.book_chapters FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_knowledge" ON public.book_knowledge_nodes;
CREATE POLICY "sr_knowledge" ON public.book_knowledge_nodes FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_orders" ON public.orders;
CREATE POLICY "sr_orders" ON public.orders FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_entitlements" ON public.user_entitlements;
CREATE POLICY "sr_entitlements" ON public.user_entitlements FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_cohort" ON public.first_200_cohort;
CREATE POLICY "sr_cohort" ON public.first_200_cohort FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_ask_settings" ON public.ask_sid_settings;
CREATE POLICY "sr_ask_settings" ON public.ask_sid_settings FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_ask_usage" ON public.ask_sid_usage_logs;
CREATE POLICY "sr_ask_usage" ON public.ask_sid_usage_logs FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_webhooks" ON public.webhook_logs;
CREATE POLICY "sr_webhooks" ON public.webhook_logs FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_consultations" ON public.consultations;
CREATE POLICY "sr_consultations" ON public.consultations FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_questions" ON public.questions;
CREATE POLICY "sr_questions" ON public.questions FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_options" ON public.question_options;
CREATE POLICY "sr_options" ON public.question_options FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_votes" ON public.question_votes;
CREATE POLICY "sr_votes" ON public.question_votes FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_submissions" ON public.questionnaire_submissions;
CREATE POLICY "sr_submissions" ON public.questionnaire_submissions FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_blogs" ON public.blogs;
CREATE POLICY "sr_blogs" ON public.blogs FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_comments" ON public.blog_comments;
CREATE POLICY "sr_comments" ON public.blog_comments FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_coupons" ON public.coupons;
CREATE POLICY "sr_coupons" ON public.coupons FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_contact" ON public.contact_messages;
CREATE POLICY "sr_contact" ON public.contact_messages FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_clicks" ON public.course_clicks;
CREATE POLICY "sr_clicks" ON public.course_clicks FOR ALL TO service_role USING (true);
DROP POLICY IF EXISTS "sr_activity" ON public.user_activity;
CREATE POLICY "sr_activity" ON public.user_activity FOR ALL TO service_role USING (true);
