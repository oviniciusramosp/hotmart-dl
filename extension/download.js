// Download in-browser (roda no painel; host_permissions + regra de Referer = sem CORS).
// Faz vídeo (.ts, decifra AES-128), descrição (.html com imagens) e materiais (anexos),
// com nomeação igual ao CLI. Saída em .ts (toca em VLC/IINA); mux.js->mp4 foi
// testado mas os arquivos não tocavam, então ficamos no .ts.
// Módulo ES: escopo próprio (não polui o global), exporta a API no final.
const GW = "https://api-club-course-consumption-gateway-ga.cb.hotmart.com";
const ATT = "https://api-club.cb.hotmart.com/rest/v3/attachment/{fmid}/download";

const pad2 = (n) => String(n).padStart(2, "0");
function sanitize(s) {
  return String(s || "").replace(/[\\/:*?"<>|\n\r\t]/g, "-").replace(/\s+/g, " ").trim().replace(/^[.\-\s]+|[.\-\s]+$/g, "").slice(0, 120) || "x";
}
function safeFile(name) {
  const i = String(name || "").lastIndexOf(".");
  const stem = i > 0 ? name.slice(0, i) : name, ext = i > 0 ? name.slice(i).replace(/[\\/:*?"<>|]/g, "") : "";
  return (sanitize(stem) + ext).slice(0, 140) || "arquivo";
}
function render(tpl, m, a, module, lesson) {
  return String(tpl).replace(/\{mm\}/g, pad2(m)).replace(/\{m\}/g, m)
    .replace(/\{aa\}/g, pad2(a)).replace(/\{a\}/g, a)
    .replace(/\{module\}/g, sanitize(module)).replace(/\{lesson\}/g, sanitize(lesson));
}
function hexToBytes(h) { const a = new Uint8Array(h.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
function seqIV(seq) { const iv = new Uint8Array(16); for (let i = 15; i >= 0 && seq > 0; i--) { iv[i] = seq & 0xff; seq = Math.floor(seq / 256); } return iv; }
const auth = (D) => ({ Authorization: "Bearer " + D.token, "x-product-id": String(D.productId), "x-app-name": D.appName, Accept: "application/json, text/plain, */*" });

function downloadWithName(url, relPath) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "hmFilename", url, filename: relPath }, () => {
      chrome.downloads.download({ url, saveAs: false }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(id);
      });
    });
  });
}
async function saveBlob(blob, relPath) {
  const url = URL.createObjectURL(blob);
  try { await downloadWithName(url, relPath); } finally { setTimeout(() => URL.revokeObjectURL(url), 180000); }
}

async function fetchLessonJson(hash, D) {
  return fetch(GW + "/v2/web/lessons/" + hash, { headers: auth(D) }).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
}
function mediaEmbed(lj) { const m = (lj.medias || []).find((x) => x.type === "VIDEO" && x.url); return m ? m.url : null; }

async function embedToM3u8(embedUrl, prefer) {
  const page = await fetch(embedUrl).then((r) => r.text());  // Referer injetado pela regra
  const m = page.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) throw new Error("player sem __NEXT_DATA__");
  const d = JSON.parse(m[1]);
  let a = (((d.props || {}).pageProps || {}).applicationData || {}).mediaAssets || [];
  a = a.filter((x) => (x.url || "").includes(".m3u8"));
  if (!a.length) throw new Error("sem m3u8 (DRM?)");
  a.sort((x, y) => (x.height || 0) - (y.height || 0));
  return (prefer === "low" ? a[0] : a[a.length - 1]).url;
}

// Baixa os segmentos HLS (decifra AES-128) e devolve os TS já decifrados, EM ORDEM.
// Pool de POOL fetches simultâneos: satura a rede sem multiplicar memória (1 vídeo por vez).
// Se UM segmento falhar, o Promise.all rejeita e o vídeo inteiro erra (nunca salva parcial).
async function downloadHlsParts(m3u8url, onProgress, prefer) {
  let pl = await fetch(m3u8url).then((r) => r.text());
  if (pl.includes("#EXT-X-STREAM-INF")) {  // master -> variante (mais alta, ou mais baixa se prefer=low)
    const lines = pl.split("\n"), vs = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const h = parseInt((lines[i].match(/RESOLUTION=\d+x(\d+)/) || [])[1] || "0", 10);
      const u = (lines[i + 1] || "").trim();
      if (u && !u.startsWith("#")) vs.push({ h, url: new URL(u, m3u8url).href });
    }
    if (vs.length) { vs.sort((x, y) => y.h - x.h); m3u8url = (prefer === "low" ? vs[vs.length - 1] : vs[0]).url; pl = await fetch(m3u8url).then((r) => r.text()); }
  }
  let key = null, ivFixed = null;
  const km = pl.match(/#EXT-X-KEY:[^\n]*URI="([^"]+)"/);
  if (km) {
    const kb = await fetch(new URL(km[1], m3u8url).href).then((r) => r.arrayBuffer());
    key = await crypto.subtle.importKey("raw", kb, { name: "AES-CBC" }, false, ["decrypt"]);
    const ivm = pl.match(/IV=0x([0-9a-fA-F]+)/); if (ivm) ivFixed = hexToBytes(ivm[1]);
  }
  const seq0 = parseInt((pl.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || "0", 10);
  const segs = pl.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => new URL(l, m3u8url).href);
  return fetchSegments(segs, key, ivFixed, seq0, onProgress);
}

// pool de 5 fetches simultâneos (satura a rede sem multiplicar memória); ordem preservada
async function fetchSegments(segs, key, ivFixed, seq0, onProgress) {
  const parts = new Array(segs.length);
  let done = 0, next = 0;
  const POOL = Math.min(5, segs.length || 1);  // ponytail: 5 fixo; subir se a rede aguentar e não tomar 429
  async function worker() {
    while (next < segs.length) {
      const i = next++;
      const enc = await fetch(segs[i]).then((r) => r.arrayBuffer());
      parts[i] = key ? new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivFixed || seqIV(seq0 + i) }, key, enc)) : new Uint8Array(enc);
      done++;
      if (onProgress) onProgress(done / segs.length);
    }
  }
  await Promise.all(Array.from({ length: POOL }, worker));
  return parts;
}

// Baixa a partir de segmentos JÁ resolvidos (o adaptador defiverso resolve o m3u8
// dentro da página, com os cookies de login; aqui só buscamos os .ts assinados).
async function downloadResolved(resolved, onProgress) {
  let key = null, ivFixed = null;
  if (resolved.keyUrl) {
    const kb = await fetch(resolved.keyUrl).then((r) => r.arrayBuffer());
    key = await crypto.subtle.importKey("raw", kb, { name: "AES-CBC" }, false, ["decrypt"]);
    if (resolved.ivHex) ivFixed = hexToBytes(resolved.ivHex);
  }
  return fetchSegments(resolved.segs || [], key, ivFixed, resolved.seq0 || 0, onProgress);
}
async function saveTs(parts, name) { await saveBlob(new Blob(parts, { type: "video/mp2t" }), safeFile(name) + ".ts"); }

function blobToDataUri(blob) { return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); }); }
async function saveDescription(contentHtml, title, relPath) {
  const imgs = [...contentHtml.matchAll(/src\s*=\s*"([^"]+)"/gi)].map((m) => m[1]).filter((u) => !u.startsWith("data:"));
  let body = contentHtml;
  for (const src of [...new Set(imgs)]) {
    try { const dataUri = await fetch(src).then((r) => r.blob()).then(blobToDataUri); if (dataUri) body = body.split('"' + src + '"').join('"' + dataUri + '"'); } catch (e) {}
  }
  const t = (title || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const doc = `<!doctype html><html lang=pt-BR><head><meta charset=utf-8><title>${t}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:820px;margin:2rem auto;padding:0 1.2rem;line-height:1.6;color:#1a1a1a}img{max-width:100%;height:auto;border-radius:8px}h1{font-size:1.5rem}</style></head><body><h1>${t}</h1>${body}</body></html>`;
  await saveBlob(new Blob([doc], { type: "text/html" }), relPath);
}

async function fetchAttachments(hash, D) {
  try { const j = await fetch(GW + "/v1/pages/" + hash + "/complementary-content", { headers: auth(D) }).then((r) => r.json()); return j.attachments || []; } catch (e) { return []; }
}
async function attachmentUrl(fmid, D) { const j = await fetch(ATT.replace("{fmid}", fmid), { headers: auth(D) }).then((r) => r.json()); return j.directDownloadUrl; }

// ---- orquestração ----
async function downloadOne(job, D, opts, onProg) {
  const tag = "M" + pad2(job.m) + "A" + pad2(job.a);
  const dir = opts.folderTpl && opts.folderTpl.trim() ? render(opts.folderTpl, job.m, job.a, job.mname, job.name) + "/" : "";
  const base = dir + render(opts.fileTpl, job.m, job.a, job.mname, job.name);
  if (job.locked) { onProg("bloqueada", null); return { locked: 1 }; }
  const out = { video: 0, desc: 0, att: 0, fail: 0 };
  let lj = null;
  if (job.hasVideo || opts.doDesc) { try { lj = await fetchLessonJson(job.hash, D); } catch (e) { onProg("erro", null); return { fail: 1 }; } }
  if (job.hasVideo) {
    try {
      onProg("resolvendo", null);
      const embed = mediaEmbed(lj);
      if (embed) {
        const m3u8 = await embedToM3u8(embed, opts.prefer);
        const parts = await downloadHlsParts(m3u8, (p) => onProg("baixando", p));
        await saveBlob(new Blob(parts, { type: "video/mp2t" }), base + ".ts");
        out.video = 1;
      }
    } catch (e) { onProg("erro", null); out.fail = 1; }
  }
  if (opts.doDesc && lj) {
    const content = (lj.content || "").trim();
    if (content) { try { onProg("descricao", null); await saveDescription(content, job.name, base + ".html"); out.desc = 1; } catch (e) {} }
  }
  if (opts.doAttach) {
    onProg("materiais", null);
    for (const a of await fetchAttachments(job.hash, D)) {
      try { const u = await attachmentUrl(a.fileMembershipId, D); await downloadWithName(u, dir + tag + " - " + safeFile(a.fileName)); out.att++; } catch (e) {}
    }
  }
  onProg("ok", 1);
  return out;
}

async function downloadCourse(jobs, D, opts, cb) {
  const total = jobs.length; let done = 0;
  const sum = { video: 0, desc: 0, att: 0, locked: 0, fail: 0 };
  for (const job of jobs) {
    if (cb.stopped && cb.stopped()) break;
    let r;
    try { r = await downloadOne(job, D, opts, (status, pct) => cb.onLesson(job.m, job.a, status, pct)); }
    catch (e) { r = { fail: 1 }; cb.onLesson(job.m, job.a, "erro", null); }
    for (const k in r) sum[k] = (sum[k] || 0) + (r[k] || 0);
    done++;
    cb.onOverall(done, total);
  }
  cb.onDone(sum);
}

// scan leve: descobre se a aula tem descrição e quantos materiais (pros ícones)
async function scanLesson(hash, D) {
  let hasDesc = false, att = 0;
  try { const lj = await fetchLessonJson(hash, D); hasDesc = !!((lj.content || "").trim()); } catch (e) {}
  try { att = (await fetchAttachments(hash, D)).length; } catch (e) {}
  return { hasDesc, att };
}

// Download genérico (modo multi-site): recebe um stream detectado e salva.
// hls -> mesmo pipeline (segmentos paralelos, AES) e sai .ts; file -> baixa direto.
async function downloadGeneric(stream, name, prefer, onProg) {
  if (stream.kind === "hls") {
    const parts = await downloadHlsParts(stream.url, (p) => onProg && onProg("baixando", p), prefer);
    await saveBlob(new Blob(parts, { type: "video/mp2t" }), safeFile(name) + ".ts");
  } else if (stream.kind === "file") {
    onProg && onProg("baixando", null);
    const blob = await fetch(stream.url).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); });
    const ext = (stream.url.split("?")[0].match(/\.(mp4|webm)$/i) || [".mp4"])[0].toLowerCase();
    await saveBlob(blob, safeFile(name) + ext);
  } else {
    throw new Error("formato não suportado: " + stream.kind);  // dash (.mpd) ainda não
  }
  onProg && onProg("ok", 1);
}

export { downloadCourse, scanLesson, downloadGeneric, downloadResolved, saveTs, saveBlob, saveDescription };
