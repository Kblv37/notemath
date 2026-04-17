(function (root) {
  const STORAGE_KEY = "pagecalc_v1";

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
      displayDecimals: null,
      initialized: false,
      history: [],
      notes: "",
      replySnapshots: [],
      calcDraft: "",
    };
  }

  function defaultSettings() {
    return {
      theme: "system",
      uiLocale: "browser",
      showPanel: true,                
      panelPinned: false,
      panelMinimized: false,
      panelPosition: { right: 16, bottom: 16 },
      fallbackHotkeys: true,             
      allowInInputs: false,              
      showToast: false,                 
      showCalculator: true,             
      calculatorCollapsed: false,
      notesCollapsed: false,
      showSessionTabs: false,             
      showNotes: true,
      smartCopyPanel: defaultSmartCopyPanel(),
      tabsLayout: "horizontal",
      historyLimit: 200,
      panelStartup: "remember",          
      hotkeyDebounceMs: 140,
      uiScale: 1.0,
    };
  }

  function defaultState() {
    const s = defaultSession("Default");
    return {
      version: 3,
      activeSessionId: s.id,
      sessions: [s],
      settings: defaultSettings(),
      lastCopiedValue: "",
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

  function defaultSmartCopyPanel() {
    return {
      enabled: true,                    
      defaultOp: "add",
      interceptCtrlV: true,
      fallbackAltV: true,
      buttons: {
        add: true,
        subtract: true,                   
        multiply: false,                 
        divide: false,                    
      },
      autoHideEnabled: true,
      autoHideMs: 6,
    };
  }

  function normalizeSmartCopyPanel(panel) {
    const defaults = defaultSmartCopyPanel();
    const src = panel && typeof panel === "object" ? panel : {};
    const buttons = Object.assign({}, defaults.buttons, src.buttons || {});
    const autoHideMs = Math.max(1, Math.min(20, Number(src.autoHideMs) || defaults.autoHideMs));
    const op = String(src.defaultOp || defaults.defaultOp);
    const allowedOps = { add: 1, subtract: 1, multiply: 1, divide: 1 };
    return {
      enabled: src.enabled !== false,
      defaultOp: allowedOps[op] ? op : defaults.defaultOp,
      interceptCtrlV: src.interceptCtrlV !== false,
      fallbackAltV: src.fallbackAltV !== false,
      buttons: {
        add: buttons.add !== false,
        subtract: buttons.subtract !== false,
        multiply: buttons.multiply !== false,
        divide: buttons.divide !== false,
      },
      autoHideEnabled: src.autoHideEnabled !== false,
      autoHideMs,
    };
  }

  function normalizeSettings(settings) {
    const next = Object.assign(defaultSettings(), settings || {});
    next.smartCopyPanel = normalizeSmartCopyPanel(next.smartCopyPanel);
    return next;
  }

  function clearRedoStack(state, sessionId) {
    if (!state.redoStacks) state.redoStacks = {};
    state.redoStacks[sessionId] = [];
  }

  function migrateState(state) {
    if (!state || typeof state !== "object") return defaultState();
    const ver = state.version | 0;
    if (ver < 2) {
      if (!state.redoStacks) state.redoStacks = {};
      if (Array.isArray(state.sessions)) {
        state.sessions.forEach((se) => {
          if (se.notes == null) se.notes = "";
          if (!Array.isArray(se.replySnapshots)) se.replySnapshots = [];
        });
      }
    }
    if (ver < 3) {
      state.version = 3;
      if (!state.sessions) state.sessions = [];
      state.sessions.forEach((se) => {
        if (se.displayDecimals == null) se.displayDecimals = null;
      });
      state.settings = normalizeSettings(state.settings);
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
    state.settings = normalizeSettings(state.settings);
    if (!state.disabledHosts) state.disabledHosts = {};
    if (!state.undoStacks) state.undoStacks = {};
    if (!state.redoStacks) state.redoStacks = {};
    if (state.lastCopiedValue == null) state.lastCopiedValue = "";
    migrateState(state);
    state.sessions.forEach((se) => {
      if (!Array.isArray(se.history)) se.history = [];
      if (typeof se.initialized !== "boolean") se.initialized = se.total != null;
      if (se.total != null && typeof se.total !== "number") se.total = Number(se.total);
      if (se.displayDecimals == null) se.displayDecimals = null;
      else se.displayDecimals = Math.max(0, Math.min(12, Number(se.displayDecimals) || 0));
      if (se.notes == null) se.notes = "";
      if (!Array.isArray(se.replySnapshots)) se.replySnapshots = [];
      if (se.calcDraft == null) se.calcDraft = "";
    });
    if (state.lastCopiedValue == null) state.lastCopiedValue = "";
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

  function serializeSettings(state) {
    return JSON.stringify(state.settings, null, 2);
  }

  function parseSettingsJson(text) {
    const t = String(text).replace(/^\uFEFF/, "").trim();
    const o = JSON.parse(t);
    if (!o || typeof o !== "object") throw new Error("BAD_SETTINGS");
    return normalizeSettings(o);
  }

  root.CalcStorageModel = {
    STORAGE_KEY,
    isExtensionContextValid,
    defaultState,
    defaultSettings,
    defaultSession,
    defaultSmartCopyPanel,
    newId,
    loadState,
    saveState,
    ensureUndoStack,
    ensureRedoStack,
    clearRedoStack,
    normalizeSettings,
    serializeSettings,
    parseSettingsJson,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
