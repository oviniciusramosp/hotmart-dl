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

## 2) Escolher e exportar (UI)

1. Abra o curso no Hotmart Club, **logado**, dentro de uma aula (`/club/<sub>/products/<id>/content/...`).
2. Clique no ícone da extensão. O popup mostra o curso que ele encontrou:
   - **árvore de módulos/aulas** com checkboxes (vídeos já marcados; aulas sem vídeo aparecem como “sem vídeo”);
   - **padrão de nome** (presets ou template personalizado) com pré-visualização ao vivo;
   - botões **Marcar todos / Nenhum** e seleção por módulo.
3. Marque o que quer, escolha o padrão e clique **Exportar seleção** → baixa um `<subdomínio>.course.json` para `~/Downloads`.

Padrões de nome disponíveis (ou crie o seu com `{mm} {aa} {module} {lesson}`):

| Preset | Resultado |
|---|---|
| Módulo + M00A00 *(padrão)* | `Modulo 17 - Pães/M17A03 - Batimento.mp4` |
| Módulo + 00 - título | `Modulo 17 - Pães/03 - Batimento.mp4` |
| Pasta do módulo + título | `Pães/Batimento.mp4` |
| Tudo numa pasta + M00A00 | `M17A03 - Batimento.mp4` |

## 3) Baixar

Duas formas — o padrão de nome escolhido na extensão vai no `course.json` e é aplicado nas duas.

### a) App local com dashboard (recomendado)

```bash
python3 serve.py            # ou: python3 hotmart_dl.py --serve
```

Abre `http://127.0.0.1:8765` com:
- **fila** de todas as aulas (agrupadas por módulo);
- **progresso ao vivo** por aula (barra + %) e barra geral;
- campo de **pasta de saída** e seletor de **resolução** (mais alta / mais baixa);
- botões **Baixar / Parar**. Re-rodar continua de onde parou.

### b) Terminal

```bash
python3 hotmart_dl.py                          # course.json mais recente de ~/Downloads
python3 hotmart_dl.py meucurso.course.json
python3 hotmart_dl.py --out "~/Downloads/Meu Curso" --resolution low
python3 hotmart_dl.py --modules 17 18 19       # filtro extra de módulos
python3 hotmart_dl.py --test                   # só a 1ª aula, pra validar
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
  "naming": { "folder": "Modulo {mm} - {module}", "file": "M{mm}A{aa} - {lesson}" },
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
