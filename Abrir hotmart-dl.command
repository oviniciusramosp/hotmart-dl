#!/bin/bash
# Dê DOIS CLIQUES neste arquivo (no Finder) pra abrir o hotmart-dl.
# Ele sobe o app e abre o dashboard no seu navegador — sem digitar nada.
cd "$(dirname "$0")" || exit 1
echo "Abrindo o hotmart-dl... a interface vai aparecer no navegador."
echo "(deixe esta janela aberta enquanto baixa; feche pra encerrar)"
exec python3 serve.py
