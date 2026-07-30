// NOTE: This file opens the app in a normal tab when the toolbar icon is clicked.
// If the tab already has the app already open, it just uses that instead of opening a
// second copy of the app.
browser.action.onClicked.addListener(async () => {
  const appUrl = browser.runtime.getURL("landingsite.html");
  const existing = await browser.tabs.query({ url: browser.runtime.getURL("*") });
 
  if (existing.length) {
    await browser.tabs.update(existing[0].id, { active: true });
    await browser.windows.update(existing[0].windowId, { focused: true });
    return;
  }
 
  await browser.tabs.create({ url: appUrl });
});