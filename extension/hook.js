// Roda no MAIN world em document_start. Captura x-app-name / x-product-id
// dos proprios XHR do app do Hotmart (esses headers sao injetados por interceptor,
// entao precisamos ve-los acontecer). Guarda em window.__hotmartMeta pro extract.js ler.
(function () {
  if (window.__hotmartHooked) return;
  window.__hotmartHooked = true;
  window.__hotmartMeta = window.__hotmartMeta || {};
  var osh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      var kl = String(k).toLowerCase();
      if (kl === "x-app-name") window.__hotmartMeta.appName = v;
      else if (kl === "x-product-id") window.__hotmartMeta.productId = v;
    } catch (e) {}
    return osh.apply(this, arguments);
  };
})();
