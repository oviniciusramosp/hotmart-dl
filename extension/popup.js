// Popup: injeta o extractor no MAIN world da aba do curso, mostra a arvore com
// checkboxes + padrao de nome, e exporta um course.json so com o que foi marcado.
// Módulo ES: escopo próprio. Importa a API de download do download.js.
import { downloadCourse, scanLesson, downloadGeneric } from "./download.js";
const $ = (s) => document.querySelector(s);
const PRESETS = [
  { id: "mod_MA", label: "Módulo + M00A00 (padrão)", folder: "Modulo {mm} - {module}", file: "M{mm}A{aa} - {lesson}" },
  { id: "mod_num", label: "Módulo + 00 - título", folder: "Modulo {mm} - {module}", file: "{aa} - {lesson}" },
  { id: "mod_title", label: "Pasta do módulo + título", folder: "{module}", file: "{lesson}" },
  { id: "flat_MA", label: "Tudo numa pasta + M00A00", folder: "", file: "M{mm}A{aa} - {lesson}" },
  { id: "custom", label: "Personalizado…", folder: "", file: "" },
];
let DATA = null;
let dlRunning = false, dlStop = false;

const IC = {
  video: '<span class="ic v" title="vídeo"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M10 10l4 2-4 2z" fill="currentColor" stroke="none"/></svg></span>',
  desc: '<span class="ic d" title="descrição"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h9l3 3v15H6z"/><path d="M9 11h6M9 15h6"/></svg></span>',
  material: '<span class="ic m" title="materiais"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 7v8a3 3 0 0 0 6 0V6a4 4 0 0 0-8 0v9a5 5 0 0 0 10 0V7"/></svg></span>',
  lock: '<span class="ic l" title="bloqueada"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>',
};
function ringSvg(pct) { const r = 6, c = (2 * Math.PI * r).toFixed(1), off = (c * (1 - pct / 100)).toFixed(1); return `<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="${r}" fill="none" stroke="#2a2e37" stroke-width="2"/><circle cx="8" cy="8" r="${r}" fill="none" stroke="#4f8cff" stroke-width="2" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 8 8)"/></svg>`; }
const SPIN = '<svg class="spin" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="#2a2e37" stroke-width="2"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="#4f8cff" stroke-width="2" stroke-linecap="round"/></svg>';
const CHECK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#6ee7a8" stroke-width="2"><path d="M3 8.5l3.5 3.5L13 5"/></svg>';
const XMARK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#ff8a8a" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

const dlState = {};     // "m:a" -> terminou (bool), pra contar o progresso do módulo
const modTotal = {};    // m -> nº de aulas selecionadas no módulo

const lessonRow = (m, a) => document.querySelector(`.les[data-m="${m}"][data-a="${a}"]`);
function updateLessonRow(m, a, status, pct) {
  const row = lessonRow(m, a); if (!row) return;
  const sel = row.querySelector(".sel"), pr = sel.querySelector(".prog");
  sel.classList.remove("done");
  if (status === "baixando" && pct != null) { sel.classList.add("busy"); pr.innerHTML = ringSvg(Math.round(pct * 100)); }
  else if (status === "resolvendo" || status === "descricao" || status === "materiais") { sel.classList.add("busy"); pr.innerHTML = SPIN; }
  else if (status === "ok") { sel.classList.add("busy", "done"); pr.innerHTML = CHECK; }
  else if (status === "erro") { sel.classList.add("busy", "done"); pr.innerHTML = XMARK; }
  else { sel.classList.remove("busy"); pr.innerHTML = ""; }
  if (status === "ok" || status === "erro" || status === "bloqueada") { dlState[m + ":" + a] = status; updateModuleRing(m); }
}
function updateModuleRing(m) {
  const mod = document.querySelector(`.mod[data-m="${m}"]`); if (!mod) return;
  const el = mod.querySelector(".modprog"); if (!el) return;
  const tot = modTotal[m] || 0;
  const keys = Object.keys(dlState).filter((k) => k.startsWith(m + ":"));
  if (!tot) { el.innerHTML = ""; return; }
  if (keys.length >= tot) {                                    // módulo todo concluído
    el.innerHTML = keys.every((k) => dlState[k] === "ok") ? CHECK : XMARK;
  } else {
    el.innerHTML = ringSvg(Math.round(100 * keys.length / tot));
  }
}

async function panelScan() {
  const ls = [];
  DATA.modules.forEach((M) => M.lessons.forEach((l) => { if (!l.locked) ls.push({ m: M.m, a: l.a, hash: l.hash }); }));
  let i = 0;
  const worker = async () => {
    while (i < ls.length && DATA) {
      const l = ls[i++];
      try {
        const { hasDesc, att } = await scanLesson(l.hash, DATA);
        const row = lessonRow(l.m, l.a); if (!row) continue;
        if (hasDesc) row.querySelector(".icons .slot.d").innerHTML = IC.desc;
        if (att > 0) row.querySelector(".icons .slot.m").innerHTML = IC.material + (att > 1 ? `<span class="cnt">${att}</span>` : "");
      } catch (e) {}
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

const pad2 = (n) => String(n).padStart(2, "0");
const clean = (s) => String(s || "").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "x";
function render(tpl, m, a, module, lesson) {
  return tpl.replace(/\{mm\}/g, pad2(m)).replace(/\{m\}/g, m)
            .replace(/\{aa\}/g, pad2(a)).replace(/\{a\}/g, a)
            .replace(/\{module\}/g, clean(module)).replace(/\{lesson\}/g, clean(lesson));
}
function currentNaming() {
  const p = PRESETS.find((x) => x.id === $("#preset").value);
  if (p.id === "custom") return { folder: $("#folderTpl").value, file: $("#fileTpl").value };
  return { folder: p.folder, file: p.file };
}
function fmtDur(s) { if (!s) return ""; const m = Math.floor(s / 60); return m + ":" + pad2(Math.round(s % 60)); }

function selectedLessons() {
  const out = [];
  document.querySelectorAll(".les input:checked").forEach((cb) => {
    out.push({ m: +cb.dataset.m, a: +cb.dataset.a });
  });
  return out;
}

function updatePreview() {
  const n = currentNaming();
  // pega a primeira aula marcada pra exemplo (ou um generico)
  const cb = document.querySelector(".les input:checked");
  let m = 2, a = 3, mod = "Nome do Módulo", les = "Nome da Aula";
  if (cb) { m = +cb.dataset.m; a = +cb.dataset.a; mod = cb.dataset.mod; les = cb.dataset.les; }
  const folder = n.folder ? render(n.folder, m, a, mod, les) + "/" : "";
  $("#preview").textContent = "ex: " + folder + render(n.file, m, a, mod, les) + ".mp4";
  const sel = document.querySelectorAll(".les input:checked").length;
  const tot = document.querySelectorAll(".les input:not([disabled])").length;
  $("#count").textContent = sel + " / " + tot + " aulas";
  $("#go").disabled = sel === 0;
}

function buildTree() {
  const tree = $("#tree");
  tree.innerHTML = "";
  DATA.modules.forEach((M) => {
    const vids = M.lessons.filter((l) => l.hasVideo).length;
    const mod = document.createElement("div");
    mod.className = "mod";
    mod.dataset.m = M.m;
    const head = document.createElement("div");
    head.className = "mod-head";
    head.innerHTML = `<span class="twi">▶</span>
      <input type="checkbox" class="modchk" title="Marcar módulo">
      <span class="mod-name"></span><span class="modprog"></span><span class="mod-meta">${vids} vídeo(s)</span>`;
    head.querySelector(".mod-name").textContent = `M${pad2(M.m)} · ${M.name}`;
    mod.appendChild(head);
    const wrap = document.createElement("div");
    wrap.className = "lessons";
    M.lessons.forEach((l) => {
      const les = document.createElement("label");
      les.className = "les" + (l.hasVideo ? "" : " novid") + (l.locked ? " locked" : "");
      les.dataset.m = M.m; les.dataset.a = l.a;
      // seletor: checkbox <-> progresso/check ocupam a mesma célula (mesmo tamanho)
      const sel = document.createElement("span"); sel.className = "sel";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.m = M.m; cb.dataset.a = l.a; cb.dataset.mod = M.name; cb.dataset.les = l.name;
      if (l.locked) cb.disabled = true; else cb.checked = true;  // sem vídeo fica marcado (desc/material)
      sel.appendChild(cb);
      const prog = document.createElement("span"); prog.className = "prog"; sel.appendChild(prog);
      les.appendChild(sel);
      const nm = document.createElement("span");
      nm.className = "nm"; nm.textContent = `M${pad2(M.m)}A${pad2(l.a)} · ${l.name}`;
      les.appendChild(nm);
      // ícones em colunas fixas: vídeo | descrição | material (alinham entre as linhas)
      const icons = document.createElement("span"); icons.className = "icons";
      icons.innerHTML = `<span class="slot v">${l.locked ? IC.lock : (l.hasVideo ? IC.video : "")}</span>`
                      + `<span class="slot d"></span><span class="slot m"></span>`;  // desc/material vêm do scan
      les.appendChild(icons);
      const dur = document.createElement("span"); dur.className = "dur";
      dur.textContent = (!l.locked && l.hasVideo) ? fmtDur(l.dur) : "";
      les.appendChild(dur);
      cb.addEventListener("change", () => { syncModChk(mod, M); updatePreview(); });
      // clicar no check (aula concluída) volta a mostrar o checkbox pra re-selecionar
      prog.addEventListener("click", (e) => {
        if (!sel.classList.contains("done")) return;
        e.preventDefault(); e.stopPropagation();
        sel.classList.remove("busy", "done"); prog.innerHTML = "";
        cb.checked = true; delete dlState[M.m + ":" + l.a];
        updateModuleRing(M.m); syncModChk(mod, M); updatePreview();
      });
      wrap.appendChild(les);
    });
    mod.appendChild(wrap);
    // toggle expand
    head.addEventListener("click", (e) => { if (e.target.tagName !== "INPUT") mod.classList.toggle("open"); });
    // module checkbox = marca/desmarca todas as do modulo
    head.querySelector(".modchk").addEventListener("change", (e) => {
      wrap.querySelectorAll("input:not([disabled])").forEach((cb) => { cb.checked = e.target.checked; });
      updatePreview();
    });
    syncModChk(mod, M);
    tree.appendChild(mod);
  });
}
function syncModChk(mod, M) {
  const cbs = [...mod.querySelectorAll(".les input:not([disabled])")];
  const chk = mod.querySelector(".modchk");
  const on = cbs.filter((c) => c.checked).length;
  chk.checked = on > 0 && on === cbs.length;
  chk.indeterminate = on > 0 && on < cbs.length;
}

function exportJSON() {
  const naming = currentNaming();
  if (!naming.file) { setStatus("Defina o template do arquivo.", true); return; }
  const sel = new Set(selectedLessons().map((x) => x.m + ":" + x.a));
  const modules = DATA.modules.map((M) => ({
    m: M.m, name: M.name,
    lessons: M.lessons.filter((l) => sel.has(M.m + ":" + l.a))
                       .map((l) => ({ a: l.a, name: l.name, hash: l.hash,
                                      hasVideo: !!l.hasVideo, locked: !!l.locked, dur: l.dur })),
  })).filter((M) => M.lessons.length);
  const course = {
    course: DATA.course, subdomain: DATA.subdomain, productId: DATA.productId,
    appName: DATA.appName, token: DATA.token, naming,
    resolution: $("#res").value,
    options: { descriptions: $("#optDesc").checked, attachments: $("#optAtt").checked },
    modules,
  };
  const blob = new Blob([JSON.stringify(course, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const fname = (DATA.subdomain || "curso") + ".course.json";
  chrome.downloads.download({ url, filename: fname, saveAs: false }, () => {
    const n = course.modules.reduce((s, M) => s + M.lessons.length, 0);
    setStatus(`✓ ${fname} salvo (${n} aulas). Agora abra o app pra baixar:`);
    const cmd = "cd ~/Documents/Apps/ChromePlugins/hotmart-dl && python3 serve.py";
    $("#cmd").style.display = "block";
    $("#cmd").innerHTML = '<span class="copy" id="cp">copiar</span>App (fila + progresso + selos + qualidade):<br>' + cmd;
    $("#cp").addEventListener("click", () => navigator.clipboard.writeText(cmd));
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
}

function setStatus(msg, err) { const s = $("#status"); s.textContent = msg; s.className = err ? "err" : ""; }

function selectedJobs() {
  const sel = new Set(selectedLessons().map((x) => x.m + ":" + x.a));
  const jobs = [];
  DATA.modules.forEach((M) => M.lessons.forEach((l) => {
    if (sel.has(M.m + ":" + l.a) && !l.locked)
      jobs.push({ m: M.m, mname: M.name, a: l.a, name: l.name, hash: l.hash, hasVideo: !!l.hasVideo, locked: !!l.locked });
  }));
  return jobs;
}

function setReferer(on) { return new Promise((res) => chrome.runtime.sendMessage({ type: "hmReferer", on }, res)); }

async function onDownloadHere() {
  if (dlRunning) { dlStop = true; $("#dlhere").textContent = "parando…"; return; }
  const jobs = selectedJobs();
  if (!jobs.length) { setStatus("Marque ao menos uma aula.", true); return; }
  dlStop = false; dlRunning = true;
  const btn = $("#dlhere"); btn.textContent = "■ Parar"; btn.classList.add("stop");
  $("#dlbar").style.display = "block"; $("#cmd").style.display = "none";
  for (const k in dlState) delete dlState[k];          // zera progresso anterior
  for (const k in modTotal) delete modTotal[k];
  jobs.forEach((j) => { modTotal[j.m] = (modTotal[j.m] || 0) + 1; });
  await setReferer(true);   // regra de Referer ativa só durante o download
  const n = currentNaming();
  const opts = { folderTpl: n.folder, fileTpl: n.file, doDesc: $("#optDesc").checked,
                 doAttach: $("#optAtt").checked, prefer: $("#res").value };
  downloadCourse(jobs, DATA, opts, {
    stopped: () => dlStop,
    onLesson: (m, a, status, pct) => updateLessonRow(m, a, status, pct),
    onOverall: (done, total) => {
      $("#dlbar").firstElementChild.style.width = (total ? Math.round(100 * done / total) : 0) + "%";
      setStatus(`${done}/${total} aulas concluídas`);
    },
    onDone: async (sum) => {
      await setReferer(false);   // desliga ao terminar
      dlRunning = false; const b = $("#dlhere");
      b.textContent = "⬇ Baixar selecionadas (aqui no navegador)"; b.classList.remove("stop");
      setStatus(`Fim. vídeos=${sum.video} descrições=${sum.desc} materiais=${sum.att} bloqueadas=${sum.locked} falhas=${sum.fail}`);
    },
  });
}

// ---- modo genérico (qualquer site sem adaptador dedicado) ----
async function initGeneric(tab) {
  document.querySelector("footer").style.display = "none";
  $("#tree").style.display = "none";
  $("#generic").style.display = "flex";
  let host = ""; try { host = new URL(tab.url).hostname; } catch (e) {}
  $("#course").textContent = "Modo genérico — " + host;
  const scan = async () => {
    $("#gstatus").textContent = "detectando…";
    let res;
    try { res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", files: ["detect.js"] }); }
    catch (e) { $("#gstatus").textContent = "Falha ao ler a página: " + e.message; return; }
    const d = (res && res[0] && res[0].result) || { streams: [], title: "" };
    if (d.title && !$("#gname").value) $("#gname").value = d.title;
    renderStreams(d.streams || []);
  };
  $("#gdetect").addEventListener("click", scan);
  await scan();
}
function renderStreams(streams) {
  const usable = streams.filter((s) => s.kind === "hls" || s.kind === "file");
  const list = $("#glist"); list.innerHTML = "";
  if (!usable.length) {
    $("#gstatus").textContent = "Nenhum vídeo detectado. Dê ▶ play no vídeo e clique “🔄 detectar de novo”.";
    return;
  }
  $("#gstatus").textContent = usable.length + " vídeo(s) detectado(s)";
  usable.forEach((s, i) => {
    const row = document.createElement("div"); row.className = "gstream";
    const btn = document.createElement("button");
    btn.textContent = `⬇ Baixar vídeo ${usable.length > 1 ? "#" + (i + 1) + " " : ""}(${s.kind === "hls" ? "HLS→.ts" : "arquivo"})`;
    const prog = document.createElement("span"); prog.className = "gprog";
    btn.addEventListener("click", () => downloadGenericStream(s, btn, prog));
    row.appendChild(btn); row.appendChild(prog); list.appendChild(row);
  });
}
async function downloadGenericStream(stream, btn, prog) {
  const name = clean($("#gname").value || "video");
  btn.disabled = true; prog.textContent = "…";
  try {
    await downloadGeneric(stream, name, $("#gres").value, (status, pct) => {
      if (status === "baixando" && pct != null) prog.textContent = Math.round(pct * 100) + "%";
      else if (status === "baixando") prog.textContent = "…";
      else if (status === "ok") prog.textContent = "✓";
    });
  } catch (e) { prog.textContent = "erro"; $("#gstatus").textContent = "Falha: " + e.message; }
  finally { btn.disabled = false; }
}

async function init() {
  const rb = $("#refresh");
  if (rb) rb.addEventListener("click", () => location.reload());  // re-lê o curso da aba atual
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:\/\//.test(tab.url || "")) {
    $("#course").textContent = "Abra a página de um vídeo (site http/https).";
    return;
  }
  if (!/^https:\/\/(.*\.)?hotmart\.com\//.test(tab.url)) { await initGeneric(tab); return; }  // multi-site
  // re-tenta algumas vezes: ao trocar de curso a árvore React pode estar montando
  let data = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", files: ["extractor.js"] });
    } catch (e) { $("#course").textContent = "Falha ao ler a página: " + e.message; return; }
    data = res && res[0] && res[0].result;
    if (data && !data.error) break;                                   // sucesso
    if (attempt < 3) { $("#course").textContent = "Lendo o curso…"; await new Promise((r) => setTimeout(r, 700)); }
  }
  if (!data) { $("#course").textContent = "Nada retornado. Recarregue a página do curso."; return; }
  if (data.error) { $("#course").textContent = data.error; return; }
  DATA = data;

  // preset dropdown
  const sel = $("#preset");
  PRESETS.forEach((p) => { const o = document.createElement("option"); o.value = p.id; o.textContent = p.label; sel.appendChild(o); });
  sel.addEventListener("change", () => {
    $("#customWrap").style.display = sel.value === "custom" ? "flex" : "none";
    if (sel.value === "custom") {
      const p = PRESETS[0]; if (!$("#folderTpl").value) $("#folderTpl").value = p.folder;
      if (!$("#fileTpl").value) $("#fileTpl").value = p.file;
    }
    updatePreview();
  });
  $("#folderTpl").addEventListener("input", updatePreview);
  $("#fileTpl").addEventListener("input", updatePreview);

  const nv = DATA.modules.reduce((s, M) => s + M.lessons.filter((l) => l.hasVideo).length, 0);
  $("#course").textContent = `${DATA.course} — ${DATA.modules.length} módulos, ${nv} vídeos`;
  $("#controls").style.display = "flex";
  buildTree();
  panelScan();   // em segundo plano: preenche os ícones de descrição/material
  $("#all").addEventListener("click", () => { document.querySelectorAll(".les input:not([disabled])").forEach((c) => c.checked = true); document.querySelectorAll(".mod").forEach((m, i) => syncModChk(m, DATA.modules[i])); updatePreview(); });
  $("#none").addEventListener("click", () => { document.querySelectorAll(".les input").forEach((c) => c.checked = false); document.querySelectorAll(".mod").forEach((m, i) => syncModChk(m, DATA.modules[i])); updatePreview(); });
  $("#go").addEventListener("click", exportJSON);
  $("#dlhere").addEventListener("click", onDownloadHere);
  updatePreview();
}
init();
