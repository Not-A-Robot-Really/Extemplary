const api = typeof browser !== "undefined" ? browser : chrome;

let appWindowId = null;

api.action.onClicked.addListener(async () => {
  const appUrl = api.runtime.getURL("landingsite.html");

  if (appWindowId !== null) {
    try {
      await api.windows.update(appWindowId, { focused: true });
      return;
    } catch (e) {
      appWindowId = null;
    }
  }

  const win = await api.windows.create({
    url: appUrl,
    type: "popup",
    width: 1000,
    height: 700
  });

  appWindowId = win.id;
});

api.windows.onRemoved.addListener((closedWindowId) => {
  if (closedWindowId === appWindowId) {
    appWindowId = null;
  }
});