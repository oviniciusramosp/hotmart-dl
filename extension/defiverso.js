// Adaptador defiverso (app.defiverso.com) — injetado no MAIN world pelo popup.
// Expõe window.__dv.{list, resolve}. As aulas do portal são trocadas por JS (o path
// do vídeo fica num closure), então resolvemos DIRIGINDO a playlist: clica a aula ->
// o app chama /wp-json/defiverso/v1/hls?path=… (com cookie) -> pegamos o m3u8 e
// extraímos os segmentos. Tudo dentro da página; o token nunca sai daqui pra IA.
(function () {
  window.__dv = window.__dv || {};

  function items() {
    var all = [].slice.call(document.querySelectorAll('[class*="cursor-pointer"]'))
      .filter(function (e) { return /\b\d{1,2}:\d{2}\b/.test(e.textContent) && e.querySelectorAll("*").length < 15; });
    var seen = {}, out = [];
    all.forEach(function (e) {
      var raw = e.textContent.replace(/\s+/g, " ").trim();
      var dm = raw.match(/\((\d{1,2}:\d{2})\)\s*$/);
      var name = raw.replace(/\s*\(\d{1,2}:\d{2}\)\s*$/, "").replace(/^\d+[.)]\s*/, "").trim();
      if (name && !seen[name]) { seen[name] = 1; out.push({ el: e, name: name, dur: dm ? dm[1] : "" }); }
    });
    return out;
  }

  window.__dv.list = function () {
    var portal = ((document.querySelector("h1") || {}).textContent || document.title || "Portal").replace(/\s+/g, " ").trim();
    return { portal: portal, lessons: items().map(function (i) { return { name: i.name, dur: i.dur }; }) };
  };

  function hook() {
    if (window.__dv._hooked) return;
    window.__dv._hooked = true; window.__dv._last = null;
    var of = window.fetch;
    if (of) window.fetch = function (u) { try { var s = typeof u === "string" ? u : (u && u.url) || ""; if (s.indexOf("/wp-json/defiverso/v1/hls") >= 0) window.__dv._last = s; } catch (e) {} return of.apply(this, arguments); };
    var oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { try { if (String(u).indexOf("/wp-json/defiverso/v1/hls") >= 0) window.__dv._last = String(u); } catch (e) {} return oo.apply(this, arguments); };
  }

  // clica a aula[index], espera o /hls, resolve master->variante->mídia e devolve os segmentos
  window.__dv.resolve = async function (index, prefer) {
    hook();
    var list = items();
    var it = list[index];
    if (!it) return { error: "aula não encontrada" };
    async function waitLast(ms) { for (var t = 0; t < ms / 200 && !window.__dv._last; t++) await new Promise(function (r) { setTimeout(r, 200); }); return window.__dv._last; }
    window.__dv._last = null;
    it.el.click();
    var hls = await waitLast(6000);
    if (!hls && list.length > 1) {  // talvez já fosse a aula ativa e o app não recarregou: troca e volta
      list[(index + 1) % list.length].el.click();
      await new Promise(function (r) { setTimeout(r, 800); });
      window.__dv._last = null;
      it.el.click();
      hls = await waitLast(8000);
    }
    if (!hls) return { error: "o player não carregou o vídeo (hls) a tempo" };
    async function txt(u) { return fetch(u, { credentials: "include" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); }); }
    try {
      var url = hls, pl = await txt(url);
      if (pl.indexOf("#EXT-X-STREAM-INF") >= 0) {  // master -> variante mais alta
        var L = pl.split("\n"), vs = [];
        for (var i = 0; i < L.length; i++) if (L[i].indexOf("#EXT-X-STREAM-INF") === 0) {
          var h = parseInt((L[i].match(/RESOLUTION=\d+x(\d+)/) || [])[1] || "0", 10);
          var u2 = (L[i + 1] || "").trim();
          if (u2 && u2[0] !== "#") vs.push({ h: h, url: new URL(u2, url).href });
        }
        if (vs.length) { vs.sort(function (a, b) { return b.h - a.h; }); url = (prefer === "low" ? vs[vs.length - 1] : vs[0]).url; pl = await txt(url); }
      }
      var km = pl.match(/#EXT-X-KEY:[^\n]*URI="([^"]+)"/);
      var ivm = pl.match(/IV=0x([0-9a-fA-F]+)/);
      var segs = pl.split("\n").map(function (l) { return l.trim(); }).filter(function (l) { return l && l[0] !== "#"; }).map(function (l) { return new URL(l, url).href; });
      if (!segs.length) return { error: "playlist sem segmentos" };
      return {
        segs: segs,
        keyUrl: km ? new URL(km[1], url).href : null,
        ivHex: ivm ? ivm[1] : null,
        seq0: parseInt((pl.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || "0", 10),
      };
    } catch (e) { return { error: "falha ao resolver hls: " + e.message }; }
  };
})();
