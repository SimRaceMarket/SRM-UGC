/**
 * Build script to generate content-database/approved.json
 * from Issues labeled "approved" that include a ```json ... ``` block.
 *
 * ENV supported:
 *  - GITHUB_TOKEN or GH_TOKEN (required)
 *  - GITHUB_REPOSITORY ("owner/repo") OR GH_OWNER + GH_REPO (required)
 *  - OUT_FILE (optional, default: content-database/approved.json)
 */

import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";

// -------- env & setup --------
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  console.error("❌ Missing GITHUB_TOKEN (or GH_TOKEN).");
  process.exit(1);
}

let owner = process.env.GH_OWNER;
let repo = process.env.GH_REPO;
if (!owner || !repo) {
  const repoStr = process.env.GITHUB_REPOSITORY;
  if (!repoStr || !repoStr.includes("/")) {
    console.error("❌ Provide GITHUB_REPOSITORY ('owner/repo') or GH_OWNER + GH_REPO.");
    process.exit(1);
  }
  [owner, repo] = repoStr.split("/");
}

const OUT_FILE = process.env.OUT_FILE || "content-database/approved.json";

const octokit = new Octokit({ auth: token });

// -------- helpers --------
function hasLabel(issue, want) {
  if (!issue?.labels) return false;
  const target = String(want).toLowerCase();
  return issue.labels.some((l) => (typeof l === "string" ? l : l.name)?.toLowerCase() === target);
}

function parseJsonBlock(body = "") {
  if (!body) return null;
  // look for ```json ... ```
  const m = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function getFileType(filename = "") {
  const ext = filename.split(".").pop()?.toLowerCase();
  const types = {
    json: "Setup File",
    zip: "Archive",
    rar: "Archive",
    "7z": "Archive",
    pdf: "Documentation",
    txt: "Text File",
    md: "Documentation",
    stl: "3D Model",
    obj: "3D Model",
    ini: "Config File",
    cfg: "Config File",
    xml: "Config File",
    jpg: "Image",
    jpeg: "Image",
    png: "Image",
    gif: "Image",
    mp4: "Video",
    avi: "Video",
    mov: "Video"
  };
  return types[ext || ""] || "File";
}

function calculateTotalSize(files = []) {
  const total = files.reduce((sum, f) => sum + (Number(f?.size) || 0), 0);
  if (!total) return "Unknown";
  return total >= 1024 * 1024
    ? `${(total / (1024 * 1024)).toFixed(1)} MB`
    : `${(total / 1024).toFixed(1)} KB`;
}

function coerceItem(issue, meta = {}) {
  const id = issue.number;
  const created = issue.created_at || new Date().toISOString();
  const date = created.slice(0, 10);
  const lastUpdated = (issue.updated_at || created).slice(0, 10);
  const strippedTitle = (issue.title || "").replace(/^\[[^\]]+\]\s*/, "");
  const title = meta.title || strippedTitle || `Item #${id}`;

  const files = Array.isArray(meta.files)
    ? meta.files.map((f) => ({
        name: f?.name || "",
        url: f?.url || "",
        size: Number(f?.size) || 0,
        type: f?.type || getFileType(f?.name),
        description: f?.description || ""
      }))
    : [];

  return {
    id,
    title,
    category: meta.category || "submission",
    game: meta.game || "other",
    description: meta.description || "",
    longDescription: meta.longDescription || meta.description || "",
    author: meta.author || (issue.user?.login || "unknown"),
    date,
    lastUpdated,
    downloads: 0,
    likes: 0,
    rating: Number(meta.rating || 0),
    totalRatings: Number(meta.totalRatings || 0),
    version: meta.version || "",
    fileSize: calculateTotalSize(files),
    compatibility: Array.isArray(meta.compatibility)
      ? meta.compatibility
      : meta.compatibility
      ? [String(meta.compatibility)]
      : [],
    requirements: Array.isArray(meta.requirements) ? meta.requirements : [],
    installation: Array.isArray(meta.installation) ? meta.installation : [],
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    mediaUrls: Array.isArray(meta.mediaUrls) ? meta.mediaUrls : [],
    license: meta.license || "",
    notes: meta.notes || "",
    files,
    screenshots: Array.isArray(meta.screenshots) ? meta.screenshots : [],
    changelog: Array.isArray(meta.changelog) ? meta.changelog : []
  };
}

// -------- fetch issues (client-side filter by label) --------
async function fetchAllIssues() {
  const perPage = 100;
  let page = 1;
  const issues = [];

  while (true) {
    const res = await octokit.issues.listForRepo({
      owner,
      repo,
      state: "all",
      per_page: perPage,
      page
      // NOTE: we do NOT pass "labels" here to avoid "match all labels" pitfalls
    });
    if (!res.data.length) break;
    for (const it of res.data) {
      if (!it.pull_request) issues.push(it); // ignore PRs
    }
    if (res.data.length < perPage) break;
    page++;
  }
  return issues;
}

async function main() {
  const all = await fetchAllIssues();

  // Filter to label "approved" (case-insensitive). We do NOT require "ugc" here.
  const approved = all.filter((it) => hasLabel(it, "approved"));

  const items = [];
  for (const issue of approved) {
    const meta = parseJsonBlock(issue.body) || {};
    const item = coerceItem(issue, meta);

    // Ensure minimal required fields
    if (!item.title || !item.category || !item.game) {
      console.warn(`⚠️ Skipping #${issue.number}: missing required fields in JSON block`);
      continue;
    }
    items.push(item);
  }

  // Ensure output dir
  const outPath = path.join("content-database", "approved.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Write file
  const payload = { items };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");

  console.log(`✅ Wrote ${items.length} item(s) to ${outPath}`);
}

main().catch((e) => {
  console.error("❌ build-approved failed:", e);
  process.exit(1);
});
