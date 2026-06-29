#!/usr/bin/env python3
"""
hotmart-dl — baixa cursos do Hotmart Club a partir de um course.json
(gerado pela extensao de navegador deste repo), com nomeacao gap-aware:

    Modulo XX - Nome do Modulo/MxxAyy - Nome da Aula.mp4

Aula sem video RESERVA o numero (M17A02 sem video -> existe M17A01 e M17A03).

COMO FUNCIONA (engenharia reversa do Hotmart Club atual):
  1) GET /v2/web/lessons/<hash>  (Authorization: Bearer <token>, x-product-id, x-app-name)
       -> medias[].url = embed ASSINADA (cf-embed.play.hotmart.com/embed/<code>?jwtToken=...)
  2) GET <embed> -> HTML -> __NEXT_DATA__ -> applicationData.mediaAssets[] (m3u8 por qualidade)
  3) yt-dlp <m3u8 melhor qualidade> -> baixa + decifra AES-128 -> mp4

Como os links de segmento expiram em ~8 min, cada aula e resolvida no momento de baixar.

PRE-REQUISITOS: python3, yt-dlp, ffmpeg.   (brew install yt-dlp ffmpeg)

USO:
    # pega o course.json mais recente em ~/Downloads automaticamente:
    python3 hotmart_dl.py
    # ou aponte o arquivo / saida / modulos:
    python3 hotmart_dl.py meucurso.course.json --out "~/Downloads/Meu Curso"
    python3 hotmart_dl.py --modules 17 18 19
"""
import argparse, glob, json, os, re, subprocess, sys, urllib.request, urllib.error

GATEWAY = "https://api-club-course-consumption-gateway-ga.cb.hotmart.com/v2/web/lessons/{h}"
EMBED_REFERER = "https://hotmart.com/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
FORBIDDEN = re.compile(r'[\\/:*?"<>|\n\r\t]')
NEXT_DATA = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)


def sanitize(name):
    name = FORBIDDEN.sub("-", str(name or "")).strip()
    name = re.sub(r"\s+", " ", name).strip(" .-")
    return name[:120] or "sem-nome"


def http_get(url, headers=None, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def lesson_embed_url(h, token, product_id, app_name):
    body = http_get(GATEWAY.format(h=h), headers={
        "Authorization": f"Bearer {token}",
        "x-product-id": str(product_id),
        "x-app-name": app_name,
        "Accept": "application/json, text/plain, */*"})
    j = json.loads(body)
    for m in (j.get("medias") or []):
        if m.get("type") == "VIDEO" and m.get("url"):
            return m["url"]
    return None


def embed_best_m3u8(embed_url):
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
    m3u8s.sort(key=lambda a: a.get("height") or 0, reverse=True)
    return m3u8s[0]["url"], m3u8s[0].get("height")


def resolve(h, token, product_id, app_name):
    embed = lesson_embed_url(h, token, product_id, app_name)
    if not embed:
        return None, None
    return embed_best_m3u8(embed)


def clean_temp(out_no_ext):
    # remove temporarios orfaos do yt-dlp (sobram quando um download e interrompido):
    # <nome>.mp4-FragN, .mp4.part, .mp4.ytdl
    base = glob.escape(out_no_ext)
    for pat in (".mp4-Frag*", ".mp4.part", ".mp4.ytdl"):
        for p in glob.glob(base + pat):
            try:
                os.remove(p)
            except OSError:
                pass


def ytdlp(m3u8, out_no_ext):
    clean_temp(out_no_ext)  # começa limpo (links assinados mudam a cada resolve; não dá pra resumir frag antigo)
    cmd = ["yt-dlp", "--no-warnings", "--no-overwrites",
           "--add-header", f"Referer: {EMBED_REFERER}",
           "--merge-output-format", "mp4",
           "-o", out_no_ext + ".%(ext)s", m3u8]
    return subprocess.run(cmd).returncode == 0


def find_course_json():
    cands = sorted(glob.glob(os.path.expanduser("~/Downloads/*.json")),
                   key=os.path.getmtime, reverse=True)
    for c in cands:
        try:
            d = json.load(open(c, encoding="utf-8"))
            if isinstance(d, dict) and d.get("modules") and d.get("token"):
                return c
        except Exception:
            pass
    return None


def jobs_iter(modules, only):
    """Gera (m, mod_name, a, lesson_name, hash) so de aulas com video; posicao = a (gap-aware)."""
    for M in modules:
        if only and M["m"] not in only:
            continue
        for l in M["lessons"]:
            if l.get("hasVideo"):
                yield M["m"], M["name"], l["a"], l["name"], l["hash"]


def run(args):
    path = args.course or find_course_json()
    if not path or not os.path.exists(path):
        sys.exit("Nenhum course.json encontrado. Gere com a extensao (clique nela na pagina do curso) "
                 "ou passe o caminho: python3 hotmart_dl.py meucurso.course.json")
    data = json.load(open(os.path.expanduser(path), encoding="utf-8"))
    for k in ("token", "productId", "appName", "modules"):
        if not data.get(k):
            sys.exit(f"course.json invalido: falta '{k}'. Re-gere com a extensao.")
    token, pid, app = data["token"], data["productId"], data["appName"]
    out = os.path.expanduser(args.out) if args.out else \
        os.path.expanduser(os.path.join("~/Downloads", sanitize(data.get("course") or "Curso Hotmart")))
    only = set(args.modules) if args.modules else None

    jobs = list(jobs_iter(data["modules"], only))
    if args.test:
        jobs = jobs[:1]
    print(f"Curso: {data.get('course')}  |  {len(jobs)} aula(s) com video  ->  {out}\n")
    ok = skip = fail = 0
    for m, mname, a, lname, h in jobs:
        tag = f"M{m:02d}A{a:02d}"
        out_dir = os.path.join(out, f"Modulo {m:02d} - {sanitize(mname)}")
        out_no_ext = os.path.join(out_dir, f"{tag} - {sanitize(lname)}")
        if os.path.exists(out_no_ext + ".mp4") and os.path.getsize(out_no_ext + ".mp4") > 100_000:
            clean_temp(out_no_ext)  # varre orfaos ao lado de um arquivo ja pronto
            print(f"== {tag} - {lname}\n   ja existe — pulando"); skip += 1; continue
        print(f"== {tag} - {lname}")
        try:
            m3u8, hpx = resolve(h, token, pid, app)
            if not m3u8:
                print("   (sem video — pulando)"); skip += 1; continue
            if args.print_only:
                print(f"   m3u8 {hpx}p OK (--print-only)"); ok += 1; continue
            os.makedirs(out_dir, exist_ok=True)
            if ytdlp(m3u8, out_no_ext):
                print(f"   baixado ({hpx}p)"); ok += 1
            else:
                print("   ! yt-dlp falhou"); fail += 1
        except urllib.error.HTTPError as e:
            print(f"   ! HTTP {e.code} — token expirou? re-gere o course.json com a extensao.")
            if e.code in (401, 403) and not args.keep_going:
                sys.exit("Parando: sessao invalida.")
            fail += 1
        except Exception as e:
            print(f"   ! erro: {e}"); fail += 1
    print(f"\nFim. ok={ok} pulados={skip} falhas={fail}\nArquivos em: {out}")


def self_test():
    assert not FORBIDDEN.search(sanitize('A/B: "c"? <x>'))
    sample = ('<script id="__NEXT_DATA__" type="application/json">' + json.dumps(
        {"props": {"pageProps": {"applicationData": {"mediaAssets": [
            {"url": "https://x/360.m3u8", "height": 360},
            {"url": "https://x/1080.m3u8", "height": 1080}]}}}}) + '</script>')
    m = NEXT_DATA.search(sample)
    a = json.loads(m.group(1))["props"]["pageProps"]["applicationData"]["mediaAssets"]
    a = sorted([x for x in a if ".m3u8" in x["url"]], key=lambda x: x["height"], reverse=True)
    assert a[0]["height"] == 1080
    mods = [{"m": 17, "name": "M", "lessons": [
        {"a": 1, "hasVideo": True, "name": "A", "hash": "h1"},
        {"a": 2, "hasVideo": False, "name": "B", "hash": "h2"},
        {"a": 3, "hasVideo": True, "name": "C", "hash": "h3"}]}]
    assert [j[2] for j in jobs_iter(mods, None)] == [1, 3]  # A02 pulada, gap preservado
    print("self-test OK")


def main():
    ap = argparse.ArgumentParser(description="Baixa um curso do Hotmart Club a partir de um course.json.")
    ap.add_argument("course", nargs="?", help="course.json (default: mais recente em ~/Downloads)")
    ap.add_argument("--out", help="pasta de saida (default: ~/Downloads/<nome do curso>)")
    ap.add_argument("--modules", type=int, nargs="+", help="so estes modulos (ex: 17 18 19)")
    ap.add_argument("--test", action="store_true", help="baixa so a 1a aula")
    ap.add_argument("--print-only", action="store_true", help="resolve o m3u8 mas nao baixa")
    ap.add_argument("--keep-going", action="store_true", help="nao parar em 401/403")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    run(args)


if __name__ == "__main__":
    main()
