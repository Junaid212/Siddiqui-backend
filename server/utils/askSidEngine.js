/**
 * askSidEngine.js - answers ONLY from the indexed Marketing Reclassified content.
 *
 * Retrieval: PostgreSQL full-text search over knowledge_chunks (standard book content + the authorised Companion PDF),
 * through one unified function. Answering is EXTRACTIVE: the reply is assembled from sentences that exist in the retrieved
 * chunks, so it cannot contain outside knowledge, web content or invented claims. When the question's meaningful words are
 * not covered by the book, the fixed out-of-scope sentence is returned instead. No memory across sessions: the only context
 * used is the conversation the browser sends with the request, and nothing is stored.
 */
const { rpc } = require("./entitlements");

const OUT_OF_SCOPE = "Ask SID covers the ideas in Marketing Reclassified. Please ask about a concept from the book.";
const ONLINE_UPGRADE_MESSAGE = "Ask SID is available exclusively with the Digital Companion Edition. Upgrade your edition to unlock your AI book companion.";
const MAX_WORDS = 150;
const BODY_BUDGET = 118; // words reserved for the extracted sentences; the lead-in and the ellipsis fit in the rest

const STOP = new Set("a an the and or but if then than of to in on at by for with about as is are was were be been being do does did can could should would will may might must i me my we our you your it its this that these those what which who whom how why when where there here from into over under again further more most some such no nor not only own same so too very just tell explain please give me describe define book chapter mean means".split(" "));
const words = (t) => String(t || "").toLowerCase().match(/[a-z][a-z'-]*/g) || [];
const meaningful = (t) => words(t).filter((w) => w.length > 2 && !STOP.has(w));
const stem = (w) => w.replace(/(ing|ed|es|s|ly)$/, "").slice(0, 6);

function truncateWords(text, max) {
  const w = text.split(/\s+/);
  if (w.length <= max) return text;
  const cut = w.slice(0, max).join(" ");
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return (lastStop > cut.length * 0.5 ? cut.slice(0, lastStop + 1) : cut.replace(/[,;:\s]+$/, "") + "...").trim();
}

/** A one- or two-word follow-up ("and pricing?") is read together with the previous question of THIS conversation only. */
function effectiveQuestion(message, history) {
  const msg = String(message || "").trim().slice(0, 600);
  if (meaningful(msg).length > 2 || !Array.isArray(history)) return msg;
  const prev = [...history].reverse().find((h) => h && h.role === "user" && typeof h.content === "string" && meaningful(h.content).length > 0);
  return prev ? `${prev.content.slice(0, 300)} ${msg}` : msg;
}

async function retrieve(question, sources) {
  const rows = await rpc("search_knowledge", { p_query: question, p_sources: sources, p_limit: 4, p_catalog: "marketing-reclassified" });
  return Array.isArray(rows) ? rows : [];
}
const covered = (r) => r.total > 0 && r.matched >= Math.max(1, Math.ceil(r.total * 0.6));

function compose(question, rows) {
  const best = rows.find(covered);
  if (!best) return null;
  const qs = new Set(meaningful(question).map(stem));
  const sentences = String(best.content).replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const scored = sentences.map((s, i) => ({ s, i, score: meaningful(s).map(stem).filter((w) => qs.has(w)).length }));
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = []; let budget = BODY_BUDGET;
  for (const c of ranked) {
    const n = c.s.split(/\s+/).length;
    if (n > budget && picked.length) continue;
    picked.push(c); budget -= n;
    if (budget <= 8 || picked.length >= 3) break;
  }
  picked.sort((a, b) => a.i - b.i);
  const body = picked.map((c) => c.s).join(" ");
  const lead = [best.concept, best.chapter_ref].filter(Boolean);
  const reference = lead.length ? `${best.concept ? best.concept : "The book"}${best.chapter_ref ? ` (${best.chapter_ref})` : ""}: ` : "";
  const text = truncateWords(reference + body, MAX_WORDS);
  return { text, sources: [{ concept: best.concept || null, chapter: best.chapter_ref || null, origin: best.source }] };
}

/** -> { outOfScope, text, sources } ; includeCompanion = false limits the answer to the standard book content. */
async function answer({ message, history, includeCompanion }) {
  const question = effectiveQuestion(message, history);
  const rows = await retrieve(question, includeCompanion ? ["book", "companion"] : ["book"]);
  const composed = compose(question, rows);
  if (!composed) return { outOfScope: true, text: OUT_OF_SCOPE, sources: [] };
  return { outOfScope: false, text: composed.text, sources: composed.sources };
}

module.exports = { OUT_OF_SCOPE, ONLINE_UPGRADE_MESSAGE, MAX_WORDS, answer, effectiveQuestion, compose, meaningful };
