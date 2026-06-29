# hotmart-dl

Baixe cursos que **você comprou** no **Hotmart Club** para assistir offline — organizados em pastas por módulo, com nomes limpos e numeração que respeita aulas sem vídeo.

```
Meu Curso/
├── Modulo 01 - Introdução/
│   ├── M01A01 - Boas-vindas.mp4
│   └── M01A03 - Primeiros passos.mp4      ← A02 é texto (sem vídeo): número reservado
└── Modulo 02 - Fundamentos/
    └── M02A01 - ...
```

Funciona em **qualquer curso** do Hotmart Club. Duas peças:

1. **Extensão de navegador** (Dia/Chrome/Brave): na página do curso, um clique exporta um `course.json` com a estrutura do curso + a sua sessão.
2. **CLI Python** (`hotmart_dl.py`): lê o `course.json` e baixa tudo com `yt-dlp` (decifra o HLS AES‑128 nativamente).

> ⚠️ **Uso pessoal.** Use apenas em cursos aos quais você tem acesso legítimo, para assistir offline. Não redistribua o conteúdo. Cursos com DRM Widevine não são suportados (e não devem ser contornados).

---

## Pré‑requisitos

```bash
brew install yt-dlp ffmpeg python    # macOS
```

## 1) Instalar a extensão (uma vez)

1. Baixe/clone este repo.
2. No navegador, abra a página de extensões (`chrome://extensions`), ligue **Modo do desenvolvedor**.
3. **Carregar sem compactação** (Load unpacked) → selecione a pasta **`extension/`**.

## 2) Exportar o curso

1. Abra o curso no Hotmart Club, **logado**, dentro de uma aula (`/club/<sub>/products/<id>/content/...`).
2. Clique no ícone da extensão **“Exportar curso Hotmart”**.
3. Um arquivo `<subdomínio>.course.json` é baixado para `~/Downloads`. (Aparece um aviso verde com a contagem de módulos/vídeos.)

## 3) Baixar

```bash
python3 hotmart_dl.py                       # usa o course.json mais recente de ~/Downloads
python3 hotmart_dl.py meucurso.course.json  # ou aponte o arquivo
python3 hotmart_dl.py --modules 17 18 19    # só alguns módulos
python3 hotmart_dl.py --out "~/Downloads/Meu Curso"
python3 hotmart_dl.py --test                # baixa só a 1ª aula, pra validar
```

Re‑rodar **continua de onde parou** (pula MP4 já completos). Se aparecer **HTTP 401/403**, a sessão expirou: clique na extensão de novo pra gerar um `course.json` novo e re‑rode.

---

## Como funciona (engenharia reversa do Hotmart Club, 2026)

A extensão lê, na página: o token de sessão (`localStorage.token`), `productId`/`subdomínio` (da URL), `x-app-name` (interceptando os XHR do app) e a **árvore do curso** direto da memória React (módulos, aulas, `hash`, `hasPlayerMedia`, duração).

O CLI, por aula com vídeo, resolve a stream **na hora** (porque os links assinados expiram em ~8 min):

```
GET /v2/web/lessons/<hash>            (Authorization: Bearer <token>, x-product-id, x-app-name)
    → medias[].url  = embed assinada  (cf-embed.play.hotmart.com/embed/<code>?jwtToken=…)
GET <embed>  → HTML → __NEXT_DATA__ → applicationData.mediaAssets[]  (m3u8 por qualidade)
yt-dlp <m3u8 melhor qualidade>        → baixa + decifra AES-128 → mp4
```

`x-app-name` muda quando o Hotmart atualiza o app do Club; a extensão captura o valor atual automaticamente, então nada fica hardcoded.

## Formato do `course.json`

```json
{
  "course": "Nome do Curso",
  "subdomain": "padocadoalex",
  "productId": "5693452",
  "appName": "app-club-consumer_vX.Y.Z_production",
  "token": "<bearer jwt da sua sessão>",
  "modules": [
    { "m": 1, "name": "Módulo 1", "lessons": [
      { "a": 1, "name": "Aula 1", "hash": "abc123", "hasVideo": true, "dur": 155 }
    ]}
  ]
}
```

O `token` é a **sua** sessão e fica só na sua máquina. Apague o `course.json` quando terminar.

## Roadmap

- [ ] Empacotar o CLI num app de macOS (drag‑and‑drop do `course.json`) ou Native Messaging pra disparar o download direto da extensão.
- [ ] Baixar anexos/PDFs das aulas.

## Licença

MIT — veja [LICENSE](LICENSE).
