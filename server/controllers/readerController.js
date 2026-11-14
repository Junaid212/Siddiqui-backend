/**
 * readerController.js - the Online Reading experience (customer side, read-only).
 *
 * Every endpoint needs a verified customer session AND an active Online Reading entitlement (see utils/entitlements.js).
 * Digital Companion customers are refused. Only PUBLISHED books and chapters are ever returned; drafts and unpublished
 * chapters do not exist as far as this API is concerned. There is no write endpoint except the customer's own reading progress.
 */
const supabase = require("../config/supabaseClient");
const { CATALOG_KEY, resolveAccess } = require("../utils/entitlements");
const { getAskSidSettings } = require("../utils/askSidSettingsStore");

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const noStore = (res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
};

async function loadPublishedBook(slug) {
  if (!SLUG_RE.test(String(slug || ""))) return null;
  const { data } = await supabase.from("reader_books").select("id,slug,title,subtitle,description,cover_image_url,position")
    .eq("catalog_key", CATALOG_KEY).eq("slug", slug).eq("status", "published").maybeSingle();
  return data || null;
}
async function loadPublishedChapters(bookId) {
  const { data } = await supabase.from("reader_chapters").select("id,slug,title,position").eq("book_id", bookId).eq("status", "published").order("position", { ascending: true });
  return data || [];
}

/** GET /api/reader/access - what this customer's edition includes (the only reader endpoint a Companion customer may call). */
exports.getAccess = async (req, res) => {
  noStore(res);
  try {
    const access = await resolveAccess(req.authUser.email);
    let upgradeUrl = "/publications/marketing-reclassified";
    try { upgradeUrl = (await getAskSidSettings()).upgradeUrl || upgradeUrl; } catch { /* default */ }
    return res.json({ edition: access.edition, permissions: access.permissions, upgradeUrl });
  } catch (err) {
    if (err.notMigrated) return res.status(503).json({ error: "The online reader is not available yet.", code: "not_available" });
    console.error("[reader] access:", err.message);
    return res.status(503).json({ error: "Access could not be verified right now." });
  }
};

/** GET /api/reader/books */
exports.listBooks = async (req, res) => {
  noStore(res);
  const { data: books, error } = await supabase.from("reader_books").select("id,slug,title,subtitle,description,cover_image_url,position")
    .eq("catalog_key", CATALOG_KEY).eq("status", "published").order("position", { ascending: true });
  if (error) return res.status(500).json({ error: "Could not load the library." });
  const out = [];
  for (const b of books || []) {
    const chapters = await loadPublishedChapters(b.id);
    out.push({ slug: b.slug, title: b.title, subtitle: b.subtitle, description: b.description, coverImageUrl: b.cover_image_url, chapterCount: chapters.length });
  }
  return res.json({ books: out });
};

/** GET /api/reader/books/:slug - book details, published chapter list and the reader's own progress. */
exports.getBook = async (req, res) => {
  noStore(res);
  const book = await loadPublishedBook(req.params.slug);
  if (!book) return res.status(404).json({ error: "Book not found." });
  const chapters = await loadPublishedChapters(book.id);
  const { data: progress } = await supabase.from("reading_progress").select("chapter_id,percent,updated_at").eq("user_id", req.authUser.id).eq("book_id", book.id).maybeSingle();
  const resume = progress ? chapters.find((c) => c.id === progress.chapter_id) : null;
  return res.json({
    book: { slug: book.slug, title: book.title, subtitle: book.subtitle, description: book.description, coverImageUrl: book.cover_image_url },
    chapters: chapters.map((c, i) => ({ slug: c.slug, title: c.title, number: i + 1 })),
    progress: resume ? { chapterSlug: resume.slug, percent: Number(progress.percent), updatedAt: progress.updated_at } : null,
  });
};

/** GET /api/reader/books/:slug/chapters/:chapterSlug */
exports.getChapter = async (req, res) => {
  noStore(res);
  const book = await loadPublishedBook(req.params.slug);
  if (!book || !SLUG_RE.test(String(req.params.chapterSlug || ""))) return res.status(404).json({ error: "Chapter not found." });
  const chapters = await loadPublishedChapters(book.id);
  const idx = chapters.findIndex((c) => c.slug === req.params.chapterSlug);
  if (idx < 0) return res.status(404).json({ error: "Chapter not found." }); // draft / unpublished chapters are indistinguishable from missing ones
  const { data: chapter } = await supabase.from("reader_chapters").select("id,slug,title,content_html,updated_at").eq("id", chapters[idx].id).eq("status", "published").maybeSingle();
  if (!chapter) return res.status(404).json({ error: "Chapter not found." });
  const nav = (c, n) => (c ? { slug: c.slug, title: c.title, number: n } : null);
  return res.json({
    book: { slug: book.slug, title: book.title },
    chapter: { slug: chapter.slug, title: chapter.title, number: idx + 1, total: chapters.length, contentHtml: chapter.content_html, updatedAt: chapter.updated_at },
    previous: nav(chapters[idx - 1], idx), next: nav(chapters[idx + 1], idx + 2),
  });
};

/** PUT /api/reader/books/:slug/progress  { chapterSlug, percent } - the only write, and only to the caller's own row. */
exports.saveProgress = async (req, res) => {
  noStore(res);
  const book = await loadPublishedBook(req.params.slug);
  if (!book) return res.status(404).json({ error: "Book not found." });
  const { chapterSlug, percent } = req.body || {};
  const pct = Number(percent);
  if (!SLUG_RE.test(String(chapterSlug || "")) || !Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: "Invalid progress." });
  const chapters = await loadPublishedChapters(book.id);
  const chapter = chapters.find((c) => c.slug === chapterSlug);
  if (!chapter) return res.status(404).json({ error: "Chapter not found." });
  const { error } = await supabase.from("reading_progress").upsert([{ user_id: req.authUser.id, book_id: book.id, chapter_id: chapter.id, percent: Math.round(pct * 100) / 100, updated_at: new Date().toISOString() }], { onConflict: "user_id,book_id" });
  if (error) return res.status(500).json({ error: "Could not save your place." });
  return res.json({ saved: true });
};
