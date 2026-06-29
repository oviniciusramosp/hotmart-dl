// Download in-browser (roda no painel, com host_permissions => sem CORS pros *.hotmart.com).
// Marco 1: resolve 1 aula (lesson API -> embed -> m3u8), busca segmentos, decifra AES-128
// e salva. Formato .ts por enquanto (prova o pipeline); mp4 via mux.js vem depois.
const GW = "https://api-club-course-consumption-gateway-ga.cb.hotmart.com/v2/web/lessons/";

function hexToBytes(hex) {
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}
function seqIV(seq) {
  // IV padrão do HLS quando não vem no EXT-X-KEY: número de sequência em 16 bytes big-endian
  const iv = new Uint8Array(16);
  for (let i = 15; i >= 0 && seq > 0; i--) { iv[i] = seq & 0xff; seq = Math.floor(seq / 256); }
  return iv;
}
function sanitize(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "x";
}

async function resolveM3u8(hash, D) {
  const lj = await fetch(GW + hash, {
    headers: { Authorization: "Bearer " + D.token, "x-product-id": String(D.productId),
               "x-app-name": D.appName, Accept: "application/json, text/plain, */*" },
  }).then((r) => r.json());
  const media = (lj.medias || []).find((m) => m.type === "VIDEO" && m.url);
  if (!media) return null;
  const page = await fetch(media.url, { headers: { Referer: "https://hotmart.com/" } }).then((r) => r.text());
  const m = page.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) throw new Error("__NEXT_DATA__ não encontrado no player");
  const data = JSON.parse(m[1]);
  let assets = (((data.props || {}).pageProps || {}).applicationData || {}).mediaAssets || [];
  assets = assets.filter((a) => (a.url || "").includes(".m3u8"));
  if (!assets.length) throw new Error("sem m3u8 (DRM?)");
  assets.sort((a, b) => (b.height || 0) - (a.height || 0));
  return assets[0].url; // maior qualidade
}

async function downloadHlsBlob(m3u8url, onProgress) {
  let pl = await fetch(m3u8url).then((r) => r.text());
  // se for MASTER (lista qualidades), resolve a melhor variante primeiro
  if (pl.includes("#EXT-X-STREAM-INF")) {
    const lines = pl.split("\n");
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
        const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || "0", 10);
        const h = parseInt((lines[i].match(/RESOLUTION=\d+x(\d+)/) || [])[1] || "0", 10);
        const u = (lines[i + 1] || "").trim();
        if (u && !u.startsWith("#")) variants.push({ bw, h, url: new URL(u, m3u8url).href });
      }
    }
    if (variants.length) {
      variants.sort((a, b) => b.h - a.h || b.bw - a.bw);
      m3u8url = variants[0].url;            // melhor qualidade
      pl = await fetch(m3u8url).then((r) => r.text());
    }
  }
  // chave AES (se houver)
  let key = null, ivFixed = null;
  const km = pl.match(/#EXT-X-KEY:[^\n]*URI="([^"]+)"/);
  if (km) {
    const keyUrl = new URL(km[1], m3u8url).href;
    const keyBuf = await fetch(keyUrl).then((r) => r.arrayBuffer());
    key = await crypto.subtle.importKey("raw", keyBuf, { name: "AES-CBC" }, false, ["decrypt"]);
    const ivm = pl.match(/IV=0x([0-9a-fA-F]+)/);
    if (ivm) ivFixed = hexToBytes(ivm[1]);
  }
  const seq0 = parseInt((pl.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || "0", 10);
  const segs = pl.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
                 .map((l) => new URL(l, m3u8url).href);
  const parts = [];
  for (let i = 0; i < segs.length; i++) {
    const enc = await fetch(segs[i]).then((r) => r.arrayBuffer());
    let dec = enc;
    if (key) {
      const iv = ivFixed || seqIV(seq0 + i);
      dec = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, enc);
    }
    parts.push(new Uint8Array(dec));
    if (onProgress) onProgress((i + 1) / segs.length);
  }
  return new Blob(parts, { type: "video/mp2t" });
}

function saveBlob(blob, relPath) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: relPath, saveAs: false, conflictAction: "overwrite" }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  });
}

// MARCO 1: baixa a primeira aula com vídeo de DATA, dentro do navegador.
async function testDownloadOne(DATA, onStatus) {
  const lesson = DATA.modules.flatMap((M) => M.lessons.map((l) => ({ ...l, m: M.m })))
                             .find((l) => l.hasVideo && !l.locked);
  if (!lesson) { onStatus("Nenhuma aula com vídeo encontrada.", true); return; }
  const tag = "M" + String(lesson.m).padStart(2, "0") + "A" + String(lesson.a).padStart(2, "0");
  try {
    onStatus(`${tag}: resolvendo…`);
    const m3u8 = await resolveM3u8(lesson.hash, DATA);
    if (!m3u8) { onStatus(`${tag}: sem vídeo resolvível.`, true); return; }
    const blob = await downloadHlsBlob(m3u8, (p) => onStatus(`${tag}: baixando ${Math.round(p * 100)}%`));
    const name = `hotmart-dl-teste/${tag} - ${sanitize(lesson.name)}.ts`;
    await saveBlob(blob, name);
    onStatus(`✓ ${tag} salvo em Downloads/${name} (${(blob.size / 1e6).toFixed(1)} MB). Toca no VLC.`);
  } catch (e) {
    onStatus(`${tag}: erro — ${e.message}`, true);
  }
}
