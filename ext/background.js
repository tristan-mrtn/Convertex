// Ouvre le panneau latéral quand on clique sur l'icône de l'extension.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));
