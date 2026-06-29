// Popup: injeta o extractor no MAIN world da aba do curso, mostra a arvore com
// checkboxes + padrao de nome, e exporta um course.json so com o que foi marcado.
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
    const head = document.createElement("div");
    head.className = "mod-head";
    head.innerHTML = `<span class="twi">▶</span>
      <input type="checkbox" class="modchk" title="Marcar módulo">
      <span class="mod-name"></span><span class="mod-meta">${vids} vídeo(s)</span>`;
    head.querySelector(".mod-name").textContent = `M${pad2(M.m)} · ${M.name}`;
    mod.appendChild(head);
    const wrap = document.createElement("div");
    wrap.className = "lessons";
    M.lessons.forEach((l) => {
      const les = document.createElement("label");
      les.className = "les" + (l.hasVideo ? "" : " novid") + (l.locked ? " locked" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.m = M.m; cb.dataset.a = l.a; cb.dataset.mod = M.name; cb.dataset.les = l.name;
      if (l.locked) cb.disabled = true;          // bloqueada: nao da pra baixar
      else cb.checked = true;                    // tudo o resto (incl. sem video) marcado por padrao
      les.appendChild(cb);
      const nm = document.createElement("span");
      nm.className = "nm"; nm.textContent = `M${pad2(M.m)}A${pad2(l.a)} · ${l.name}`;
      les.appendChild(nm);
      if (l.locked) {
        const b = document.createElement("span"); b.className = "badge"; b.textContent = "bloqueada";
        les.appendChild(b);
      } else if (l.hasVideo) {
        const d = document.createElement("span"); d.className = "dur"; d.textContent = fmtDur(l.dur);
        les.appendChild(d);
      } else {
        const b = document.createElement("span"); b.className = "badge"; b.textContent = "sem vídeo";
        les.appendChild(b);
      }
      cb.addEventListener("change", () => { syncModChk(mod, M); updatePreview(); });
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
  await setReferer(true);   // regra de Referer ativa só durante o download
  const n = currentNaming();
  const opts = { folderTpl: n.folder, fileTpl: n.file, doDesc: $("#optDesc").checked,
                 doAttach: $("#optAtt").checked, prefer: $("#res").value };
  downloadCourse(jobs, DATA, opts, {
    stopped: () => dlStop,
    onUpdate: ({ done, total, current, status }) => {
      $("#dlbar").firstElementChild.style.width = (total ? Math.round(100 * done / total) : 0) + "%";
      setStatus(`${done}/${total}  ${current}${status ? " — " + status : ""}`);
    },
    onDone: async (sum) => {
      await setReferer(false);   // desliga ao terminar
      dlRunning = false; const b = $("#dlhere");
      b.textContent = "⬇ Baixar selecionadas (aqui no navegador)"; b.classList.remove("stop");
      setStatus(`Fim. vídeos=${sum.video} descrições=${sum.desc} materiais=${sum.att} bloqueadas=${sum.locked} falhas=${sum.fail}`);
    },
  });
}

async function init() {
  const rb = $("#refresh");
  if (rb) rb.addEventListener("click", () => location.reload());  // re-lê o curso da aba atual
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/(.*\.)?hotmart\.com\//.test(tab.url || "")) {
    $("#course").textContent = "Abra um curso no hotmart.com, depois clique em ↻ reler.";
    return;
  }
  let res;
  try {
    res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", files: ["extractor.js"] });
  } catch (e) { $("#course").textContent = "Falha ao ler a página: " + e.message; return; }
  const data = res && res[0] && res[0].result;
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
  $("#all").addEventListener("click", () => { document.querySelectorAll(".les input:not([disabled])").forEach((c) => c.checked = true); document.querySelectorAll(".mod").forEach((m, i) => syncModChk(m, DATA.modules[i])); updatePreview(); });
  $("#none").addEventListener("click", () => { document.querySelectorAll(".les input").forEach((c) => c.checked = false); document.querySelectorAll(".mod").forEach((m, i) => syncModChk(m, DATA.modules[i])); updatePreview(); });
  $("#go").addEventListener("click", exportJSON);
  $("#dlhere").addEventListener("click", onDownloadHere);
  updatePreview();
}
init();
