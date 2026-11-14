-- ============================================================================
-- Siddiqui.digital - Features foundation (Online Reading, Digital Companion, Ask SID, entitlements)
-- PRODUCTION-ADDITIVE and IDEMPOTENT: creates NEW objects only. It never alters or drops an existing table,
-- column, policy or row (orders, ebooks, profiles, blogs ... are untouched).
-- Security model: every new table has RLS enabled and NO policy for anon/authenticated, so only the backend
-- (service role / secret key) can read or write them. All permission decisions are made in the backend.
-- Apply order: staging first, then production, only after owner approval. Rollback: 20261110_features_foundation_rollback.sql
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.feat_set_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION public.feat_norm_email(p text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$ SELECT lower(btrim(coalesce(p, ''))) $$;

-- ---------------------------------------------------------------------------
-- 1. Settings (one row per key)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entitlement_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.entitlement_settings (key, value) VALUES
  ('ask_sid_limits', '{"daily":5,"standard_total":100,"launch_total":150,"months":12,"launch_size":200,"launch_starts_at":"9999-12-31T00:00:00Z"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Online reading content (books and chapters) - managed from the admin dashboard
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reader_books (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_key   text NOT NULL DEFAULT 'marketing-reclassified',
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title         text NOT NULL CHECK (length(btrim(title)) > 0),
  subtitle      text,
  description   text,
  cover_image_url text,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished')),
  position      integer NOT NULL DEFAULT 0,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reader_books_catalog ON public.reader_books (catalog_key, status, position);
DROP TRIGGER IF EXISTS trg_reader_books_updated ON public.reader_books;
CREATE TRIGGER trg_reader_books_updated BEFORE UPDATE ON public.reader_books FOR EACH ROW EXECUTE FUNCTION public.feat_set_updated_at();

CREATE TABLE IF NOT EXISTS public.reader_chapters (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id      uuid NOT NULL REFERENCES public.reader_books(id) ON DELETE CASCADE,
  slug         text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title        text NOT NULL CHECK (length(btrim(title)) > 0),
  position     integer NOT NULL DEFAULT 0,
  content_html text NOT NULL DEFAULT '',            -- sanitised by the admin API before it is stored
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished')),
  published_at timestamptz,
  version      integer NOT NULL DEFAULT 1,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_reader_chapters_order ON public.reader_chapters (book_id, status, position);
DROP TRIGGER IF EXISTS trg_reader_chapters_updated ON public.reader_chapters;
CREATE TRIGGER trg_reader_chapters_updated BEFORE UPDATE ON public.reader_chapters FOR EACH ROW EXECUTE FUNCTION public.feat_set_updated_at();

CREATE TABLE IF NOT EXISTS public.reading_progress (
  user_id    uuid NOT NULL,
  book_id    uuid NOT NULL REFERENCES public.reader_books(id) ON DELETE CASCADE,
  chapter_id uuid NOT NULL REFERENCES public.reader_chapters(id) ON DELETE CASCADE,
  percent    numeric(5,2) NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, book_id)
);

-- Atomic, validated re-ordering: the id list must be exactly the book's chapters.
CREATE OR REPLACE FUNCTION public.reorder_reader_chapters(p_book_id uuid, p_ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_have integer; v_n integer;
BEGIN
  PERFORM 1 FROM public.reader_books WHERE id = p_book_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'book_not_found'; END IF;
  SELECT count(*) INTO v_have FROM public.reader_chapters WHERE book_id = p_book_id;
  v_n := coalesce(array_length(p_ids, 1), 0);
  IF v_n <> v_have OR (SELECT count(DISTINCT x) FROM unnest(p_ids) x) <> v_n
     OR EXISTS (SELECT 1 FROM unnest(p_ids) x WHERE NOT EXISTS (SELECT 1 FROM public.reader_chapters c WHERE c.id = x AND c.book_id = p_book_id)) THEN
    RAISE EXCEPTION 'chapter_list_mismatch';
  END IF;
  UPDATE public.reader_chapters c SET position = o.ord FROM (SELECT x, ord FROM unnest(p_ids) WITH ORDINALITY AS t(x, ord)) o WHERE c.id = o.x AND c.book_id = p_book_id;
  RETURN v_n;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Entitlements (the single source of truth for what a customer may use)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_entitlements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_key           text NOT NULL DEFAULT 'marketing-reclassified',
  email                 text NOT NULL,                       -- normalised (lower/trim)
  user_id               uuid,
  edition               text NOT NULL CHECK (edition IN ('online','companion')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  order_id              uuid,                                -- the order that created it
  is_upgrade            boolean NOT NULL DEFAULT false,
  supersedes_id         uuid REFERENCES public.user_entitlements(id),
  granted_at            timestamptz NOT NULL DEFAULT now(),  -- purchase / upgrade date
  ask_sid_expires_at    timestamptz,                         -- companion only: granted_at + 12 months
  launch_position       integer,                             -- 1..200, companion only
  total_question_limit  integer,
  daily_question_limit  integer,
  question_bonus        integer NOT NULL DEFAULT 0,          -- administrative correction, audited
  revoked_at            timestamptz,
  revoke_reason         text CHECK (revoke_reason IS NULL OR revoke_reason IN ('full_refund','upgraded','superseded','administrative','chargeback')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ent_companion_fields CHECK (
    (edition = 'companion' AND ask_sid_expires_at IS NOT NULL AND total_question_limit IS NOT NULL AND daily_question_limit IS NOT NULL)
    OR (edition = 'online' AND ask_sid_expires_at IS NULL AND launch_position IS NULL AND total_question_limit IS NULL AND daily_question_limit IS NULL)),
  CONSTRAINT chk_ent_revoked_fields CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
-- Mutual exclusivity: at most ONE active entitlement per customer and catalogue. Online and Companion can never both be active.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ent_one_active ON public.user_entitlements (catalog_key, email) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_ent_order ON public.user_entitlements (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ent_user ON public.user_entitlements (user_id);
CREATE INDEX IF NOT EXISTS idx_ent_email ON public.user_entitlements (email);
DROP TRIGGER IF EXISTS trg_ent_updated ON public.user_entitlements;
CREATE TRIGGER trg_ent_updated BEFORE UPDATE ON public.user_entitlements FOR EACH ROW EXECUTE FUNCTION public.feat_set_updated_at();

-- First-200 launch allocation: immutable, never re-assigned (a refund keeps the position).
CREATE TABLE IF NOT EXISTS public.launch_allocations (
  position       integer PRIMARY KEY CHECK (position BETWEEN 1 AND 200),
  entitlement_id uuid NOT NULL UNIQUE REFERENCES public.user_entitlements(id),
  order_id       uuid UNIQUE,
  email          text NOT NULL,
  allocated_at   timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit trail.
CREATE TABLE IF NOT EXISTS public.entitlement_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entitlement_id uuid,
  email          text,
  order_id       uuid,
  event_type     text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id       uuid,
  actor_label    text NOT NULL DEFAULT 'system',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ent_events_ent ON public.entitlement_events (entitlement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ent_events_email ON public.entitlement_events (email, created_at);
CREATE OR REPLACE FUNCTION public.feat_events_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'entitlement_events is append-only'; END $$;
DROP TRIGGER IF EXISTS trg_ent_events_immutable ON public.entitlement_events;
CREATE TRIGGER trg_ent_events_immutable BEFORE UPDATE OR DELETE ON public.entitlement_events FOR EACH ROW EXECUTE FUNCTION public.feat_events_immutable();

-- Ask SID usage: reserve -> commit (answer delivered) / release (rejected or failed). Only reserved(live)+committed count.
CREATE TABLE IF NOT EXISTS public.ask_sid_usage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id uuid NOT NULL REFERENCES public.user_entitlements(id),
  user_id        uuid,
  day            date NOT NULL,                                -- UTC day the question counts toward
  status         text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','committed','released')),
  reserved_at    timestamptz NOT NULL DEFAULT now(),
  committed_at   timestamptz,
  released_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_asu_ent_day ON public.ask_sid_usage (entitlement_id, day, status);

-- Webhook delivery log (idempotency visibility, failures). Contains NO personal data: transaction/product identifiers only.
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider     text NOT NULL,
  event_key    text NOT NULL,                                  -- '<type>:<provider transaction id>'
  event_type   text NOT NULL,
  outcome      text NOT NULL DEFAULT 'received' CHECK (outcome IN ('received','processed','duplicate','ignored','rejected','failed')),
  http_status  integer,
  attempts     integer NOT NULL DEFAULT 1,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_key)
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_outcome ON public.webhook_events (outcome, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Companion files and the knowledge index used by Ask SID
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companion_files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_key    text NOT NULL DEFAULT 'marketing-reclassified',
  kind           text NOT NULL DEFAULT 'companion_pdf' CHECK (kind IN ('companion_pdf')),
  storage_bucket text NOT NULL DEFAULT 'digital-products',
  storage_path   text NOT NULL,
  original_name  text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0),
  sha256         text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  is_current     boolean NOT NULL DEFAULT false,
  process_status text NOT NULL DEFAULT 'uploaded' CHECK (process_status IN ('uploaded','processing','indexed','failed')),
  chunk_count    integer NOT NULL DEFAULT 0,
  error_message  text,
  attempts       integer NOT NULL DEFAULT 0,
  uploaded_by    uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_companion_current ON public.companion_files (catalog_key, kind) WHERE is_current;

CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_key text NOT NULL DEFAULT 'marketing-reclassified',
  source      text NOT NULL CHECK (source IN ('book','companion')),
  file_id     uuid REFERENCES public.companion_files(id) ON DELETE CASCADE,
  reader_chapter_id uuid REFERENCES public.reader_chapters(id) ON DELETE CASCADE,   -- published chapters are indexed automatically
  origin_key  text,                                   -- idempotency key for seeded chunks ('seed:<id>:<n>')
  chapter_ref text,
  concept     text,
  content     text NOT NULL CHECK (length(content) > 0),
  position    integer NOT NULL DEFAULT 0,
  tsv         tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('english', coalesce(concept, '')), 'A') ||
                setweight(to_tsvector('english', coalesce(chapter_ref, '')), 'B') ||
                setweight(to_tsvector('english', content), 'C')) STORED,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON public.knowledge_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_chunks_src ON public.knowledge_chunks (catalog_key, source);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chunks_origin ON public.knowledge_chunks (origin_key) WHERE origin_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_chapter ON public.knowledge_chunks (reader_chapter_id) WHERE reader_chapter_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Administrative audit log (content management and entitlement corrections)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid,
  actor_label text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 6. Entitlement engine (atomic; callable by the backend service role only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.feat_limits() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT value FROM public.entitlement_settings WHERE key = 'ask_sid_limits'),
         '{"daily":5,"standard_total":100,"launch_total":150,"months":12,"launch_size":200,"launch_starts_at":"9999-12-31T00:00:00Z"}'::jsonb) $$;

CREATE OR REPLACE FUNCTION public.feat_log(p_ent uuid, p_email text, p_order uuid, p_type text, p_detail jsonb, p_actor uuid, p_label text) RETURNS void
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO public.entitlement_events (entitlement_id, email, order_id, event_type, detail, actor_id, actor_label)
  VALUES (p_ent, p_email, p_order, p_type, coalesce(p_detail, '{}'::jsonb), p_actor, coalesce(p_label, 'system')) $$;

-- Grant (or confirm) the entitlement that a PAID order buys. Idempotent per order.
--   online    -> online reading only
--   companion -> downloads + Ask SID only; revokes an active Online entitlement (upgrade or direct purchase)
-- Returns jsonb: { result, entitlement_id, edition, launch_position, total_limit, expires_at }
CREATE OR REPLACE FUNCTION public.grant_entitlement_for_order(
  p_order_id uuid, p_email text, p_user_id uuid, p_edition text, p_is_upgrade boolean, p_paid_at timestamptz,
  p_catalog text DEFAULT 'marketing-reclassified'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email text := public.feat_norm_email(p_email);
  v_paid  timestamptz := coalesce(p_paid_at, now());
  v_lim   jsonb := public.feat_limits();
  v_exist public.user_entitlements%ROWTYPE;
  v_act   public.user_entitlements%ROWTYPE;
  v_new   uuid;
  v_pos   integer := NULL;
  v_total integer;
  v_starts timestamptz;
  v_size  integer;
BEGIN
  IF v_email = '' THEN RAISE EXCEPTION 'email_required'; END IF;
  IF p_edition NOT IN ('online','companion') THEN RAISE EXCEPTION 'bad_edition'; END IF;
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'order_required'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ent:' || p_catalog || ':' || v_email));

  SELECT * INTO v_exist FROM public.user_entitlements WHERE order_id = p_order_id;
  IF FOUND THEN
    -- The purchase was re-assigned to another account (Payhip "claim your purchase"): the entitlement follows the order.
    IF v_exist.email <> v_email AND v_exist.status = 'active' THEN
      IF EXISTS (SELECT 1 FROM public.user_entitlements WHERE catalog_key = p_catalog AND email = v_email AND status = 'active') THEN
        PERFORM public.feat_log(v_exist.id, v_email, p_order_id, 'email_change_blocked', jsonb_build_object('reason', 'target_has_active_entitlement'), NULL, 'system');
        RETURN jsonb_build_object('result', 'email_change_blocked', 'entitlement_id', v_exist.id, 'edition', v_exist.edition);
      END IF;
      UPDATE public.user_entitlements SET email = v_email, user_id = p_user_id WHERE id = v_exist.id;
      PERFORM public.feat_log(v_exist.id, v_email, p_order_id, 'email_changed', '{}'::jsonb, NULL, 'system');
      RETURN jsonb_build_object('result', 'email_changed', 'entitlement_id', v_exist.id, 'edition', v_exist.edition, 'status', v_exist.status, 'launch_position', v_exist.launch_position);
    END IF;
    RETURN jsonb_build_object('result', 'already_processed', 'entitlement_id', v_exist.id, 'edition', v_exist.edition,
      'status', v_exist.status, 'launch_position', v_exist.launch_position);
  END IF;

  SELECT * INTO v_act FROM public.user_entitlements WHERE catalog_key = p_catalog AND email = v_email AND status = 'active';

  IF p_edition = 'online' THEN
    IF FOUND AND v_act.edition = 'companion' THEN
      PERFORM public.feat_log(v_act.id, v_email, p_order_id, 'online_purchase_ignored', jsonb_build_object('reason', 'companion_active'), NULL, 'system');
      RETURN jsonb_build_object('result', 'skipped_companion_active', 'entitlement_id', v_act.id, 'edition', 'companion');
    END IF;
    IF FOUND AND v_act.edition = 'online' THEN
      PERFORM public.feat_log(v_act.id, v_email, p_order_id, 'duplicate_online_purchase', '{}'::jsonb, NULL, 'system');
      RETURN jsonb_build_object('result', 'skipped_online_active', 'entitlement_id', v_act.id, 'edition', 'online');
    END IF;
    INSERT INTO public.user_entitlements (catalog_key, email, user_id, edition, order_id, is_upgrade, granted_at)
    VALUES (p_catalog, v_email, p_user_id, 'online', p_order_id, false, v_paid) RETURNING id INTO v_new;
    PERFORM public.feat_log(v_new, v_email, p_order_id, 'granted_online', '{}'::jsonb, NULL, 'system');
    RETURN jsonb_build_object('result', 'granted', 'entitlement_id', v_new, 'edition', 'online');
  END IF;

  -- companion
  IF FOUND AND v_act.edition = 'companion' THEN
    PERFORM public.feat_log(v_act.id, v_email, p_order_id, 'duplicate_companion_purchase', '{}'::jsonb, NULL, 'system');
    RETURN jsonb_build_object('result', 'skipped_companion_active', 'entitlement_id', v_act.id, 'edition', 'companion');
  END IF;
  IF FOUND AND v_act.edition = 'online' THEN
    UPDATE public.user_entitlements SET status = 'revoked', revoked_at = now(),
           revoke_reason = CASE WHEN p_is_upgrade THEN 'upgraded' ELSE 'superseded' END WHERE id = v_act.id;
    PERFORM public.feat_log(v_act.id, v_email, p_order_id, 'online_revoked', jsonb_build_object('reason', CASE WHEN p_is_upgrade THEN 'upgraded' ELSE 'superseded' END), NULL, 'system');
  END IF;

  v_total := (v_lim->>'standard_total')::int;
  INSERT INTO public.user_entitlements (catalog_key, email, user_id, edition, order_id, is_upgrade, supersedes_id, granted_at,
        ask_sid_expires_at, total_question_limit, daily_question_limit)
  VALUES (p_catalog, v_email, p_user_id, 'companion', p_order_id, coalesce(p_is_upgrade, false), CASE WHEN v_act.edition = 'online' THEN v_act.id END, v_paid,
        v_paid + make_interval(months => (v_lim->>'months')::int), v_total, (v_lim->>'daily')::int)
  RETURNING id INTO v_new;

  -- Launch offer: strictly chronological by call order, serialised by a global lock, never re-assigned.
  PERFORM pg_advisory_xact_lock(hashtext('launch_allocation'));
  v_size := (v_lim->>'launch_size')::int;
  v_starts := nullif(v_lim->>'launch_starts_at', '')::timestamptz;
  IF (v_starts IS NULL OR v_paid >= v_starts) THEN
    SELECT coalesce(max(position), 0) + 1 INTO v_pos FROM public.launch_allocations;
    IF v_pos <= v_size AND v_pos <= 200 THEN
      INSERT INTO public.launch_allocations (position, entitlement_id, order_id, email) VALUES (v_pos, v_new, p_order_id, v_email);
      v_total := (v_lim->>'launch_total')::int;
      UPDATE public.user_entitlements SET launch_position = v_pos, total_question_limit = v_total WHERE id = v_new;
    ELSE
      v_pos := NULL;
    END IF;
  END IF;

  PERFORM public.feat_log(v_new, v_email, p_order_id,
    CASE WHEN coalesce(p_is_upgrade, false) THEN 'granted_companion_upgrade' ELSE 'granted_companion' END,
    jsonb_build_object('launch_position', v_pos, 'total_limit', v_total), NULL, 'system');

  RETURN jsonb_build_object('result', 'granted', 'entitlement_id', v_new, 'edition', 'companion', 'launch_position', v_pos,
    'total_limit', v_total, 'expires_at', v_paid + make_interval(months => (v_lim->>'months')::int));
END $$;

-- Full refund: revoke whatever the order bought. History and launch position are kept.
CREATE OR REPLACE FUNCTION public.revoke_entitlement_for_order(p_order_id uuid, p_reason text DEFAULT 'full_refund') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v public.user_entitlements%ROWTYPE;
BEGIN
  IF p_reason NOT IN ('full_refund','chargeback') THEN RAISE EXCEPTION 'bad_reason'; END IF;
  SELECT * INTO v FROM public.user_entitlements WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'no_entitlement'); END IF;
  IF v.status = 'revoked' THEN RETURN jsonb_build_object('result', 'already_revoked', 'entitlement_id', v.id, 'revoke_reason', v.revoke_reason); END IF;
  UPDATE public.user_entitlements SET status = 'revoked', revoked_at = now(), revoke_reason = p_reason WHERE id = v.id;
  PERFORM public.feat_log(v.id, v.email, p_order_id, 'revoked_' || p_reason, '{}'::jsonb, NULL, 'system');
  RETURN jsonb_build_object('result', 'revoked', 'entitlement_id', v.id, 'edition', v.edition);
END $$;

-- Current access for a verified customer (by e-mail). Used for every gate: reader, downloads, Ask SID.
CREATE OR REPLACE FUNCTION public.get_active_entitlement(p_email text, p_catalog text DEFAULT 'marketing-reclassified') RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT to_jsonb(e) FROM public.user_entitlements e
          WHERE e.catalog_key = p_catalog AND e.email = public.feat_norm_email(p_email) AND e.status = 'active'), 'null'::jsonb) $$;

-- Ask SID: reserve one question. Every check is made under a row lock so concurrent requests cannot exceed a limit.
CREATE OR REPLACE FUNCTION public.reserve_ask_sid_question(p_email text, p_user_id uuid, p_catalog text DEFAULT 'marketing-reclassified') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email text := public.feat_norm_email(p_email);
  e public.user_entitlements%ROWTYPE;
  v_day date := (now() AT TIME ZONE 'UTC')::date;
  v_daily_used integer; v_total_used integer; v_total_limit integer; v_daily_limit integer; v_id uuid;
BEGIN
  SELECT * INTO e FROM public.user_entitlements WHERE catalog_key = p_catalog AND email = v_email AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.user_entitlements WHERE catalog_key = p_catalog AND email = v_email AND status = 'revoked' AND edition = 'companion') THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'revoked');
    END IF;
    RETURN jsonb_build_object('allowed', false, 'reason', 'no_entitlement');
  END IF;
  IF e.edition <> 'companion' THEN RETURN jsonb_build_object('allowed', false, 'reason', 'online_only'); END IF;
  IF e.ask_sid_expires_at <= now() THEN RETURN jsonb_build_object('allowed', false, 'reason', 'expired', 'expired_at', e.ask_sid_expires_at); END IF;
  IF e.user_id IS NULL AND p_user_id IS NOT NULL THEN UPDATE public.user_entitlements SET user_id = p_user_id WHERE id = e.id; END IF;

  v_daily_limit := e.daily_question_limit;
  v_total_limit := e.total_question_limit + e.question_bonus;
  SELECT count(*) FILTER (WHERE day = v_day), count(*) INTO v_daily_used, v_total_used
    FROM public.ask_sid_usage
   WHERE entitlement_id = e.id AND (status = 'committed' OR (status = 'reserved' AND reserved_at > now() - interval '2 minutes'));

  IF v_total_used >= v_total_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'total_limit', 'total_limit', v_total_limit, 'total_used', v_total_used);
  END IF;
  IF v_daily_used >= v_daily_limit THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'daily_limit', 'daily_limit', v_daily_limit, 'daily_used', v_daily_used,
      'resets_at', ((v_day + 1)::timestamp AT TIME ZONE 'UTC'));
  END IF;
  INSERT INTO public.ask_sid_usage (entitlement_id, user_id, day) VALUES (e.id, coalesce(p_user_id, e.user_id), v_day) RETURNING id INTO v_id;
  RETURN jsonb_build_object('allowed', true, 'usage_id', v_id, 'entitlement_id', e.id,
    'daily_limit', v_daily_limit, 'daily_used', v_daily_used + 1, 'total_limit', v_total_limit, 'total_used', v_total_used + 1,
    'launch_position', e.launch_position, 'expires_at', e.ask_sid_expires_at);
END $$;

CREATE OR REPLACE FUNCTION public.commit_ask_sid_question(p_usage_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE public.ask_sid_usage SET status = 'committed', committed_at = now() WHERE id = p_usage_id AND status = 'reserved';
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$;

CREATE OR REPLACE FUNCTION public.release_ask_sid_question(p_usage_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE public.ask_sid_usage SET status = 'released', released_at = now() WHERE id = p_usage_id AND status = 'reserved';
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$;

-- Current allowance of an entitlement (for the customer and for the admin dashboard).
CREATE OR REPLACE FUNCTION public.ask_sid_allowance(p_entitlement_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.user_entitlements%ROWTYPE; v_day date := (now() AT TIME ZONE 'UTC')::date; d integer; t integer;
BEGIN
  SELECT * INTO e FROM public.user_entitlements WHERE id = p_entitlement_id;
  IF NOT FOUND OR e.edition <> 'companion' THEN RETURN 'null'::jsonb; END IF;
  SELECT count(*) FILTER (WHERE day = v_day), count(*) INTO d, t FROM public.ask_sid_usage
   WHERE entitlement_id = e.id AND (status = 'committed' OR (status = 'reserved' AND reserved_at > now() - interval '2 minutes'));
  RETURN jsonb_build_object('daily_limit', e.daily_question_limit, 'daily_used', d, 'daily_remaining', greatest(e.daily_question_limit - d, 0),
    'total_limit', e.total_question_limit + e.question_bonus, 'total_used', t,
    'total_remaining', greatest(e.total_question_limit + e.question_bonus - t, 0), 'expires_at', e.ask_sid_expires_at, 'launch_position', e.launch_position);
END $$;

-- Administrative corrections: always with a reason, always audited, one transaction.
CREATE OR REPLACE FUNCTION public.admin_entitlement_action(
  p_entitlement_id uuid, p_action text, p_amount integer, p_reason text, p_actor_id uuid, p_actor_label text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.user_entitlements%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN RAISE EXCEPTION 'reason_required'; END IF;
  SELECT * INTO e FROM public.user_entitlements WHERE id = p_entitlement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'entitlement_not_found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ent:' || e.catalog_key || ':' || e.email));

  IF p_action = 'revoke' THEN
    IF e.status = 'revoked' THEN RAISE EXCEPTION 'already_revoked'; END IF;
    UPDATE public.user_entitlements SET status = 'revoked', revoked_at = now(), revoke_reason = 'administrative' WHERE id = e.id;
  ELSIF p_action = 'restore' THEN
    IF e.status <> 'revoked' THEN RAISE EXCEPTION 'not_revoked'; END IF;
    IF e.revoke_reason IN ('full_refund','chargeback') THEN RAISE EXCEPTION 'refunded_entitlement_cannot_be_restored'; END IF;
    IF EXISTS (SELECT 1 FROM public.user_entitlements WHERE catalog_key = e.catalog_key AND email = e.email AND status = 'active') THEN RAISE EXCEPTION 'another_entitlement_active'; END IF;
    UPDATE public.user_entitlements SET status = 'active', revoked_at = NULL, revoke_reason = NULL WHERE id = e.id;
  ELSIF p_action = 'extend_months' THEN
    IF e.edition <> 'companion' OR p_amount IS NULL OR p_amount < 1 OR p_amount > 24 THEN RAISE EXCEPTION 'bad_amount'; END IF;
    UPDATE public.user_entitlements SET ask_sid_expires_at = ask_sid_expires_at + make_interval(months => p_amount) WHERE id = e.id;
  ELSIF p_action = 'add_questions' THEN
    IF e.edition <> 'companion' OR p_amount IS NULL OR p_amount = 0 OR abs(p_amount) > 1000 THEN RAISE EXCEPTION 'bad_amount'; END IF;
    UPDATE public.user_entitlements SET question_bonus = e.question_bonus + p_amount WHERE id = e.id;
  ELSE
    RAISE EXCEPTION 'bad_action';
  END IF;
  PERFORM public.feat_log(e.id, e.email, e.order_id, 'admin_' || p_action, jsonb_build_object('amount', p_amount, 'reason', p_reason), p_actor_id, p_actor_label);
  INSERT INTO public.admin_audit_log (actor_id, actor_label, action, target_type, target_id, detail)
  VALUES (p_actor_id, p_actor_label, 'entitlement.' || p_action, 'user_entitlement', e.id::text, jsonb_build_object('amount', p_amount, 'reason', p_reason));
  RETURN jsonb_build_object('result', 'ok', 'entitlement_id', e.id);
END $$;

-- ---------------------------------------------------------------------------
-- 7. Lock everything down: RLS on, no client policies, functions for the service role only
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['entitlement_settings','reader_books','reader_chapters','reading_progress','user_entitlements','launch_allocations',
      'entitlement_events','ask_sid_usage','webhook_events','companion_files','knowledge_chunks','admin_audit_log'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.grant_entitlement_for_order(uuid, text, uuid, text, boolean, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_entitlement_for_order(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_active_entitlement(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_ask_sid_question(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_ask_sid_question(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_ask_sid_question(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ask_sid_allowance(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_entitlement_action(uuid, text, integer, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reorder_reader_chapters(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_entitlement_for_order(uuid, text, uuid, text, boolean, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_entitlement_for_order(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_active_entitlement(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_ask_sid_question(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_ask_sid_question(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_ask_sid_question(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ask_sid_allowance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_entitlement_action(uuid, text, integer, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reorder_reader_chapters(uuid, uuid[]) TO service_role;

-- Knowledge retrieval for Ask SID: OR-search over the lexemes of the question, ranked, with how many of the question's
-- meaningful words each chunk actually contains (the caller refuses to answer when coverage is too low = out of scope).
CREATE OR REPLACE FUNCTION public.search_knowledge(p_query text, p_sources text[], p_limit integer DEFAULT 4, p_catalog text DEFAULT 'marketing-reclassified')
RETURNS TABLE (id uuid, source text, chapter_ref text, concept text, content text, rank real, matched integer, total integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_lex text[]; v_q tsquery; v_total integer;
BEGIN
  SELECT coalesce(array_agg(lexeme), '{}') INTO v_lex FROM unnest(to_tsvector('english', left(coalesce(p_query, ''), 600)));
  v_total := coalesce(array_length(v_lex, 1), 0);
  IF v_total = 0 THEN RETURN; END IF;
  SELECT to_tsquery('simple', string_agg(quote_literal(l), ' | ')) INTO v_q FROM unnest(v_lex) l;
  RETURN QUERY
    SELECT k.id, k.source, k.chapter_ref, k.concept, k.content,
           ts_rank_cd(k.tsv, v_q)::real AS rank,
           (SELECT count(*)::int FROM unnest(v_lex) l WHERE k.tsv @@ to_tsquery('simple', quote_literal(l))) AS matched,
           v_total AS total
      FROM public.knowledge_chunks k
     WHERE k.catalog_key = p_catalog AND k.source = ANY (p_sources) AND k.tsv @@ v_q
     ORDER BY 7 DESC, 6 DESC, k.position
     LIMIT greatest(1, least(coalesce(p_limit, 4), 10));
END $$;
REVOKE ALL ON FUNCTION public.search_knowledge(text, text[], integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_knowledge(text, text[], integer, text) TO service_role;
