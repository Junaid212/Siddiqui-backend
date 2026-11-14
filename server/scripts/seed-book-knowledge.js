#!/usr/bin/env node
/**
 * seed-book-knowledge.js - loads the EXISTING approved book knowledge (server/knowledge/marketingReclassified.js) into the
 * knowledge_chunks table as the standard "book" source, so Ask SID's unified retrieval can use it. marketingReclassified.js is
 * NOT changed or removed. Safe to repeat (idempotent by origin_key). Only the book's own statements are loaded (the "perspective"
 * text); diagnostic questions and action plans are not, because Ask SID gives short explanations, not consulting.
 *
 *   node scripts/seed-book-knowledge.js            # dry run: prints what would be inserted
 *   node scripts/seed-book-knowledge.js --apply    # writes (needs the 20261110 migration; production needs owner approval)
 */
const { PRINCIPLE_LIBRARY } = require("../knowledge/marketingReclassified");
const apply = process.argv.includes("--apply");

const rows = PRINCIPLE_LIBRARY.map((n, i) => ({
  catalog_key: "marketing-reclassified",
  source: "book",
  concept: (n.concepts && n.concepts[0]) || n.id,
  chapter_ref: [n.bookReference && n.bookReference.chapter, n.bookReference && n.bookReference.section].filter(Boolean).join(" - ") || null,
  content: String(n.perspective || "").trim(),
  position: i + 1,
  origin_key: `seed:${n.id}:1`,
})).filter((r) => r.content.length > 0);

(async () => {
  console.log(`${rows.length} book knowledge chunk(s) ${apply ? "to write" : "(dry run, nothing written)"}:`);
  for (const r of rows) console.log(` - ${r.origin_key}  [${r.concept}]  ${r.chapter_ref || ""}  (${r.content.split(/\s+/).length} words)`);
  if (!apply) return console.log("Re-run with --apply to write them.");
  const supabase = require("../config/supabaseClient");
  const { error } = await supabase.from("knowledge_chunks").upsert(rows, { onConflict: "origin_key" });
  if (error) { console.error("FAILED:", error.message); process.exit(1); }
  console.log("Done.");
})();
