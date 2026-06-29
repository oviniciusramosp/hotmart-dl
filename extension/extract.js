// Roda no MAIN world quando voce clica no icone da extensao, numa pagina de curso
// Hotmart Club. Extrai: token de sessao, productId/subdomain/appName e a arvore
// completa de modulos/aulas (da memoria React), e baixa um <subdomain>.course.json.
(function () {
  function toast(msg, bad) {
    var d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText =
      "position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);" +
      "padding:12px 18px;border-radius:10px;font:600 14px/1.3 system-ui;color:#fff;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.35);background:" + (bad ? "#c0392b" : "#1e824c");
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 5000);
  }

  // --- localizar a arvore de modulos/aulas via React fiber ---
  function getFiber(el) {
    for (var k in el) {
      if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) return el[k];
      if (k.indexOf("__reactContainer$") === 0) { var c = el[k]; return c && c.current ? c.current : c; }
    }
    return null;
  }
  function looksModule(o) {
    return o && typeof o === "object" && ("name" in o || "title" in o) &&
      (Array.isArray(o.pages) || Array.isArray(o.lessons) || Array.isArray(o.contents) ||
       Array.isArray(o.children) || Array.isArray(o.items));
  }
  function findTree() {
    var t0 = performance.now();
    var starts = [];
    var nx = document.querySelector("#__next");
    if (nx) { var f = getFiber(nx); if (f) starts.push(f); }
    var asides = document.querySelectorAll("aside,#app-space-microfront");
    for (var i = 0; i < asides.length; i++) { var g = getFiber(asides[i]); if (g) starts.push(g); }
    var q = starts.slice(), seen = 0, found = null, visited = new Set();
    while (q.length && seen < 150000 && performance.now() - t0 < 9000 && !found) {
      var n = q.shift();
      if (!n || typeof n !== "object" || visited.has(n)) continue;
      visited.add(n); seen++;
      var keys = ["memoizedProps", "memoizedState"];
      for (var ki = 0; ki < keys.length && !found; ki++) {
        var p = n[keys[ki]];
        if (p && typeof p === "object") {
          for (var k in p) {
            var v; try { v = p[k]; } catch (e) { continue; }
            if (Array.isArray(v) && v.length > 1 && looksModule(v[0])) { found = v; break; }
            if (v && typeof v === "object" && !Array.isArray(v)) {
              for (var k2 in v) {
                var v2; try { v2 = v[k2]; } catch (e) { continue; }
                if (Array.isArray(v2) && v2.length > 1 && looksModule(v2[0])) { found = v2; break; }
              }
              if (found) break;
            }
          }
        }
      }
      if (n.child) q.push(n.child);
      if (n.sibling) q.push(n.sibling);
    }
    return found;
  }

  // --- auth + identificadores ---
  var token = "";
  try { token = localStorage.getItem("token") || ""; } catch (e) {}
  var meta = window.__hotmartMeta || {};
  var mu = location.pathname.match(/club\/([^/]+)\/products\/(\d+)/);
  var subdomain = mu ? mu[1] : "";
  var productId = meta.productId || (mu ? mu[2] : "");
  var appName = meta.appName || "";

  if (!token) { toast("Hotmart: token nao encontrado — voce esta logado nesta aba?", true); return; }
  if (!productId) { toast("Hotmart: abra a pagina DENTRO de um curso (/club/.../products/<id>/content/...).", true); return; }
  if (!appName) { toast("Hotmart: aguarde a pagina carregar e navegue 1 aula, depois clique de novo.", true); return; }

  var tree = findTree();
  if (!tree) { toast("Hotmart: estrutura do curso nao encontrada nesta pagina.", true); return; }

  var modules = tree.map(function (M, i) {
    var L = M.pages || M.lessons || M.contents || M.children || M.items || [];
    return {
      m: i + 1,
      name: String(M.name || M.title || ("Modulo " + (i + 1))),
      lessons: L.map(function (l, j) {
        return {
          a: j + 1,
          name: String(l.name || l.title || ("Aula " + (j + 1))),
          hash: String(l.hash || l.pageHash || ""),
          hasVideo: !!(l.hasPlayerMedia || l.firstMediaType === "VIDEO"),
          dur: l.mediaDurationInSeconds || 0
        };
      })
    };
  });

  var courseName = (document.title || "Curso Hotmart").replace(/\s*\|\s*Hotmart.*/i, "").trim() || subdomain;
  var course = { course: courseName, subdomain: subdomain, productId: productId,
                 appName: appName, token: token, modules: modules };

  var nVids = 0, nLes = 0;
  modules.forEach(function (M) { M.lessons.forEach(function (l) { nLes++; if (l.hasVideo) nVids++; }); });

  var blob = new Blob([JSON.stringify(course, null, 2)], { type: "application/json" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (subdomain || "curso") + ".course.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 8000);

  toast("course.json baixado: " + modules.length + " modulos, " + nVids + " videos / " + nLes + " aulas. " +
        "Agora rode: python3 hotmart_dl.py");
})();
