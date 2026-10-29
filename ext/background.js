// Ouvre le panneau latéral quand on clique sur l'icône de l'extension.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Première installation : page de bienvenue qui explique où trouver Convertex
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html?welcome=1") });
  }
});

// À la désinstallation, Chrome ouvre cette page pour laisser un retour.
// Aucune donnée n'est envoyée : c'est une simple page web.
chrome.runtime.setUninstallURL(
  "https://github.com/tristan-mrtn/Convertex/issues/new?title=Feedback%20after%20uninstalling&body=Why%20did%20you%20uninstall%20Convertex%3F%20Anything%20that%20did%20not%20work%3F"
);
