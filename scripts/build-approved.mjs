// Enhanced version of your build-approved.mjs
import { Octokit } from "@octokit/rest"
import fs from "fs"
import path from "path"

const [owner, repo] = (process.env.GITHUB_REPOSITORY || "SimRaceMarket/SRM-UGC").split("/")
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

async function* listApprovedIssues() {
  let page = 1
  while (true) {
    const res = await octokit.issues.listForRepo({
      owner, repo, labels: "approved,ugc", state: "all", per_page: 100, page
    })
    if (res.data.length === 0) break
    for (const issue of res.data) yield issue
    page++
  }
}

function parseJsonBlock(body) {
  if (!body) return null
  const m = body.match(/```json\s*([\s\S]*?)\s*```/)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

const items = []
for await (const issue of listApprovedIssues()) {
  const meta = parseJsonBlock(issue.body) || {}
  const id = issue.number
  const date = issue.created_at?.slice(0,10) || new Date().toISOString().slice(0,10)
  const title = meta.title || issue.title?.replace(/^\[[^\]]+\]\s*/, "") || `Item #${id}`
  
  // Enhanced data structure
  items.push({
    id,
    title,
    category: meta.category || "submission",
    game: meta.game || "other",
    description: meta.description || "",
    longDescription: meta.longDescription || meta.description || "",
    author: meta.author || issue.user?.login || "unknown",
    date,
    lastUpdated: issue.updated_at?.slice(0,10) || date,
    downloads: 0,
    likes: 0,
    rating: meta.rating || 0,
    totalRatings: meta.totalRatings || 0,
    version: meta.version || "1.0",
    fileSize: calculateTotalSize(meta.files || []),
    compatibility: meta.compatibility || [],
    requirements: meta.requirements || [],
    installation: meta.installation || [],
    tags: meta.tags || [],
    files: (meta.files || []).map(f => ({
      name: f.name,
      url: f.url,
      size: f.size || "Unknown",
      type: f.type || getFileType(f.name),
      description: f.description || ""
    })),
    screenshots: meta.screenshots || [],
    changelog: meta.changelog || []
  })
}

function calculateTotalSize(files) {
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0)
  if (total === 0) return "Unknown"
  return total > 1024 * 1024 
    ? `${(total / (1024 * 1024)).toFixed(1)} MB`
    : `${(total / 1024).toFixed(1)} KB`
}

function getFileType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase()
  const types = {
    json: "Setup File",
    zip: "Archive",
    pdf: "Documentation",
    stl: "3D Model",
    txt: "Text File",
    ini: "Config File"
  }
  return types[ext] || "File"
}

const out = { items }
const outPath = path.join("content-database", "approved.json")
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(out, null, 2))
console.log(`Wrote ${items.length} items to ${outPath}`)
