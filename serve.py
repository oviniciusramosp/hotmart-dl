#!/usr/bin/env python3
"""
hotmart-dl — modo app local (dashboard no navegador).

    python3 serve.py                  # usa o course.json mais recente de ~/Downloads
    python3 serve.py meucurso.course.json

Abre http://127.0.0.1:8765 com: fila de aulas, progresso ao vivo por aula,
campo de pasta de saída e escolha de resolução (alta/baixa). O download roda
em segundo plano; a tela acompanha via SSE.
"""
import html as _html
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue, Empty

import hotmart_dl as core

TERMINAL = {"ok", "suspeito", "bloqueada", "sem-conteudo", "erro"}
_BC_LOCK = threading.Lock()
_BC_LAST = [0.0]

PORT = 8765
COURSE = {}
ITEMS = []            # fila: cada item = dict com status/pct/...
SETTINGS = {"out": "", "resolution": "high", "descriptions": True, "attachments": True}
STATE = {"running": False, "done": 0, "total": 0}
SUBS = []             # filas dos clientes SSE
CUR_PROC = None
STOP = False
LOCK = threading.Lock()


def build_items():
    ITEMS.clear()
    i = 0
    for M in COURSE.get("modules", []):
        for l in M["lessons"]:
            ITEMS.append({"i": i, "m": M["m"], "mname": M["name"], "a": l["a"],
                          "lname": l["name"], "hash": l["hash"], "dur": l.get("dur") or 0,
                          "hasVideo": bool(l.get("hasVideo")), "locked": bool(l.get("locked")),
                          "tdesc": None, "tattach": None, "scanned": False,
                          "status": "fila", "pct": 0, "hpx": None, "extra": ""})
            i += 1
    STATE["total"] = len(ITEMS)


def snapshot():
    STATE["done"] = sum(1 for it in ITEMS if it["status"] in TERMINAL)
    return json.dumps({"course": COURSE.get("course"), "settings": SETTINGS,
                       "state": STATE, "items": ITEMS})


def broadcast():
    data = snapshot()
    for q in list(SUBS):
        try:
            q.put_nowait(data)
        except Exception:
            pass


def set_item(it, **kw):
    it.update(kw)
    broadcast()


def throttled_broadcast():
    with _BC_LOCK:
        now = time.time()
        if now - _BC_LAST[0] < 0.3:
            return
        _BC_LAST[0] = now
    broadcast()


def scan_one(it, token, pid, app):
    if it["locked"]:
        it["scanned"] = True
        return
    try:
        lj = core.fetch_lesson(it["hash"], token, pid, app)
        it["tdesc"] = bool((lj.get("content") or "").strip())
    except Exception:
        it["tdesc"] = None
    try:
        it["tattach"] = len(core.fetch_attachments(it["hash"], token, pid, app))
    except Exception:
        it["tattach"] = 0
    it["scanned"] = True
    throttled_broadcast()


def scan_all():
    """Em background: descobre quais aulas têm descrição/material pra mostrar os selos."""
    try:
        token, pid, app = COURSE["token"], COURSE["productId"], COURSE["appName"]
        todo = [it for it in ITEMS if not it.get("scanned")]
        with ThreadPoolExecutor(max_workers=6) as ex:
            list(ex.map(lambda it: scan_one(it, token, pid, app), todo))
    except Exception:
        pass
    broadcast()


def run_ytdlp_progress(m3u8, out_no_ext, it):
    global CUR_PROC
    core.clean_temp(out_no_ext)
    cmd = ["yt-dlp", "--newline", "--no-warnings", "--no-overwrites",
           "--abort-on-unavailable-fragments",
           "--progress-template", "JLPCT:%(progress._percent_str)s",
           "--add-header", f"Referer: {core.EMBED_REFERER}",
           "--merge-output-format", "mp4",
           "-o", out_no_ext + ".%(ext)s", m3u8]
    CUR_PROC = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    last = 0
    for line in CUR_PROC.stdout:
        mm = re.search(r"JLPCT:\s*([\d.]+)%", line)
        if mm:
            p = round(float(mm.group(1)))
            if p != last:
                last = p
                set_item(it, pct=p)
    CUR_PROC.wait()
    rc = CUR_PROC.returncode
    CUR_PROC = None
    return rc == 0


def worker():
    global STOP
    try:
        token, pid, app = COURSE["token"], COURSE["productId"], COURSE["appName"]
        naming = COURSE.get("naming") or {}
        folder_tpl = naming.get("folder", "Modulo {mm} - {module}")
        file_tpl = naming.get("file") or "M{mm}A{aa} - {lesson}"
        out = os.path.expanduser(SETTINGS["out"])
        prefer = SETTINGS["resolution"]
        do_desc, do_att = SETTINGS.get("descriptions", True), SETTINGS.get("attachments", True)
        for it in ITEMS:
            if STOP:
                break
            if it["status"] in ("ok", "bloqueada"):
                continue
            m, a, mname, lname = it["m"], it["a"], it["mname"], it["lname"]
            tag = f"M{m:02d}A{a:02d}"
            out_dir = os.path.join(out, core.render_name(folder_tpl, m, a, mname, lname)) if folder_tpl.strip() else out
            base = os.path.join(out_dir, core.render_name(file_tpl, m, a, mname, lname))
            if it["locked"]:
                set_item(it, status="bloqueada"); continue
            try:
                set_item(it, status="resolvendo", pct=0)
                lj = core.fetch_lesson(it["hash"], token, pid, app) if (it["hasVideo"] or do_desc) else None
                extras, suspeito = [], False
                if it["hasVideo"]:
                    final = base + ".mp4"
                    if os.path.exists(final) and os.path.getsize(final) > 100_000:
                        core.clean_temp(base); it["pct"] = 100
                    else:
                        embed = core.lesson_video_embed(lj)
                        if embed:
                            m3u8, hpx = core.embed_best_m3u8(embed, prefer)
                            set_item(it, status="baixando", hpx=hpx)
                            os.makedirs(out_dir, exist_ok=True)
                            if not run_ytdlp_progress(m3u8, base, it):
                                set_item(it, status="erro"); continue
                            suspeito = core.duration_ok(final, it["dur"]) is False
                if do_desc and lj is not None:
                    content = (lj.get("content") or "").strip()
                    if content and not os.path.exists(base + ".html"):
                        core.save_description(content, lname, base + ".html"); extras.append("descrição")
                if do_att:
                    for att in core.fetch_attachments(it["hash"], token, pid, app):
                        try:
                            apath = os.path.join(out_dir, f"{tag} - {core.safe_filename(att.get('fileName'))}")
                            if os.path.exists(apath) and abs(os.path.getsize(apath) - (att.get("fileSize") or 0)) < 2000:
                                continue
                            url = core.attachment_direct_url(att["fileMembershipId"], token, pid, app)
                            os.makedirs(out_dir, exist_ok=True)
                            open(apath, "wb").write(core.http_bytes(url))
                            extras.append("material")
                        except Exception:
                            pass
                did = it["hasVideo"] or extras
                st = "suspeito" if suspeito else ("ok" if did else "sem-conteudo")
                set_item(it, status=st, pct=100 if it["hasVideo"] else 0, extra=", ".join(sorted(set(extras))))
            except urllib.error.HTTPError as e:
                if e.code == 403:
                    set_item(it, status="bloqueada"); continue
                set_item(it, status="erro", extra=f"HTTP {e.code}")
                if e.code == 401:
                    break  # token expirou
            except Exception as e:
                set_item(it, status="erro", extra=str(e)[:50])
    finally:
        STATE["running"] = False
        STOP = False
        broadcast()


def start():
    global STOP
    with LOCK:
        if STATE["running"]:
            return
        STOP = False
        STATE["running"] = True
        STATE["done"] = sum(1 for it in ITEMS if it["status"] == "ok")
    threading.Thread(target=worker, daemon=True).start()
    broadcast()


def stop():
    global STOP
    STOP = True
    if CUR_PROC:
        try:
            CUR_PROC.terminate()
        except Exception:
            pass


PAGE = """<!DOCTYPE html><html lang=pt-BR><head><meta charset=utf-8>
<title>hotmart-dl</title><style>
*{box-sizing:border-box}body{margin:0;background:#0f1116;color:#e7e9ee;font:14px/1.5 -apple-system,system-ui,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:18px}
h1{font-size:17px;font-weight:600;margin:0}.sub{color:#9aa3b2;font-size:13px;margin:2px 0 0}
.bar{height:8px;background:#1b1e26;border-radius:6px;overflow:hidden;margin:10px 0}
.bar>i{display:block;height:100%;background:#4f8cff;width:0;transition:width .2s}
.ctl{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:14px 0;padding:12px;background:#16181d;border:1px solid #2a2e37;border-radius:10px}
.fld{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#9aa3b2}
input,select{background:#0f1116;color:#e7e9ee;border:1px solid #2a2e37;border-radius:7px;padding:7px 9px;font:inherit}
input#out{width:340px}
button{border:0;border-radius:8px;padding:8px 14px;font:600 13px inherit;cursor:pointer}
#go{background:#4f8cff;color:#fff}#stop{background:#3a2730;color:#ff9a9a}button:disabled{opacity:.5;cursor:default}
.mod{margin:10px 0 4px;color:#9aa3b2;font-size:12px;font-weight:600}
.row{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid #1f232c;border-radius:8px;margin:4px 0;background:#14161b}
.row .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .pb{width:120px;height:6px;background:#1b1e26;border-radius:4px;overflow:hidden}
.row .pb>i{display:block;height:100%;background:#4f8cff;width:0}
.st{font-size:11px;padding:2px 7px;border-radius:6px;min-width:74px;text-align:center}
.s-fila{background:#23262f;color:#9aa3b2}.s-resolvendo{background:#2a2740;color:#b9a8ff}
.s-baixando{background:#10233f;color:#7fb0ff}.s-ok{background:#11321f;color:#6ee7a8}
.s-erro{background:#3a1f24;color:#ff8a8a}.s-suspeito{background:#3a3320;color:#f0c777}
.s-bloqueada{background:#2a2330;color:#c79be0}.s-sem-conteudo{background:#23262f;color:#6b7280}
.extra{color:#7c8597;font-size:11px;white-space:nowrap}
.tgl{display:flex;align-items:center;gap:6px;font-size:12px;color:#9aa3b2;cursor:pointer}.tgl input{width:auto}
.dur{color:#7c8597;font-size:12px;font-variant-numeric:tabular-nums;min-width:44px;text-align:right}
.tag{color:#7c8597;font-size:12px;min-width:62px}
.types{display:flex;gap:4px}
.chip{font-size:10px;padding:1px 6px;border-radius:5px;white-space:nowrap}
.cv{background:#10233f;color:#7fb0ff}.cd{background:#0f2b24;color:#6ee7a8}.cm{background:#332a12;color:#f0c777}.cs{background:#1b1e26;color:#5a6172}
</style></head><body><div class=wrap>
<h1>hotmart-dl</h1><div class=sub id=course>carregando…</div>
<div class=bar><i id=overall></i></div>
<div class=ctl>
  <label class=fld>Pasta de saída<input id=out></label>
  <label class=fld>Resolução<select id=res><option value=high>Mais alta</option><option value=low>Mais baixa</option></select></label>
  <label class=tgl><input type=checkbox id=desc checked>Descrições</label>
  <label class=tgl><input type=checkbox id=att checked>Materiais</label>
  <button id=go>Baixar</button><button id=stop disabled>Parar</button>
  <span id=counts class=sub style="margin-left:auto"></span>
</div>
<div id=queue></div>
</div><script>
const $=s=>document.querySelector(s);
let booted=false;
function render(d){
  $('#course').textContent=(d.course||'Curso')+' — '+d.state.total+' aulas';
  if(!booted){booted=true;$('#out').value=d.settings.out;$('#res').value=d.settings.resolution;$('#desc').checked=d.settings.descriptions;$('#att').checked=d.settings.attachments;}
  const pct=d.state.total?Math.round(100*d.state.done/d.state.total):0;
  $('#overall').style.width=pct+'%';
  $('#counts').textContent=d.state.done+' / '+d.state.total+' concluídos'+(d.state.running?' · baixando…':'');
  $('#go').disabled=d.state.running;$('#stop').disabled=!d.state.running;
  const q=$('#queue');q.innerHTML='';let curMod=null;
  const fmt=s=>s?Math.floor(s/60)+':'+String(Math.round(s%60)).padStart(2,'0'):'';
  for(const it of d.items){
    if(it.m!==curMod){curMod=it.m;const h=document.createElement('div');h.className='mod';h.textContent='Módulo '+String(it.m).padStart(2,'0')+' · '+it.mname;q.appendChild(h);}
    const r=document.createElement('div');r.className='row';
    const tag='M'+String(it.m).padStart(2,'0')+'A'+String(it.a).padStart(2,'0');
    const showPb=it.status==='baixando';
    let types='';
    if(it.hasVideo) types+='<span class="chip cv">vídeo</span>';
    if(it.tdesc) types+='<span class="chip cd">desc</span>';
    if(it.tattach>0) types+='<span class="chip cm">'+(it.tattach>1?it.tattach+' ':'')+'material</span>';
    if(!it.scanned && !it.locked) types+='<span class="chip cs">…</span>';
    r.innerHTML='<span class=tag>'+tag+(it.hpx?' · '+it.hpx+'p':'')+'</span>'+
      '<span class=nm></span>'+
      '<span class=types>'+types+'</span>'+
      (showPb?'<span class=pb><i style="width:'+it.pct+'%"></i></span>':'')+
      '<span class="st s-'+it.status+'">'+(it.status==='baixando'?it.pct+'%':it.status)+'</span>'+
      '<span class=dur>'+(it.hasVideo?fmt(it.dur):'')+'</span>';
    r.querySelector('.nm').textContent=it.lname;
    q.appendChild(r);
  }
}
const es=new EventSource('/api/events');es.onmessage=e=>render(JSON.parse(e.data));
$('#go').onclick=()=>fetch('/api/start',{method:'POST',body:JSON.stringify({out:$('#out').value,resolution:$('#res').value,descriptions:$('#desc').checked,attachments:$('#att').checked})});
$('#stop').onclick=()=>fetch('/api/stop',{method:'POST'});
fetch('/api/state').then(r=>r.json()).then(render);
</script></body></html>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/":
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if self.path == "/api/state":
            return self._send(200, snapshot())
        if self.path == "/api/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            q = Queue()
            SUBS.append(q)
            try:
                self.wfile.write(b"data: " + snapshot().encode() + b"\n\n")
                self.wfile.flush()
                while True:
                    try:
                        data = q.get(timeout=20)
                        self.wfile.write(b"data: " + data.encode() + b"\n\n")
                    except Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except Exception:
                pass
            finally:
                if q in SUBS:
                    SUBS.remove(q)
            return
        return self._send(404, "{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode() if n else "{}"
        if self.path == "/api/start":
            try:
                cfg = json.loads(body)
                if cfg.get("out"):
                    SETTINGS["out"] = cfg["out"]
                if cfg.get("resolution") in ("high", "low"):
                    SETTINGS["resolution"] = cfg["resolution"]
                SETTINGS["descriptions"] = bool(cfg.get("descriptions", True))
                SETTINGS["attachments"] = bool(cfg.get("attachments", True))
            except Exception:
                pass
            start()
            return self._send(200, "{\"ok\":true}")
        if self.path == "/api/stop":
            stop()
            return self._send(200, "{\"ok\":true}")
        return self._send(404, "{}")


def main(path=None):
    path = path or (sys.argv[1] if len(sys.argv) > 1 else None) or core.find_course_json()
    if not path or not os.path.exists(os.path.expanduser(path)):
        sys.exit("Nenhum course.json. Gere pela extensão ou passe o caminho: python3 serve.py meucurso.course.json")
    global COURSE
    COURSE = json.load(open(os.path.expanduser(path), encoding="utf-8"))
    SETTINGS["out"] = os.path.expanduser(os.path.join("~/Downloads", core.sanitize(COURSE.get("course") or "Curso Hotmart")))
    SETTINGS["resolution"] = COURSE.get("resolution") or "high"
    build_items()
    threading.Thread(target=scan_all, daemon=True).start()  # descobre desc/material p/ os selos
    url = f"http://127.0.0.1:{PORT}"
    print(f"hotmart-dl rodando em {url}  (Ctrl+C pra sair)")
    if not os.environ.get("HOTMART_NO_BROWSER"):
        try:
            webbrowser.open(url)
        except Exception:
            pass
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()


if __name__ == "__main__":
    main()
