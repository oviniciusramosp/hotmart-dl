// Adaptador Cakto (members.cakto.com.br) — injetado no MAIN world pelo popup.
// Backend Firebase Cloud Functions; auth por Bearer token no localStorage.
//   GET /api/cursos/{cursoId}/        -> { data: { nome, modulos:[{nome,posicao,aulas:[{id,nome,posicao}]}] } }
//   GET /api/aulas/{aulaId}/          -> { nome, video:"<uuid>", files:[...] }
//   HLS público (sem DRM):  https://stream.cakto.com.br/{video}/playlist.m3u8
// As chamadas rodam AQUI (token + CORS ok na origem cakto); o token nunca vai pra IA.
(function () {
  window.__ck = window.__ck || {};
  var API = "https://us-central1-cakto2.cloudfunctions.net/api/";
  var STREAM = "https://stream.cakto.com.br/";
  function token() { try { return localStorage.getItem("token") || ""; } catch (e) { return ""; } }
  function courseId() { var m = location.pathname.match(/courses\/([0-9a-fA-F-]{36})/); return m ? m[1] : ""; }
  function get(path) {
    return fetch(API + path, { headers: { Authorization: "Bearer " + token() } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }

  window.__ck.list = async function () {
    var cid = courseId();
    if (!cid) return { error: "curso não identificado na URL (abra .../courses/<id>/watch)" };
    if (!token()) return { error: "token de login não encontrado — você está logado nesta aba?" };
    var j;
    try { j = await get("cursos/" + cid + "/"); } catch (e) { return { error: "API do curso: " + e.message }; }
    var d = j.data || {};
    var mods = (d.modulos || []).slice().sort(function (a, b) { return (a.posicao || 0) - (b.posicao || 0); });
    return {
      course: d.nome || "Curso Cakto", courseId: cid,
      modules: mods.map(function (M) {
        var aulas = (M.aulas || []).slice().sort(function (a, b) { return (a.posicao || 0) - (b.posicao || 0); });
        return { name: M.nome || "Módulo", lessons: aulas.map(function (a) { return { id: a.id, nome: a.nome || "Aula" }; }) };
      }),
    };
  };

  // resolve a aula -> URL do m3u8 (público) + materiais (files)
  window.__ck.resolve = async function (aulaId) {
    var a;
    try { a = await get("aulas/" + aulaId + "/"); } catch (e) { return { error: "API da aula: " + e.message }; }
    if (!a.video) return { error: "aula sem vídeo", files: a.files || [] };
    return { m3u8: STREAM + a.video + "/playlist.m3u8", files: a.files || [], nome: a.nome || "" };
  };
})();
