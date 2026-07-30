// Opens the app in its own standalone popup window when the toolbar icon
// is clicked. If that window is already open, focuses it instead of
// opening a second copy.
//
// Chrome/Edge only expose the `chrome` namespace; Firefox exposes both
// `browser` (promise-based) and `chrome` (callback-based). Using `chrome.*`
// with promises works on modern versions of both.
const api = typeof browser !== "undefined" ? browser : chrome;

let appWindowId = null;

api.action.onClicked.addListener(async () => {
  const appUrl = api.runtime.getURL("landingsite.html");

  // If we already have a window open and it still exists, just focus it.
  if (appWindowId !== null) {
    try {
      await api.windows.update(appWindowId, { focused: true });
      return;
    } catch (e) {
      // Window was closed by the user; fall through and open a new one.
      appWindowId = null;
    }
  }

  const win = await api.windows.create({
    url: appUrl,
    type: "popup", // no tab strip / address bar — feels like a standalone app
    width: 1000,
    height: 700
  });

  appWindowId = win.id;
});

// Clear our tracked window id if the user closes it, so the next click
// opens a fresh window instead of trying to focus a stale id.
api.windows.onRemoved.addListener((closedWindowId) => {
  if (closedWindowId === appWindowId) {
    appWindowId = null;
  }
});