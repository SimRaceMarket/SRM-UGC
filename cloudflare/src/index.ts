export interface Env {
  GH_TOKEN: string
  GH_OWNER: string
  GH_REPO: string
  HCAPTCHA_SECRET?: string
  SRM_COUNTS: KVNamespace
  SRM_RATELIMIT: KVNamespace
  MAX_FILE_BYTES: string
  ALLOWED_ORIGINS?: string
}

const RAW_BASE = (env: Env) => `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/main/content-database/approved.json`
const API_BASE = (env: Env) => `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}`
const UPLOAD_BASE = (env: Env, relId: number) => `https://uploads.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/releases/${relId}/assets`

function ok(data: any, cors: Headers) { return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...Object.fromEntries(cors) } }) }
function err(status: number, message: string, cors: Headers) { return new Response(JSON.stringify({ ok:false, error:message }), { status, headers: { "content-type": "application/json", ...Object.fromEntries(cors) } }) }

function corsHeaders(env: Env, req: Request): Headers {
  const h = new Headers()
  const origin = req.headers.get("origin") || ""
  const list = (env.ALLOWED_ORIGINS || "*")
  const allowed = list === "*" || list.split(",").some(o => {
    const pat = o.trim().replaceAll(".", "\\.").replace("*", ".*")
    return new RegExp(`^${pat}$`).test(origin)
  })
  h.set("access-control-allow-origin", allowed ? origin : "*")
  h.set("access-control-allow-headers", "authorization,content-type")
  h.set("access-control-allow-methods", "GET,POST,OPTIONS")
  h.set("access-control-max-age", "600")
  return h
}

async function verifyCaptcha(env: Env, token?: string) {
  if (!env.HCAPTCHA_SECRET) return true
  if (!token) return false
  const r = await fetch("https://hcaptcha.com/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: env.HCAPTCHA_SECRET, response: token })
  })
  const j = await r.json()
  return !!j.success
}

async function handleContent(env: Env, cors: Headers) {
  const r = await fetch(RAW_BASE(env), { cf: { cacheTtl: 300, cacheEverything: true } })
  if (!r.ok) return err(502, "Upstream fetch failed", cors)
  const data = await r.json().catch(() => ({} as any))
  const items = Array.isArray(data?.items) ? data.items : []
  const merged = await Promise.all(items.map(async (it: any) => {
    const id = String(it.id ?? it.number ?? "")
    if (!id) return it
    const [likes, downloads] = await Promise.all([
      env.SRM_COUNTS.get(`likes:${id}`),
      env.SRM_COUNTS.get(`downloads:${id}`),
    ])
    return { ...it, likes: Number(likes || it.likes || 0), downloads: Number(downloads || it.downloads || 0) }
  }))
  return ok({ items: merged }, cors)
}

function ip(req: Request) { return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "0.0.0.0" }

async function handleLike(env: Env, req: Request, cors: Headers) {
  const body = await req.json().catch(() => ({}))
  const id = String(body.id || "")
  if (!id) return err(400, "Missing id", cors)
  const key = `like:${id}:${ip(req)}`
  if (await env.SRM_RATELIMIT.get(key)) return err(429, "Rate limited", cors)
  await env.SRM_RATELIMIT.put(key, "1", { expirationTtl: 86400 })
  const cur = Number((await env.SRM_COUNTS.get(`likes:${id}`)) || "0")
  const next = cur + 1
  await env.SRM_COUNTS.put(`likes:${id}`, String(next))
  return ok({ ok:true, id, likes: next }, cors)
}

function sanitize(name: string) { return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0,120) }

async function monthlyRelease(env: Env, token: string) {
  const now = new Date()
  const tag = `ugc-uploads-${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}`
  let r = await fetch(`${API_BASE(env)}/releases/tags/${tag}`, { headers: { authorization: `Bearer ${token}`, "user-agent": "srm-worker" } })
  if (r.ok) return (await r.json()).id
  r = await fetch(`${API_BASE(env)}/releases`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "user-agent": "srm-worker", "content-type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: `UGC Uploads ${tag}`, body: "Automated bucket for community uploads.", draft: false, prerelease: false })
  })
  if (!r.ok) throw new Error("Failed to create release")
  return (await r.json()).id
}

async function createIssue(env: Env, token: string, meta: any, files: Array<{name:string,url:string,size:number}>) {
  const bodyBlock = "```json\n" + JSON.stringify({ ...meta, files }, null, 2) + "\n```"
  const r = await fetch(`${API_BASE(env)}/issues`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "user-agent": "srm-worker", "content-type": "application/json" },
    body: JSON.stringify({
      title: `[${(meta.category || "submission").toString().toUpperCase()}] ${meta.title || "New Community Submission"}`,
      body: `**Category:** ${meta.category || "-"}\n**Game/Sim:** ${meta.game || "-"}\n**Author:** ${meta.author || "-"}\n\n**Description:**\n${meta.description || "-"}\n\nAssets attached via release.\n\n---\n${bodyBlock}\n\n*Created via SRM API.*`,
      labels: ["pending","ugc"]
    })
  })
  if (!r.ok) throw new Error("Issue creation failed")
  const j = await r.json()
  return { number: j.number, url: j.html_url }
}

const ALLOWED_ASSET_HOSTS = new Set([ "github.com", "raw.githubusercontent.com", "github-releases.githubusercontent.com", "objects.githubusercontent.com", "uploads.github.com" ])

async function handleDownload(env: Env, url: URL, cors: Headers) {
  const asset = url.searchParams.get("asset") || ""
  const id = url.searchParams.get("id") || ""
  try { const u = new URL(asset); if (!ALLOWED_ASSET_HOSTS.has(u.hostname)) return err(400, "Disallowed asset host", cors) } catch { return err(400, "Invalid asset url", cors) }
  const upstream = await fetch(asset, { cf: { cacheTtl: 86400, cacheEverything: true } })
  if (!upstream.ok) return new Response("Asset not found", { status: upstream.status, headers: cors })
  if (id) { const cur = Number((await env.SRM_COUNTS.get(`downloads:${id}`)) || "0"); await env.SRM_COUNTS.put(`downloads:${id}`, String(cur+1)) }
  const h = new Headers(upstream.headers); cors.forEach((v,k)=>h.set(k,v))
  return new Response(upstream.body, { status: 200, headers: h })
}

async function handleSubmit(env: Env, req: Request, cors: Headers) {
  const ct = req.headers.get("content-type") || ""
  if (!ct.includes("multipart/form-data")) return err(415, "Use multipart/form-data", cors)
  const form = await req.formData()
  const meta = { title:String(form.get("title")||""), category:String(form.get("category")||""), game:String(form.get("game")||""), description:String(form.get("description")||""), author:String(form.get("author")||"") }
  const captchaToken = String(form.get("captchaToken")||"")
  if (!meta.title || !meta.category || !meta.game || !meta.description || !meta.author) return err(400, "Missing required fields", cors)
  if (!(await verifyCaptcha(env, captchaToken))) return err(400, "Captcha failed", cors)

  const max = Number(env.MAX_FILE_BYTES || "10000000")
  const files: File[] = []; for (const [k,v] of form) if (v instanceof File && k === "files") files.push(v)
  const filesMeta: Array<{name:string,url:string,size:number}> = []
  const token = env.GH_TOKEN
  const relId = await monthlyRelease(env, token)

  for (const f of files) {
    if (f.size > max) return err(413, `File too large: ${f.name} (${f.size} > ${max})`, cors)
    const safe = sanitize(f.name)
    const uploadUrl = `${UPLOAD_BASE(env, relId)}?name=${encodeURIComponent(safe)}`
    const up = await fetch(uploadUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": String(f.size), "user-agent": "srm-worker" }, body: f.stream() })
    if (!up.ok) return err(502, `Asset upload failed`, cors)
    const j = await up.json()
    filesMeta.push({ name: safe, url: j.browser_download_url, size: f.size })
  }

  const issue = await createIssue(env, token, meta, filesMeta)
  return ok({ ok:true, issueUrl: issue.url, submissionId: issue.number }, cors)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const cors = corsHeaders(env, req)
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    try {
      if (url.pathname === "/content"  && req.method === "GET")  return await handleContent(env, cors)
      if (url.pathname === "/like"     && req.method === "POST") return await handleLike(env, req, cors)
      if (url.pathname === "/download" && req.method === "GET")  return await handleDownload(env, url, cors)
      if (url.pathname === "/submit"   && req.method === "POST") return await handleSubmit(env, req, cors)
      return new Response("Not found", { status: 404, headers: cors })
    } catch (e:any) { return err(500, (e as any)?.message || "Server error", cors) }
  }
}
