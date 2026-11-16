-- Book PDF download (Digital Companion edition: book PDF + Companion Pack PDF).
-- Safe to run more than once. Adds nothing that existing code depends on:
--   1. companion_files.kind may now also be 'book_pdf' (a download-only file, never indexed for Ask SID).
--      The unique index uq_companion_current is per (catalog_key, kind), so each kind keeps exactly one CURRENT file.
--   2. orders.book_download_count: downloads of the book PDF are counted separately from the Companion Pack
--      (same limit as the order's download_limit, normally 3 each).
-- Run it BEFORE installing the new backend/admin code. Rollback: 20261114_book_pdf_download_rollback.sql

ALTER TABLE public.companion_files DROP CONSTRAINT IF EXISTS companion_files_kind_check;
ALTER TABLE public.companion_files ADD CONSTRAINT companion_files_kind_check CHECK (kind IN ('companion_pdf', 'book_pdf'));

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS book_download_count integer NOT NULL DEFAULT 0;

-- check (read-only): both lines must show
select 'kind constraint' as what, pg_get_constraintdef(oid) as value from pg_constraint where conname = 'companion_files_kind_check'
union all
select 'orders.book_download_count', data_type from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'book_download_count';
