/**
 * One-off generator for `src/lib/password/denylist.ts` (ADR 0016: the denylist is committed data, not a
 * runtime dependency, and no request path ever calls a breached-password API).
 *
 *   npm run denylist:build [-- --ref <git-sha-or-branch>] [--max <entries>]
 *
 * Source: SecLists (MIT) `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`, which is ordered
 * by popularity. Entries shorter than the 10-character minimum can never be submitted (the DTO rejects them
 * first), so only 10..128-character entries are kept; the most popular `--max` of those are written out.
 */
import fs from "node:fs";
import path from "node:path";

const REPO = "danielmiessler/SecLists";
const FILE_PATH = "Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt";
const LICENCE = "MIT";
const OUTPUT = path.resolve("src/lib/password/denylist.ts");
const MIN_LENGTH = 10;
const MAX_LENGTH = 128;

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

async function resolveSha(ref: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits/${ref}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    return ref;
  }
  const body = (await response.json()) as { sha?: unknown };
  return typeof body.sha === "string" ? body.sha : ref;
}

async function main(): Promise<void> {
  const ref = argument("ref", "master");
  const max = Number(argument("max", "5000"));
  const sha = await resolveSha(ref);
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${FILE_PATH}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download_failed_${String(response.status)}`);
  }
  const text = await response.text();

  const seen = new Set<string>();
  const entries: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const password = line.trim().toLowerCase();
    if (password.length < MIN_LENGTH || password.length > MAX_LENGTH || seen.has(password)) {
      continue;
    }
    seen.add(password);
    entries.push(password);
    if (entries.length >= max) {
      break;
    }
  }

  const sorted = [...entries].sort();
  const literal = sorted.map((entry) => `  ${JSON.stringify(entry)},`).join("\n");

  const contents = `/**
 * GENERATED FILE — do not edit by hand. Regenerate with \`npm run denylist:build\`.
 *
 * Source:  https://github.com/${REPO}/blob/${sha}/${FILE_PATH}
 * Commit:  ${sha}
 * Licence: ${LICENCE} (SecLists)
 * Filter:  lower-cased, ${String(MIN_LENGTH)}..${String(MAX_LENGTH)} characters, de-duplicated, the
 *          ${String(sorted.length)} most-used of those, sorted.
 *
 * Shorter breached passwords are not listed: the DTO rejects anything under ${String(MIN_LENGTH)} characters
 * first (CLAUDE.md -> Security rules).
 */
const ENTRIES: readonly string[] = [
${literal}
];

/** O(1) lookups; loaded once at module load. Compare lower-cased. */
export const PASSWORD_DENYLIST: ReadonlySet<string> = new Set(ENTRIES);
`;

  fs.writeFileSync(OUTPUT, contents, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      message: "denylist_written",
      file: path.relative(process.cwd(), OUTPUT),
      entries: sorted.length,
      bytes: Buffer.byteLength(contents, "utf8"),
      commit: sha,
    })}\n`,
  );
}

void main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
