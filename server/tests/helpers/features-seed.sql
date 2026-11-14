-- Test fixtures for the reader and Ask SID (applied after the migration inside the in-memory Postgres).
INSERT INTO public.reader_books (id, slug, title, subtitle, status, position) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'marketing-reclassified-online', 'Marketing Reclassified', 'Online Reading Edition', 'published', 1),
  ('b0000000-0000-4000-8000-000000000002', 'unreleased-book', 'Unreleased', NULL, 'draft', 2);
INSERT INTO public.reader_chapters (id, book_id, slug, title, position, content_html, status) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'principle-first-mandate', 'The Principle-First Mandate', 1, '<h2>Chapter one</h2><p>Published text.</p>', 'published'),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'marketing-as-discipline', 'Marketing as a Strategic Discipline', 2, '<p>Second chapter.</p>', 'published'),
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'draft-chapter', 'Draft chapter', 3, '<p>DRAFT-SECRET</p>', 'draft'),
  ('c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', 'withdrawn-chapter', 'Withdrawn chapter', 4, '<p>UNPUBLISHED-SECRET</p>', 'unpublished'),
  ('c0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000002', 'hidden-book-chapter', 'Hidden', 1, '<p>HIDDEN-BOOK-SECRET</p>', 'published');
INSERT INTO public.knowledge_chunks (source, concept, chapter_ref, content, position) VALUES
  ('book', 'Value Drift', 'Chapter 6: Protecting Against Value Drift', 'Value drift happens when growth erodes the trust of existing customers. Newer customers receive less care than the first advocates did. The remedy is to measure retention before spending on acquisition.', 1),
  ('book', 'Price-led competition', 'Chapter 5: Sustainable Growth vs Short-Term Tactics', 'Price is the exchange mechanism for perceived value. Cutting price in response to a competitor starts a commoditization spiral.', 2),
  ('companion', 'Value Drift Diagnostic', 'Companion Pack, Worksheet 6', 'The value drift diagnostic worksheet scores each customer segment on care, relevance and trust. Complete the worksheet every quarter.', 3);
INSERT INTO public.companion_files (id, storage_path, original_name, size_bytes, sha256, version, is_current, process_status, chunk_count)
VALUES ('f0000000-0000-4000-8000-000000000001', 'companion/marketing-reclassified/v2-abcdef123456.pdf', 'companion-v2.pdf', 1234, 'abcdef123456abcdef123456abcdef123456abcdef123456abcdef123456abcd', 2, true, 'indexed', 1);
INSERT INTO public.reader_chapters (id, book_id, slug, title, position, content_html, status) VALUES
  ('c0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000001', 'hostile-content', 'Hostile content', 5, '<p>Safe paragraph.</p><img src="x" onerror="window.__xss=1"><script>window.__xss=1</script><a href="javascript:window.__xss=1">bad</a>', 'published');
