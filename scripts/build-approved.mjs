// Direct replacement build script for approved.json
// Requires: @octokit/rest
import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";

const [owner, repo] = (process.env.GITHUB_REPOSITORY || "SimRaceMarket/SRM-UGC").split("/");
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  console.error("Missing GITHUB_TOKEN (or GH_TOKEN) in environment.");
  process.exit(1);
}
const octokit = new Octokit({ auth: token });

async function* listApprovedIssues() {
  let page = 1;
  while (true) {
    const res = await octokit.issues.listForRepo({
      owner,
      repo,
      labels: "approved,ugc", // BOTH labels
      state: "all",
      per_page: 100,
      page
    });
    if (res.data.length === 0) break;
    for (const issue of res.data) {
      if (!issue.pull_request) yield issue; // ignore PRs
    }
    page++;
  }
}

function parseJsonBlock(body) {
  if (!body) return null;
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

const items = [];
for await (const issue of listApprovedIssues()) {
  const meta = parseJsonBlock(issue.body) || {};
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

  items.push({
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
    compatibility: Array.isArray(meta.compatibility) ? meta.compatibility : (meta.compatibility ? [String(meta.compatibility)] : []),
    requirements: Array.isArray(meta.requirements) ? meta.requirements : [],
    installation: Array.isArray(meta.installation) ? meta.installation : [],
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    mediaUrls: Array.isArray(meta.mediaUrls) ? meta.mediaUrls : [],
    license: meta.license || "",
    notes: meta.notes || "",
    files,
    screenshots: Array.isArray(meta.screenshots) ? meta.screenshots : [],
    changelog: Array.isArray(meta.changelog) ? meta.changelog : []
  });
}

const out = { items };
const outPath = path.join("content-database", "approved.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
console.log(`Wrote ${items.length} items to ${outPath}`);
