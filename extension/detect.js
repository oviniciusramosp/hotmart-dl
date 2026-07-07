// Detector genérico de vídeo (injetado no MAIN world sob demanda pelo popup).
// NÃO baixa nada: descobre os manifestos/arquivos de mídia que a página buscou e
// devolve a lista (URLs assinadas ficam locais, nunca passam pela IA).
//   1) Resource Timing: o que o player já baixou (.m3u8/.mpd/.mp4/.webm)
//   2) <video>/<source> com src http direto (não-blob)
//   3) hook de fetch/XHR: captura manifestos que aparecerem DEPOIS (dê play e re-detecte)
(function () {
  function ext(u) { try { return (new URL(u, location.href).pathname.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase(); } catch (e) { return ""; } }
  function kindOf(x) { return x === ".m3u8" ? "hls" : x === ".mpd" ? "dash" : (x === ".mp4" || x === ".webm") ? "file" : ""; }

  // hook persistente (1x por página): guarda manifestos futuros em window.__vidcap
  if (!window.__vidcap) {
    window.__vidcap = [];
    var push = function (u) { var k = kindOf(ext(u)); if (k === "hls" || k === "dash") window.__vidcap.push({ url: String(u), kind: k }); };
    var of = window.fetch;
    if (of) window.fetch = function (u) { try { push(typeof u === "string" ? u : (u && u.url)); } catch (e) {} return of.apply(this, arguments); };
    var oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { try { push(u); } catch (e) {} return oo.apply(this, arguments); };
  }

  var seen = {}, streams = [];
  function add(u, kind) {
    if (!u || !kind || seen[u] || u.startsWith("blob:") || u.startsWith("data:")) return;
    seen[u] = 1; streams.push({ url: String(u), kind: kind });
  }
  try { (performance.getEntriesByType("resource") || []).forEach(function (e) { add(e.name, kindOf(ext(e.name))); }); } catch (e) {}
  (window.__vidcap || []).forEach(function (s) { add(s.url, s.kind); });
  document.querySelectorAll("video").forEach(function (v) {
    if (v.src) add(v.src, kindOf(ext(v.src)) || "file");
    v.querySelectorAll("source").forEach(function (s) { if (s.src) add(s.src, kindOf(ext(s.src)) || "file"); });
  });

  // prioriza manifesto (hls/dash) sobre arquivo solto; ignora segmentos .ts individuais
  var order = { hls: 0, dash: 1, file: 2 };
  streams.sort(function (a, b) { return (order[a.kind] || 9) - (order[b.kind] || 9); });
  var title = (document.title || "").replace(/\s*[|\-–—·].*$/, "").trim() || document.title || "video";
  return { title: title, streams: streams };
})();
