// Opens the app in a normal tab when the toolbar icon is clicked.
// If a tab with the app is already open, focuses it instead of opening a
// second copy.
//
// Chrome/Edge only expose the `chrome` namespace; Firefox exposes both
// `browser` (promise-based) and `chrome` (callback-based). Using `chrome.*`
// with promises works on modern versions of both.
const api = typeof browser !== "undefined" ? browser : chrome;

api.action.onClicked.addListener(async () => {
  const appUrl = api.runtime.getURL("landingsite.html");
  const existing = await api.tabs.query({ url: api.runtime.getURL("*") });

  if (existing.length) {
    await api.tabs.update(existing[0].id, { active: true });
    await api.windows.update(existing[0].windowId, { focused: true });
    return;
  }

  await api.tabs.create({ url: appUrl });
});