// Quest attachments, UI side: the same allow-list and limits Rust enforces (Rust stays the authority; this only lets the form
// explain a refusal immediately instead of after the upload).

export type AttachKind = "image" | "text" | "pdf";

export const LIMITS = {
  files: 8,
  image: 4 * 1024 * 1024,
  pdf: 10 * 1024 * 1024,
  text: 1024 * 1024,
  total: 20 * 1024 * 1024,
} as const;

const EXT: Record<string, AttachKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  txt: "text",
  log: "text",
  md: "text",
  markdown: "text",
  pdf: "pdf",
};

export const ACCEPT = ".png,.jpg,.jpeg,.webp,.gif,.txt,.log,.pdf,.md,.markdown";
export const SUPPORTED_TEXT = "PNG, JPG, WEBP, GIF, TXT, LOG, PDF and Markdown";

export function kindOf(name: string): AttachKind | null {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return EXT[ext] ?? null;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface Candidate {
  name: string;
  size: number;
}
export interface Verdict {
  accepted: number[];
  rejected: Array<{ name: string; reason: string }>;
}

/** Decides which of the newly chosen files can join the ones already on the quest, and says why the others cannot. */
export function checkFiles(existing: Candidate[], incoming: Candidate[]): Verdict {
  const accepted: number[] = [];
  const rejected: Verdict["rejected"] = [];
  let count = existing.length;
  let total = existing.reduce((n, f) => n + f.size, 0);
  incoming.forEach((f, i) => {
    const kind = kindOf(f.name);
    const limit = kind ? LIMITS[kind] : 0;
    if (!kind) rejected.push({ name: f.name, reason: `not a supported file type (supported: ${SUPPORTED_TEXT})` });
    else if (f.size === 0) rejected.push({ name: f.name, reason: "the file is empty" });
    else if (f.size > limit) rejected.push({ name: f.name, reason: `too large (${formatSize(f.size)}; the limit for this type is ${formatSize(limit)})` });
    else if (count >= LIMITS.files) rejected.push({ name: f.name, reason: `a quest can have at most ${LIMITS.files} attachments` });
    else if (total + f.size > LIMITS.total) rejected.push({ name: f.name, reason: `the attachments of one quest are limited to ${formatSize(LIMITS.total)} in total` });
    else {
      accepted.push(i);
      count++;
      total += f.size;
    }
  });
  return { accepted, rejected };
}

/** File bytes as base64 (without the data-URL prefix), for the Rust command. */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("The file could not be read."));
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.readAsDataURL(file);
  });
}
