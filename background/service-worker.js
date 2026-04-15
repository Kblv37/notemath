const COMMAND_MAP = {
  "add-to-total": "add",
  "subtract-from-total": "subtract",
};

function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    if (id == null) return;
    chrome.tabs.sendMessage(id, message).catch(() => {});
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-panel") {
    sendToActiveTab({ type: "TOGGLE_PANEL", source: "command" });
    return;
  }
  const op = COMMAND_MAP[command];
  if (!op) return;
  sendToActiveTab({ type: "RUN_OPERATION", source: "command", op });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
