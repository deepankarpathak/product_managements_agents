/**
 * Smart Context Engine (RAG) – retrieval for POST /api/generate and /api/claude.
 *
 * Source: the NPCI UPI TSD V1.0, UPI Consolidated Circular V1.0 and Error and Response Codes V2.9
 * Markdown in docs/npci-tsd, docs/npci-circular and docs/npci-error-codes, via the keyword index in
 * ../specSearch.js (codes named in the prompt come first as definition rows). Prompts that don't
 * mention UPI / NPCI vocabulary or a known code get no chunks. Set SPEC_RAG=false to turn it off (callers can also pass
 * skipRag: true per request).
 *
 * Embedding-based search over other docs (previous PRDs, merchant docs) can be layered on later —
 * see docs/SMART_CONTEXT_ENGINE.md.
 *
 * @param {string} query - User requirement or requirement + feedback text
 * @param {number} [k=4] - Max number of chunks to return
 * @returns {Promise<string[]>} - Relevant cited excerpts (empty when nothing relevant)
 */
import { retrieveSpecContext } from "../specSearch.js";

export async function retrieve(query, k = 4) {
  if (!query || typeof query !== "string") return [];
  if (String(process.env.SPEC_RAG || "").toLowerCase() === "false") return [];
  try {
    return retrieveSpecContext(query, { k }).chunks;
  } catch (err) {
    console.warn("[RAG] retrieve error:", err.message);
    return [];
  }
}
