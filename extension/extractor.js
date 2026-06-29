// Roda no MAIN world (injetado pelo popup via chrome.scripting.executeScript).
// NAO baixa nada: apenas EXTRAI e RETORNA o objeto do curso pro popup renderizar.
// (o valor da ultima expressao do arquivo e o que o executeScript devolve.)
(function () {
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
    var t0 = performance.now(), starts = [];
    var nx = document.querySelector("#__next");
    if (nx) { var f = getFiber(nx); if (f) starts.push(f); }
    var asides = document.querySelectorAll("aside,#app-space-microfront");
    for (var i = 0; i < asides.length; i++) { var g = getFiber(asides[i]); if (g) starts.push(g); }
    var q = starts.slice(), seen = 0, found = null, visited = new Set();
    while (q.length && seen < 150000 && performance.now() - t0 < 9000 && !found) {
      var n = q.shift();
      if (!n || typeof n !== "object" || visited.has(n)) continue;
      visited.add(n); seen++;
      var kk = ["memoizedProps", "memoizedState"];
      for (var ki = 0; ki < kk.length && !found; ki++) {
        var p = n[kk[ki]];
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

  var token = "";
  try { token = localStorage.getItem("token") || ""; } catch (e) {}
  var meta = window.__hotmartMeta || {};
  var mu = location.pathname.match(/club\/([^/]+)\/products\/(\d+)/);
  var subdomain = mu ? mu[1] : "";
  var productId = meta.productId || (mu ? mu[2] : "");
  var appName = meta.appName || "";

  if (!token) return { error: "Token nao encontrado — voce esta logado nesta aba?" };
  if (!productId) return { error: "Abra a pagina DENTRO de um curso (/club/.../products/<id>/content/...)." };
  if (!appName) return { error: "Aguarde a pagina carregar e navegue 1 aula; depois reabra a extensao." };
  var tree = findTree();
  if (!tree) return { error: "Estrutura do curso nao encontrada nesta pagina." };

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
          locked: !!(l.locked || M.locked),
          dur: l.mediaDurationInSeconds || 0
        };
      })
    };
  });
  var courseName = (document.title || "Curso Hotmart").replace(/\s*\|\s*Hotmart.*/i, "").trim() || subdomain;
  return { course: courseName, subdomain: subdomain, productId: productId,
           appName: appName, token: token, modules: modules };
})();
