// One-shot: convert every HTML file in docs/ to Markdown under docs/markdown/.
// Copies existing .md and .txt files through untouched (renames .txt → .md).
//
// Run from repo root:
//   npx -y -p turndown -p turndown-plugin-gfm node docs/.convert-to-md.mjs

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = here;
const outDir = join(docsDir, "markdown");
mkdirSync(outDir, { recursive: true });

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "_",
  bulletListMarker: "-",
  hr: "---",
  fence: "```",
});
td.use(gfm);
// Strip the chrome that doesn't add value to a markdown reader.
td.remove(["style", "script"]);

// Soften some patterns that turndown handles awkwardly out of the box.
td.addRule("preserveDetails", {
  filter: ["details", "summary"],
  replacement: (content, node) => {
    if (node.nodeName === "SUMMARY") return `**${content.trim()}**\n\n`;
    return `\n${content}\n`;
  },
});

const entries = readdirSync(docsDir).filter(f => !f.startsWith(".") && f !== "markdown");
const summary = [];

for (const f of entries) {
  const ext = extname(f).toLowerCase();
  const inPath = join(docsDir, f);
  const stem = basename(f, ext);

  try {
    if (ext === ".html") {
      const html = readFileSync(inPath, "utf8");
      let md = td.turndown(html);
      // Tidy: collapse 3+ blank lines, trim trailing whitespace per line.
      md = md.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
      const out = join(outDir, `${stem}.md`);
      writeFileSync(out, `# ${stem}\n\n_Converted from \`${f}\`._\n\n---\n\n${md}\n`);
      summary.push({ file: f, action: "converted", out: `markdown/${stem}.md`, bytes: md.length });
    } else if (ext === ".md") {
      const out = join(outDir, f);
      copyFileSync(inPath, out);
      summary.push({ file: f, action: "copied", out: `markdown/${f}` });
    } else if (ext === ".txt") {
      const txt = readFileSync(inPath, "utf8");
      const out = join(outDir, `${stem}.md`);
      writeFileSync(out, `# ${stem}\n\n_Converted from \`${f}\`._\n\n---\n\n\`\`\`\n${txt}\n\`\`\`\n`);
      summary.push({ file: f, action: "txt→md", out: `markdown/${stem}.md` });
    } else {
      summary.push({ file: f, action: "skipped (non-doc)" });
    }
  } catch (e) {
    summary.push({ file: f, action: "ERROR", reason: e?.message ?? String(e) });
  }
}

console.log("\n──────── conversion summary ────────");
for (const s of summary) {
  if (s.action === "ERROR") {
    console.log(`✗ ${s.file}  →  ${s.reason}`);
  } else if (s.action === "skipped (non-doc)") {
    console.log(`⏭  ${s.file}  (skipped)`);
  } else {
    console.log(`✓ ${s.file}  →  ${s.out}  [${s.action}]`);
  }
}
console.log(`\nDone. ${summary.filter(s => s.action !== "ERROR" && s.action !== "skipped (non-doc)").length} files written to docs/markdown/`);
