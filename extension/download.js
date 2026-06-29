// Download in-browser (roda no painel; host_permissions + regra de Referer = sem CORS).
// Faz vídeo (.ts, decifra AES-128), descrição (.html com imagens) e materiais (anexos),
// com nomeação igual ao CLI. Formato .ts por ora; mp4 via mux.js é o próximo passo.
// IIFE: isola os helpers (pad2, render, ...) pra não colidir com o popup.js no escopo global.
(function () {
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

async function downloadHlsBlob(m3u8url, onProgress) {
  let pl = await fetch(m3u8url).then((r) => r.text());
  if (pl.includes("#EXT-X-STREAM-INF")) {  // master -> melhor variante
    const lines = pl.split("\n"), vs = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const h = parseInt((lines[i].match(/RESOLUTION=\d+x(\d+)/) || [])[1] || "0", 10);
      const u = (lines[i + 1] || "").trim();
      if (u && !u.startsWith("#")) vs.push({ h, url: new URL(u, m3u8url).href });
    }
    if (vs.length) { vs.sort((x, y) => y.h - x.h); m3u8url = vs[0].url; pl = await fetch(m3u8url).then((r) => r.text()); }
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
  const parts = [];
  for (let i = 0; i < segs.length; i++) {
    const enc = await fetch(segs[i]).then((r) => r.arrayBuffer());
    parts.push(key ? new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivFixed || seqIV(seq0 + i) }, key, enc)) : new Uint8Array(enc));
    if (onProgress) onProgress((i + 1) / segs.length);
  }
  return new Blob(parts, { type: "video/mp2t" });
}

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
  if (job.locked) { onProg(tag, "bloqueada"); return { locked: 1 }; }
  const out = { video: 0, desc: 0, att: 0, fail: 0 };
  let lj = null;
  if (job.hasVideo || opts.doDesc) { try { lj = await fetchLessonJson(job.hash, D); } catch (e) { onProg(tag, "erro: " + e.message); return { fail: 1 }; } }
  if (job.hasVideo) {
    try {
      onProg(tag, "resolvendo…");
      const embed = mediaEmbed(lj);
      if (embed) {
        const m3u8 = await embedToM3u8(embed, opts.prefer);
        const blob = await downloadHlsBlob(m3u8, (p) => onProg(tag, "baixando vídeo " + Math.round(p * 100) + "%"));
        await saveBlob(blob, base + ".ts");
        out.video = 1;
      }
    } catch (e) { onProg(tag, "vídeo erro: " + e.message); out.fail = 1; }
  }
  if (opts.doDesc && lj) {
    const content = (lj.content || "").trim();
    if (content) { try { onProg(tag, "descrição…"); await saveDescription(content, job.name, base + ".html"); out.desc = 1; } catch (e) {} }
  }
  if (opts.doAttach) {
    onProg(tag, "materiais…");
    for (const a of await fetchAttachments(job.hash, D)) {
      try { const u = await attachmentUrl(a.fileMembershipId, D); await downloadWithName(u, dir + tag + " - " + safeFile(a.fileName)); out.att++; } catch (e) {}
    }
  }
  onProg(tag, "ok");
  return out;
}

async function downloadCourse(jobs, D, opts, cb) {
  const total = jobs.length;
  let done = 0;
  const sum = { video: 0, desc: 0, att: 0, locked: 0, fail: 0 };
  for (const job of jobs) {
    if (cb.stopped && cb.stopped()) break;
    cb.onUpdate({ done, total, current: "M" + pad2(job.m) + "A" + pad2(job.a) + " · " + job.name, status: "" });
    try {
      const r = await downloadOne(job, D, opts, (tag, status) => cb.onUpdate({ done, total, current: tag + " · " + job.name, status }));
      for (const k in r) sum[k] = (sum[k] || 0) + (r[k] || 0);
    } catch (e) { sum.fail++; }
    done++;
    cb.onUpdate({ done, total, current: "", status: "" });
  }
  cb.onDone(sum);
}

// MARCO 1: testa baixar a 1ª aula com vídeo (mantido).
async function testDownloadOne(DATA, onStatus) {
  const l = DATA.modules.flatMap((M) => M.lessons.map((x) => ({ ...x, m: M.m, mname: M.name }))).find((x) => x.hasVideo && !x.locked);
  if (!l) { onStatus("Nenhuma aula com vídeo.", true); return; }
  await downloadOne({ ...l }, DATA, { folderTpl: "hotmart-dl-teste", fileTpl: "M{mm}A{aa} - {lesson}", doDesc: false, doAttach: false, prefer: "high" },
    (tag, s) => onStatus(tag + ": " + s)).then(() => onStatus("✓ teste concluído (veja Downloads/hotmart-dl-teste).")).catch((e) => onStatus("erro: " + e.message, true));
}

// expõe só a API pública pro popup.js
window.downloadCourse = downloadCourse;
window.testDownloadOne = testDownloadOne;
})();
