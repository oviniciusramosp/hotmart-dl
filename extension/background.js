// Ao clicar no icone da extensao numa aba do Hotmart, injeta o extract.js no MAIN
// world da pagina (onde vivem o token, a memoria React e o hook de headers).
chrome.action.onClicked.addListener(function (tab) {
  if (!tab.id || !/^https:\/\/(.*\.)?hotmart\.com\//.test(tab.url || "")) {
    chrome.action.setTitle({ tabId: tab.id, title: "Abra um curso no hotmart.com primeiro" });
    return;
  }
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    files: ["extract.js"]
  });
});
