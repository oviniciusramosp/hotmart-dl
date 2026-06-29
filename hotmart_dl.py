#!/usr/bin/env python3
"""
hotmart-dl — baixa cursos do Hotmart Club a partir de um course.json
(gerado pela extensao de navegador deste repo).

Por aula (gap-aware: a posicao A0X e sempre a real, mesmo sem video):
  - VIDEO:     Modulo XX - Nome/MxxAyy - Nome da Aula.mp4   (HLS AES-128 via yt-dlp)
  - DESCRICAO: Modulo XX - Nome/MxxAyy - Nome da Aula.html  (texto + imagens embutidas)
  - MATERIAIS: Modulo XX - Nome/MxxAyy - <nome do anexo>    (PDFs, planilhas, etc.)

Aulas BLOQUEADAS sao puladas (nao travam o programa).

ENGENHARIA REVERSA (Hotmart Club atual):
  video:    GET /v2/web/lessons/<hash> -> medias[].url (embed assinada) -> __NEXT_DATA__
            -> mediaAssets[] (m3u8) -> yt-dlp
  descricao: o mesmo /v2/web/lessons/<hash> traz "content" (HTML)
  anexos:   GET /v1/pages/<hash>/complementary-content -> attachments[]{fileMembershipId,fileName}
            GET api-club.cb.hotmart.com/rest/v3/attachment/<fmid>/download -> {directDownloadUrl}

PRE-REQUISITOS: python3, yt-dlp, ffmpeg.

USO:
    python3 hotmart_dl.py                       # course.json mais recente de ~/Downloads
    python3 hotmart_dl.py meucurso.course.json --out "~/Downloads/Meu Curso"
    python3 hotmart_dl.py --modules 17 18 19 --resolution low
    python3 hotmart_dl.py --no-desc --no-attach # so videos
"""
import argparse, base64, glob, html, json, os, re, subprocess, sys, urllib.request, urllib.error

GW_BASE = "https://api-club-course-consumption-gateway-ga.cb.hotmart.com"
GATEWAY = GW_BASE + "/v2/web/lessons/{h}"
CC_API = GW_BASE + "/v1/pages/{h}/complementary-content"
ATT_API = "https://api-club.cb.hotmart.com/rest/v3/attachment/{fmid}/download"
EMBED_REFERER = "https://hotmart.com/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
FORBIDDEN = re.compile(r'[\\/:*?"<>|\n\r\t]')
NEXT_DATA = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
IMG_SRC = re.compile(r'src\s*=\s*"([^"]+)"', re.I)


def sanitize(name):
    name = FORBIDDEN.sub("-", str(name or "")).strip()
    name = re.sub(r"\s+", " ", name).strip(" .-")
    return name[:120] or "sem-nome"


def safe_filename(name):
    """Sanitiza preservando a extensao (pra anexos)."""
    stem, ext = os.path.splitext(str(name or ""))
    ext = FORBIDDEN.sub("", ext)[:8]
    return (sanitize(stem) + ext)[:140] or "arquivo"


def render_name(tpl, m, a, module, lesson):
    return (str(tpl)
            .replace("{mm}", f"{m:02d}").replace("{m}", str(m))
            .replace("{aa}", f"{a:02d}").replace("{a}", str(a))
            .replace("{module}", sanitize(module)).replace("{lesson}", sanitize(lesson)))


def _auth(token, pid, app):
    return {"Authorization": f"Bearer {token}", "x-product-id": str(pid),
            "x-app-name": app, "Accept": "application/json, text/plain, */*"}


def http_get(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def http_bytes(url, headers=None, timeout=180):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_lesson(h, token, pid, app):
    return json.loads(http_get(GATEWAY.format(h=h), headers=_auth(token, pid, app)))


def lesson_video_embed(lj):
    for m in (lj.get("medias") or []):
        if m.get("type") == "VIDEO" and m.get("url"):
            return m["url"]
    return None


def embed_best_m3u8(embed_url, prefer="high"):
    page = http_get(embed_url, headers={"Referer": EMBED_REFERER})
    m = NEXT_DATA.search(page)
    if not m:
        raise RuntimeError("__NEXT_DATA__ nao encontrado (layout do player mudou?)")
    data = json.loads(m.group(1))
    assets = (((data.get("props") or {}).get("pageProps") or {})
              .get("applicationData") or {}).get("mediaAssets") or []
    m3u8s = [a for a in assets if ".m3u8" in (a.get("url") or "")]
    if not m3u8s:
        raise RuntimeError("sem m3u8 em mediaAssets (DRM Widevine? so urlEncrypted)")
    m3u8s.sort(key=lambda a: a.get("height") or 0)
    chosen = m3u8s[-1] if prefer != "low" else m3u8s[0]
    return chosen["url"], chosen.get("height")


def resolve(h, token, pid, app, prefer="high"):
    embed = lesson_video_embed(fetch_lesson(h, token, pid, app))
    if not embed:
        return None, None
    return embed_best_m3u8(embed, prefer)


def fetch_attachments(h, token, pid, app):
    try:
        j = json.loads(http_get(CC_API.format(h=h), headers=_auth(token, pid, app)))
        return j.get("attachments") or []
    except Exception:
        return []


def attachment_direct_url(fmid, token, pid, app):
    j = json.loads(http_get(ATT_API.format(fmid=fmid), headers=_auth(token, pid, app)))
    return j.get("directDownloadUrl")


def save_description(content_html, title, out_path):
    """Salva a descricao como HTML auto-contido (imagens embutidas em base64)."""
    def repl(m):
        src = m.group(1)
        if src.startswith("data:"):
            return m.group(0)
        try:
            raw = http_bytes(src, timeout=40)
            ext = (src.split("?")[0].rsplit(".", 1)[-1] or "png").lower()
            ct = {"jpg": "jpeg", "jpeg": "jpeg", "png": "png", "gif": "gif",
                  "webp": "webp", "svg": "svg+xml"}.get(ext, "png")
            return f'src="data:image/{ct};base64,{base64.b64encode(raw).decode()}"'
        except Exception:
            return m.group(0)  # online fallback
    body = IMG_SRC.sub(repl, content_html or "")
    t = html.escape(title or "")
    doc = ("<!doctype html><html lang=pt-BR><head><meta charset=utf-8><title>" + t +
           "</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:820px;"
           "margin:2rem auto;padding:0 1.2rem;line-height:1.6;color:#1a1a1a}"
           "img{max-width:100%;height:auto;border-radius:8px}h1{font-size:1.5rem}</style></head>"
           "<body><h1>" + t + "</h1>" + body + "</body></html>")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    open(out_path, "w", encoding="utf-8").write(doc)


def clean_temp(out_no_ext):
    base = glob.escape(out_no_ext)
    for pat in (".mp4-Frag*", ".mp4.part", ".mp4.ytdl"):
        for p in glob.glob(base + pat):
            try:
                os.remove(p)
            except OSError:
                pass


def ytdlp(m3u8, out_no_ext):
    clean_temp(out_no_ext)
    cmd = ["yt-dlp", "--no-warnings", "--no-overwrites", "--abort-on-unavailable-fragments",
           "--add-header", f"Referer: {EMBED_REFERER}", "--merge-output-format", "mp4",
           "-o", out_no_ext + ".%(ext)s", m3u8]
    return subprocess.run(cmd).returncode == 0


def probe_dur(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=30)
        return float(out.stdout.strip())
    except Exception:
        return None


def duration_ok(path, expected):
    if not expected:
        return None
    got = probe_dur(path)
    return None if got is None else abs(got - expected) <= max(5.0, expected * 0.02)


def find_course_json():
    for c in sorted(glob.glob(os.path.expanduser("~/Downloads/*.json")), key=os.path.getmtime, reverse=True):
        try:
            d = json.load(open(c, encoding="utf-8"))
            if isinstance(d, dict) and d.get("modules") and d.get("token"):
                return c
        except Exception:
            pass
    return None


def all_lessons_iter(modules, only):
    """Todas as aulas selecionadas, com posicao real (gap-aware). Yields
    (m, mod_name, a, lesson_name, hash, dur, hasVideo, locked)."""
    for M in modules:
        if only and M["m"] not in only:
            continue
        for l in M["lessons"]:
            yield (M["m"], M["name"], l["a"], l["name"], l["hash"],
                   l.get("dur") or 0, bool(l.get("hasVideo")), bool(l.get("locked")))


def run(args):
    path = args.course or find_course_json()
    if not path or not os.path.exists(os.path.expanduser(path)):
        sys.exit("Nenhum course.json. Gere com a extensao ou passe: python3 hotmart_dl.py meucurso.course.json")
    data = json.load(open(os.path.expanduser(path), encoding="utf-8"))
    for k in ("token", "productId", "appName", "modules"):
        if not data.get(k):
            sys.exit(f"course.json invalido: falta '{k}'. Re-gere com a extensao.")
    token, pid, app = data["token"], data["productId"], data["appName"]
    out = os.path.expanduser(args.out) if args.out else \
        os.path.expanduser(os.path.join("~/Downloads", sanitize(data.get("course") or "Curso Hotmart")))
    only = set(args.modules) if args.modules else None
    naming = data.get("naming") or {}
    folder_tpl = naming.get("folder", "Modulo {mm} - {module}")
    file_tpl = naming.get("file") or "M{mm}A{aa} - {lesson}"
    prefer = args.resolution or data.get("resolution") or "high"
    opts = data.get("options") or {}
    do_desc = not args.no_desc and opts.get("descriptions", True)
    do_attach = not args.no_attach and opts.get("attachments", True)

    lessons = list(all_lessons_iter(data["modules"], only))
    if args.test:
        lessons = lessons[:1]
    print(f"Curso: {data.get('course')}  |  {len(lessons)} aula(s)  ->  {out}")
    print(f"vídeo:on  descrição:{'on' if do_desc else 'off'}  materiais:{'on' if do_attach else 'off'}\n")
    c = {"video": 0, "skip": 0, "fail": 0, "desc": 0, "att": 0, "lock": 0}
    suspeitos = []
    for m, mname, a, lname, h, dur, has_video, locked in lessons:
        tag = f"M{m:02d}A{a:02d}"
        out_dir = os.path.join(out, render_name(folder_tpl, m, a, mname, lname)) if folder_tpl.strip() else out
        base = os.path.join(out_dir, render_name(file_tpl, m, a, mname, lname))
        if locked:
            print(f"== {tag} - {lname}\n   🔒 bloqueada — pulando"); c["lock"] += 1; continue
        print(f"== {tag} - {lname}")
        try:
            lj = fetch_lesson(h, token, pid, app) if (has_video or do_desc) else None
            # VIDEO
            if has_video:
                final = base + ".mp4"
                if os.path.exists(final) and os.path.getsize(final) > 100_000:
                    clean_temp(base)
                    if duration_ok(final, dur) is False:
                        print(f"   ⚠ vídeo existe mas duração {int(probe_dur(final) or 0)}s ≠ {dur}s"); suspeitos.append(tag)
                    else:
                        print("   vídeo: já existe"); c["skip"] += 1
                else:
                    embed = lesson_video_embed(lj)
                    if not embed:
                        print("   (sem vídeo resolvível)")
                    elif args.print_only:
                        print("   m3u8 OK (--print-only)")
                    else:
                        os.makedirs(out_dir, exist_ok=True)
                        m3u8, hpx = embed_best_m3u8(embed, prefer)
                        if ytdlp(m3u8, base):
                            if duration_ok(final, dur) is False:
                                print(f"   ⚠ vídeo baixado mas duração {int(probe_dur(final) or 0)}s ≠ {dur}s"); suspeitos.append(tag)
                            else:
                                print(f"   vídeo baixado ({hpx}p)")
                            c["video"] += 1
                        else:
                            print("   ! vídeo: yt-dlp falhou"); c["fail"] += 1
            # DESCRICAO
            if do_desc and lj is not None and not args.print_only:
                content = (lj.get("content") or "").strip()
                dpath = base + ".html"
                if content and not os.path.exists(dpath):
                    save_description(content, lname, dpath)
                    print("   descrição salva (.html)"); c["desc"] += 1
            # MATERIAIS
            if do_attach and not args.print_only:
                for att in fetch_attachments(h, token, pid, app):
                    try:
                        apath = os.path.join(out_dir, f"{tag} - {safe_filename(att.get('fileName'))}")
                        if os.path.exists(apath) and abs(os.path.getsize(apath) - (att.get("fileSize") or 0)) < 2000:
                            continue
                        url = attachment_direct_url(att["fileMembershipId"], token, pid, app)
                        os.makedirs(out_dir, exist_ok=True)
                        open(apath, "wb").write(http_bytes(url))
                        print(f"   material: {safe_filename(att.get('fileName'))}"); c["att"] += 1
                    except Exception as e:
                        print(f"   ! material falhou: {str(e)[:50]}")
        except urllib.error.HTTPError as e:
            if e.code == 403:
                print("   🔒 sem acesso (bloqueada?) — pulando"); c["lock"] += 1; continue
            if e.code == 401 and not args.keep_going:
                sys.exit("Parando: token expirou (401). Re-gere o course.json com a extensão.")
            print(f"   ! HTTP {e.code}"); c["fail"] += 1
        except Exception as e:
            print(f"   ! erro: {str(e)[:80]}"); c["fail"] += 1
    print(f"\nFim. vídeos={c['video']} (pulados {c['skip']}) descrições={c['desc']} "
          f"materiais={c['att']} bloqueadas={c['lock']} falhas={c['fail']}\nArquivos em: {out}")
    if suspeitos:
        print(f"⚠ DURAÇÃO SUSPEITA em: {', '.join(suspeitos)} — apague esses .mp4 e re-rode.")
    # course.json carrega seu token de login — apaga depois que baixou tudo certo.
    if not args.print_only and not args.test and not args.keep_json and c["fail"] == 0:
        try:
            os.remove(os.path.expanduser(path))
            print(f"🧹 {os.path.basename(path)} apagado (continha seu token de login).")
        except OSError:
            pass


def self_test():
    assert not FORBIDDEN.search(sanitize('A/B: "c"? <x>'))
    assert render_name("M{mm}A{aa} - {lesson}", 7, 3, "Mod", "Aula/X") == "M07A03 - Aula-X"
    assert safe_filename("Apostila: 100%.PDF").endswith(".PDF") and "/" not in safe_filename("a/b.pdf")
    mods = [{"m": 17, "name": "M", "lessons": [
        {"a": 1, "hasVideo": True, "name": "A", "hash": "h1"},
        {"a": 2, "hasVideo": False, "name": "B", "hash": "h2"},
        {"a": 3, "hasVideo": True, "name": "C", "hash": "h3", "locked": True}]}]
    rows = list(all_lessons_iter(mods, None))
    assert [r[2] for r in rows] == [1, 2, 3]                # todas as aulas (gap incluído)
    assert rows[1][6] is False and rows[2][7] is True       # hasVideo / locked
    import tempfile
    p = os.path.join(tempfile.mkdtemp(), "d.html")
    save_description("<p>oi</p><img src=\"data:image/png;base64,iVBORw0K\">", "Título <x>", p)
    txt = open(p, encoding="utf-8").read()
    assert "<p>oi</p>" in txt and "Título &lt;x&gt;" in txt and "data:image/png" in txt
    print("self-test OK")


def main():
    ap = argparse.ArgumentParser(description="Baixa um curso do Hotmart Club (vídeo + descrição + materiais).")
    ap.add_argument("course", nargs="?", help="course.json (default: mais recente em ~/Downloads)")
    ap.add_argument("--out", help="pasta de saida (default: ~/Downloads/<nome do curso>)")
    ap.add_argument("--resolution", choices=["high", "low"], help="qualidade do vídeo (default: high)")
    ap.add_argument("--modules", type=int, nargs="+", help="so estes modulos")
    ap.add_argument("--no-desc", action="store_true", help="nao salvar descrições (.html)")
    ap.add_argument("--no-attach", action="store_true", help="nao baixar materiais (anexos)")
    ap.add_argument("--test", action="store_true", help="processa so a 1a aula")
    ap.add_argument("--print-only", action="store_true", help="resolve o m3u8 mas nao baixa")
    ap.add_argument("--keep-going", action="store_true", help="nao parar em 401")
    ap.add_argument("--keep-json", action="store_true", help="nao apagar o course.json no fim (mantem o token)")
    ap.add_argument("--serve", action="store_true", help="abre o app local (dashboard de fila + progresso)")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if args.serve:
        import serve
        return serve.main(args.course)
    run(args)


if __name__ == "__main__":
    main()
