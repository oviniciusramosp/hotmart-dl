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
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue, Empty

import hotmart_dl as core

PORT = 8765
COURSE = {}
ITEMS = []            # fila: cada item = dict com status/pct/...
SETTINGS = {"out": "", "resolution": "high"}
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
            if not l.get("hasVideo"):
                continue
            ITEMS.append({"i": i, "m": M["m"], "mname": M["name"], "a": l["a"],
                          "lname": l["name"], "hash": l["hash"], "dur": l.get("dur") or 0,
                          "status": "fila", "pct": 0, "hpx": None})
            i += 1
    STATE["total"] = len(ITEMS)
    STATE["done"] = sum(1 for it in ITEMS if it["status"] == "ok")


def snapshot():
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
        for it in ITEMS:
            if STOP:
                break
            if it["status"] == "ok":
                continue
            m, a, mname, lname = it["m"], it["a"], it["mname"], it["lname"]
            out_dir = os.path.join(out, core.render_name(folder_tpl, m, a, mname, lname)) if folder_tpl.strip() else out
            out_no_ext = os.path.join(out_dir, core.render_name(file_tpl, m, a, mname, lname))
            final = out_no_ext + ".mp4"
            if os.path.exists(final) and os.path.getsize(final) > 100_000:
                core.clean_temp(out_no_ext)
                set_item(it, status="ok", pct=100); STATE["done"] += 1; broadcast(); continue
            try:
                set_item(it, status="resolvendo", pct=0)
                m3u8, hpx = core.resolve(it["hash"], token, pid, app, prefer)
                if not m3u8:
                    set_item(it, status="sem-video"); continue
                set_item(it, status="baixando", hpx=hpx)
                os.makedirs(out_dir, exist_ok=True)
                ok = run_ytdlp_progress(m3u8, out_no_ext, it)
                if ok and core.duration_ok(final, it["dur"]) is False:
                    set_item(it, status="suspeito", pct=100)
                elif ok:
                    set_item(it, status="ok", pct=100); STATE["done"] += 1
                else:
                    set_item(it, status="erro", pct=0)
            except Exception as e:
                msg = str(e)
                set_item(it, status="erro", err=msg[:80])
                if "401" in msg or "403" in msg:
                    break  # sessao expirou
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
.s-erro{background:#3a1f24;color:#ff8a8a}.s-suspeito{background:#3a3320;color:#f0c777}.s-sem-video{background:#23262f;color:#6b7280}
.dur{color:#7c8597;font-size:12px;font-variant-numeric:tabular-nums;min-width:44px;text-align:right}
.tag{color:#7c8597;font-size:12px;min-width:62px}
</style></head><body><div class=wrap>
<h1>hotmart-dl</h1><div class=sub id=course>carregando…</div>
<div class=bar><i id=overall></i></div>
<div class=ctl>
  <label class=fld>Pasta de saída<input id=out></label>
  <label class=fld>Resolução<select id=res><option value=high>Mais alta</option><option value=low>Mais baixa</option></select></label>
  <button id=go>Baixar</button><button id=stop disabled>Parar</button>
  <span id=counts class=sub style="margin-left:auto"></span>
</div>
<div id=queue></div>
</div><script>
const $=s=>document.querySelector(s);
let booted=false;
function render(d){
  $('#course').textContent=(d.course||'Curso')+' — '+d.state.total+' vídeos';
  if(!booted){booted=true;$('#out').value=d.settings.out;$('#res').value=d.settings.resolution;}
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
    r.innerHTML='<span class=tag>'+tag+(it.hpx?' · '+it.hpx+'p':'')+'</span>'+
      '<span class=nm></span>'+
      (showPb?'<span class=pb><i style="width:'+it.pct+'%"></i></span>':'')+
      '<span class="st s-'+it.status+'">'+(it.status==='baixando'?it.pct+'%':it.status)+'</span>'+
      '<span class=dur>'+fmt(it.dur)+'</span>';
    r.querySelector('.nm').textContent=it.lname;
    q.appendChild(r);
  }
}
const es=new EventSource('/api/events');es.onmessage=e=>render(JSON.parse(e.data));
$('#go').onclick=()=>fetch('/api/start',{method:'POST',body:JSON.stringify({out:$('#out').value,resolution:$('#res').value})});
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
