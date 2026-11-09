// Library search over the already-discovered document metadata (title, file name, relative path).
// It never touches the disk: the shelves are listed once by Rust and filtered here on every keystroke.
import type { LibraryMeta } from "./types.ts";

const norm = (s: string): string => s.toLowerCase().replaceAll("\\", "/");

/** Lower-cased search text of a document: title, file name and relative path. */
export function haystack(d: LibraryMeta): string {
  const name = norm(d.path).split("/").pop() ?? d.path;
  return norm(`${d.title}\n${name}\n${d.path}`);
}

/**
 * Case-insensitive partial matching. Every whitespace-separated term must appear somewhere in the title, file name
 * or path, so "arch sys" finds docs/ARCHITECTURE.md and docs/system-design.md. Order of the shelf is preserved.
 */
export function filterDocs(docs: LibraryMeta[], query: string): LibraryMeta[] {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return docs;
  return docs.filter((d) => {
    const h = haystack(d);
    return terms.every((t) => h.includes(t));
  });
}

export function matchSummary(shown: number, total: number, query: string): string {
  if (!query.trim()) return `${total} ${total === 1 ? "book" : "books"} on the shelves`;
  return `${shown} of ${total} ${total === 1 ? "book" : "books"} match`;
}
