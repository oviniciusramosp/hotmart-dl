// Abre o PAINEL LATERAL ao clicar no ícone (não fecha ao clicar fora).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// chrome.downloads ignora o filename quando a URL é blob: (usa o UUID do blob).
// Então o painel manda o nome desejado por mensagem e nós o aplicamos via
// onDeterminingFilename (a forma robusta de nomear downloads de blob).
const pendingNames = new Map(); // blobUrl -> filename relativo

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "hmFilename" && msg.url && msg.filename) {
    pendingNames.set(msg.url, msg.filename);
    sendResponse({ ok: true });
  }
  return true;
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const f = pendingNames.get(item.url);
  if (f) {
    pendingNames.delete(item.url);
    suggest({ filename: f, conflictAction: "overwrite" });
  } else {
    suggest();
  }
});
