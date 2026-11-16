-- Rollback of 20261114_book_pdf_download.sql. Removes the book PDF rows first (their storage objects stay in the bucket).
DELETE FROM public.companion_files WHERE kind = 'book_pdf';
ALTER TABLE public.companion_files DROP CONSTRAINT IF EXISTS companion_files_kind_check;
ALTER TABLE public.companion_files ADD CONSTRAINT companion_files_kind_check CHECK (kind IN ('companion_pdf'));
ALTER TABLE public.orders DROP COLUMN IF EXISTS book_download_count;
