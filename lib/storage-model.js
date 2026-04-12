(function (root) {
  const STORAGE_KEY = "NoteMath_v1";

  /**
   * True while this JS world may call chrome.* (MV3: orphaned content scripts after reload/update).
   * `chrome.runtime.id` alone is unreliable — it can still be readable briefly while other APIs throw.
   * `getURL` performs a real extension API round-trip and throws once the context is invalidated.
   */
  function isExtensionContextValid() {
    try {
      const url = chrome.runtime.getURL("popup/popup.html");
      return typeof url === "string" && url.length > 0;
    } catch {
      return false;
    }
  }

  function isContextInvalidatedError(err) {
    const m = String(err?.message ?? err ?? "");
    return m.includes("Extension context invalidated");
  }

  function newId() {
    return "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function defaultSession(name) {
    return {
      id: newId(),
      name: name || "Default",
      total: null,
      initialized: false,
      history: [],
      notes: "",
      replySnapshots: [],
      /** Единая строка ввода калькулятора (синхрон с полем результата) */
      calcDraft: "",
    };
  }

  function defaultSettings() {
    return {
      theme: "system",
      uiLocale: "browser",
      showPanel: false,
      panelPinned: false,
      panelMinimized: false,
      panelPosition: { right: 16, bottom: 16 },
      fallbackHotkeys: true,
      allowInInputs: false,
      showToast: true,
      showCalculator: true,
      calculatorCollapsed: false,
      notesCollapsed: false,
      /** Показывать блок вкладок сессий (можно скрыть в настройках) */
      showSessionTabs: true,
      /** Заметки под историей */
      showNotes: true,
      tabsLayout: "horizontal",
      historyLimit: 200,
      /** remember | show | hide — видимость панели при загрузке страницы */
      panelStartup: "hide",
      hotkeyDebounceMs: 140,
    };
  }

  function defaultState() {
    const s = defaultSession("Default");
    return {
      version: 2,
      activeSessionId: s.id,
      sessions: [s],
      settings: defaultSettings(),
      disabledHosts: {},
      undoStacks: {},
      redoStacks: {},
    };
  }

  function ensureUndoStack(state, sessionId) {
    if (!state.undoStacks) state.undoStacks = {};
    if (!state.undoStacks[sessionId]) state.undoStacks[sessionId] = [];
    return state.undoStacks[sessionId];
  }

  function ensureRedoStack(state, sessionId) {
    if (!state.redoStacks) state.redoStacks = {};
    if (!state.redoStacks[sessionId]) state.redoStacks[sessionId] = [];
    return state.redoStacks[sessionId];
  }

  function clearRedoStack(state, sessionId) {
    if (!state.redoStacks) state.redoStacks = {};
    state.redoStacks[sessionId] = [];
  }

  function migrateState(state) {
    if (!state || typeof state !== "object") return defaultState();
    const ver = state.version | 0;
    if (ver < 2) {
      state.version = 2;
      if (!state.redoStacks) state.redoStacks = {};
      state.sessions.forEach((se) => {
        if (se.notes == null) se.notes = "";
        if (!Array.isArray(se.replySnapshots)) se.replySnapshots = [];
      });
    }
    return state;
  }

  async function loadState() {
    if (!isExtensionContextValid()) {
      const e = new Error("Extension context invalidated");
      e.code = "CONTEXT_INVALIDATED";
      throw e;
    }
    let data;
    try {
      data = await chrome.storage.local.get(STORAGE_KEY);
    } catch (err) {
      if (isContextInvalidatedError(err) || !isExtensionContextValid()) {
        const e = err instanceof Error ? err : new Error(String(err));
        e.code = "CONTEXT_INVALIDATED";
        throw e;
      }
      throw err;
    }
    let state = data[STORAGE_KEY];
    if (!state || typeof state !== "object") state = defaultState();
    if (!Array.isArray(state.sessions) || state.sessions.length === 0) {
      const s = defaultSession("Default");
      state.sessions = [s];
      state.activeSessionId = s.id;
    }
    state.settings = Object.assign(defaultSettings(), state.settings || {});
    if (!state.disabledHosts) state.disabledHosts = {};
    if (!state.undoStacks) state.undoStacks = {};
    if (!state.redoStacks) state.redoStacks = {};
    migrateState(state);
    state.sessions.forEach((se) => {
      if (!Array.isArray(se.history)) se.history = [];
      if (typeof se.initialized !== "boolean") se.initialized = se.total != null;
      if (se.total != null && typeof se.total !== "number") se.total = Number(se.total);
      if (se.notes == null) se.notes = "";
      if (!Array.isArray(se.replySnapshots)) se.replySnapshots = [];
      if (se.calcDraft == null) se.calcDraft = "";
    });
    return state;
  }

  async function saveState(state) {
    if (!isExtensionContextValid()) return;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
    } catch (err) {
      if (isContextInvalidatedError(err) || !isExtensionContextValid()) return;
      throw err;
    }
  }

  /** Export only settings (for TXT backup). */
  function serializeSettings(state) {
    return JSON.stringify(state.settings, null, 2);
  }

  function parseSettingsJson(text) {
    const t = String(text).replace(/^\uFEFF/, "").trim();
    const o = JSON.parse(t);
    if (!o || typeof o !== "object") throw new Error("BAD_SETTINGS");
    return Object.assign(defaultSettings(), o);
  }

  root.CalcStorageModel = {
    STORAGE_KEY,
    isExtensionContextValid,
    defaultState,
    defaultSettings,
    defaultSession,
    newId,
    loadState,
    saveState,
    ensureUndoStack,
    ensureRedoStack,
    clearRedoStack,
    serializeSettings,
    parseSettingsJson,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
