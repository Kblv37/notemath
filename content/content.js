(function () {
  const { parseOperand, evaluateExpression } = CalcParser;
  const {
    loadState,
    saveState,
    ensureUndoStack,
    ensureRedoStack,
    clearRedoStack,
    defaultSession,
    newId,
    isExtensionContextValid,
  } = CalcStorageModel;

  const MSG = (k) => {
    try {
      return chrome.i18n.getMessage(k) || k;
    } catch {
      return k;
    }
  };

  let state = null;
  let host = null;
  let shadow = null;
  let toastHost = null;
  let toastShadow = null;
  let dragState = null;
  let saveTimer = null;
  let hotkeyTimer = null;
  let pendingHotkeyOp = null;
  let hotkeySeq = 0;
  let smartCopyCopySeq = 0;
  let clipboardFlashUntil = 0;
  let disposed = false;
  let panelKeydownBound = false;
  let themeMediaQuery = null;
  let dragRaf = null;
  const isTopFrame = window.top === window;

  function isContextInvalidatedError(err) {
    return err?.code === "CONTEXT_INVALIDATED" || String(err?.message ?? err).includes("Extension context invalidated");
  }

  function persistStateToStorage() {
    if (!state || disposed) return;
    void saveState(state).catch((err) => {
      if (isContextInvalidatedError(err) || !isExtensionContextValid()) disposeContentUi();
    });
  }

  function disposeContentUi() {
    if (disposed) return;
    disposed = true;
    clearTimeout(saveTimer);
    clearTimeout(hotkeyTimer);
    clearTimeout(toastTimer);
    if (dragRaf != null) {
      cancelAnimationFrame(dragRaf);
      dragRaf = null;
    }
    saveTimer = hotkeyTimer = toastTimer = null;
    dragState = null;
    try {
      chrome.storage.onChanged.removeListener(onChromeStorageChanged);
    } catch {
    }
    try {
      chrome.runtime.onMessage.removeListener(onChromeRuntimeMessage);
    } catch {
    }
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("copy", captureCopiedText, true);
    window.removeEventListener("resize", onWindowResize);
    window.removeEventListener("click", onWindowClickForMenu, true);
    if (themeMediaQuery) {
      try {
        themeMediaQuery.removeEventListener("change", onThemeMediaChange);
      } catch {
      }
      themeMediaQuery = null;
    }
    try {
      host?.remove();
    } catch {
    }
    try {
      toastHost?.remove();
    } catch {
    }
    window.removeEventListener("mousemove", onDragMove, true);
    window.removeEventListener("mouseup", onDragEnd, true);
    host = null;
    shadow = null;
    toastHost = null;
    toastShadow = null;
    state = null;
    panelKeydownBound = false;
  }

  function onChromeStorageChanged(changes, area) {
    if (disposed) return;
    if (!isExtensionContextValid()) {
      disposeContentUi();
      return;
    }
    if (area !== "local" || !changes[CalcStorageModel.STORAGE_KEY]) return;
    const nv = changes[CalcStorageModel.STORAGE_KEY].newValue;
    if (nv) {
      state = nv;
      migrateIfNeeded();
      renderPanel();
    }
  }

  function onChromeRuntimeMessage(msg, _s, sendResponse) {
    if (disposed) return false;
    if (!isExtensionContextValid()) {
      disposeContentUi();
      return false;
    }
    const r = onMessage(msg);
    if (r && typeof r.then === "function") {
      r.then(sendResponse).catch((err) => {
        if (isContextInvalidatedError(err) || !isExtensionContextValid()) disposeContentUi();
        try {
          sendResponse(null);
        } catch {
        }
      });
      return true;
    }
    return false;
  }

  function onWindowResize() {
    if (disposed) return;
    try {
      if (shadow?.getElementById("pc-more-menu")?.classList.contains("open")) positionMoreMenu();
    } catch {
    }
  }

  function onWindowClickForMenu(e) {
    if (!isTopFrame) return;
    if (!host) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (!path.includes(host)) closeMoreMenu();
  }

  function onThemeMediaChange() {
    if (disposed || !isExtensionContextValid()) return;
    renderPanel();
  }

  function debouncedSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistStateToStorage();
    }, 120);
  }

  function activeSession() {
    if (!state) return null;
    return state.sessions.find((s) => s.id === state.activeSessionId) || state.sessions[0];
  }

  function hostname() {
    try {
      return location.hostname || "";
    } catch {
      return "";
    }
  }

  function isRestrictedPage() {
    const p = location.protocol || "";
    const h = location.hostname || "";
    const ct = String(document.contentType || "").toLowerCase();
    if (ct.includes("pdf")) return false;
    if (
      p === "chrome-extension:" ||
      p === "chrome:" ||
      p === "edge:" ||
      p === "about:" ||
      p === "moz-extension:" ||
      p === "devtools:" ||
      p === "opera:"
    )
      return true;
    if (h === "chrome.google.com" || h === "chromewebstore.google.com") return true;
    return false;
  }

  function isSiteDisabled() {
    const h = hostname();
    return !!(h && state?.disabledHosts?.[h]);
  }

  function isEditableFocused() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const t = el.type || "text";
      if (["text", "search", "email", "url", "tel", "number", "password"].includes(t)) return true;
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function isFocusInsidePanel() {
    const el = document.activeElement;
    return !!(el && host && host.contains(el));
  }

  function getSelectionText() {
    function readSelectionFrom(win, depth) {
      if (!win || depth > 4) return "";
      try {
        const sel = win.getSelection?.();
        const text = sel ? String(sel.toString()).trim() : "";
        if (text) return text;
      } catch {
      }
      try {
        const docSel = win.document?.getSelection?.();
        const text = docSel ? String(docSel.toString()).trim() : "";
        if (text) return text;
      } catch {
      }
      try {
        const frames = win.frames;
        for (let i = 0; i < frames.length; i++) {
          const text = readSelectionFrom(frames[i], depth + 1);
          if (text) return text;
        }
      } catch {
      }
      return "";
    }

    return readSelectionFrom(window, 0);
  }

  function formatNumber(n) {
    return CalcMath?.formatNumber ? CalcMath.formatNumber(n) : String(n);
  }

  function formatPlain(n) {
    return String(n);
  }

  function formatNumberSpaced(n) {
    if (n == null || !Number.isFinite(n)) return "";
    const neg = n < 0;
    const raw = formatPlain(neg ? -n : n);
    const dot = raw.indexOf(".");
    const intPart = dot >= 0 ? raw.slice(0, dot) : raw;
    const frac = dot >= 0 ? raw.slice(dot) : "";
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return (neg ? "−" : "") + grouped + frac;
  }

  function sessionDisplayDecimals(sess) {
    return Number.isInteger(sess?.displayDecimals) && sess.displayDecimals >= 0 ? sess.displayDecimals : null;
  }

  function setSessionResult(sess, value, precision) {
    if (!sess) return;
    sess.total = value;
    sess.displayDecimals = Number.isInteger(precision) ? Math.max(0, Math.min(CalcMath.MAX_DECIMALS, precision)) : null;
  }

  function normalizeFloatResult(value, minimumDecimals) {
    return CalcMath.safeFloatResult(value, minimumDecimals, CalcMath.MAX_DECIMALS);
  }

  function parseSmartCopyValue(raw, ctxTotal) {
    const text = String(raw ?? "").trim();
    if (!text) return null;
    let value;
    try {
      value = parseOperand(text, ctxTotal);
    } catch {
      return null;
    }
    if (!Number.isFinite(value)) return null;
    const precisionHint = CalcMath.decimalPlacesFromText(text);
    const normalized = normalizeFloatResult(value, precisionHint);
    return {
      raw: text,
      value: normalized.value,
      precision: normalized.precision,
    };
  }

  function smartCopySettings() {
    return state?.settings?.smartCopyPanel || CalcStorageModel.defaultSettings().smartCopyPanel;
  }

  function normalizeSmartCopyOp(op) {
    return ["add", "subtract", "multiply", "divide"].includes(op) ? op : "add";
  }

  function smartCopyEnabled() {
    return smartCopySettings().enabled !== false;
  }

  function smartCopyButtons() {
    const buttons = smartCopySettings().buttons || {};
    return [
      { op: "add", label: "+", title: MSG("smartCopyAdd") },
      { op: "subtract", label: "−", title: MSG("smartCopySubtract") },
      { op: "multiply", label: "×", title: MSG("smartCopyMultiply") },
      { op: "divide", label: "÷", title: MSG("smartCopyDivide") },
    ].filter((btn) => buttons[btn.op] !== false);
  }

  function smartCopyEnabledOnPage() {
    return smartCopyEnabled() && !isSiteDisabled();
  }

  function clipboardRawValue() {
    return String(state?.lastCopiedValue ?? "");
  }

  function parseClipboardValue(sess, rawValue) {
    const raw = String(rawValue ?? clipboardRawValue());
    if (!raw.trim()) return null;
    return parseSmartCopyValue(raw, sess?.total);
  }

  function clipboardStatus(sess, rawValue) {
    const raw = String(rawValue ?? clipboardRawValue());
    if (!raw.trim()) return "empty";
    return parseClipboardValue(sess, raw) ? "valid" : "invalid";
  }

  function updateClipboardInputVisual(rawValue, pulse) {
    const inp = shadow && shadow.getElementById("pc-clip-input");
    if (!inp) return;
    const status = clipboardStatus(activeSession(), rawValue);
    inp.classList.remove("state-empty", "state-valid", "state-invalid", "pulse");
    inp.classList.add(`state-${status}`);
    if (pulse) {
      void inp.offsetWidth;
      inp.classList.add("pulse");
    }
  }

  async function readClipboardTextSafe() {
    const delays = [0, 36, 72];
    let last = "";
    for (let i = 0; i < delays.length; i++) {
      const delay = delays[i];
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      try {
        const text = await navigator.clipboard.readText();
        if (String(text || "").trim()) return text;
        last = text || "";
      } catch {
      }
    }
    return last;
  }

  function syncMainInputFromClipboard(parsed) {
    const sess = activeSession();
    if (!sess) return;
    const inp = getMainInput();
    const text = formatNumber(parsed.value, parsed.precision);
    sess.calcDraft = text;
    if (inp) {
      inp.value = text;
      syncDisplaySubline();
    }
    debouncedSave();
  }

  async function captureCopiedText() {
    if (!smartCopyEnabledOnPage()) return;
    const seq = ++smartCopyCopySeq;
    let text = "";
    try {
      text = await readClipboardTextSafe();
    } catch {
      try {
        text = getSelectionText();
      } catch {
      }
    }
    if (seq !== smartCopyCopySeq || disposed || !state) return;
    state.lastCopiedValue = String(text || "").trim();
    clipboardFlashUntil = Date.now() + 700;
    debouncedSave();
    renderPanel();
  }

  function shouldInterceptSmartCopyPaste(ev) {
    if (!smartCopyEnabledOnPage()) return false;
    if (!effectiveShowPanel()) return false;
    const settings = smartCopySettings();
    const key = String(ev.key || "").toLowerCase();
    const ctrlPaste = settings.interceptCtrlV !== false && (ev.ctrlKey || ev.metaKey) && !ev.altKey && key === "v";
    const altPaste = settings.fallbackAltV !== false && ev.altKey && !ev.ctrlKey && !ev.metaKey && key === "v";
    return ctrlPaste || altPaste;
  }

  function handleSmartCopyPaste(ev) {
    if (!shouldInterceptSmartCopyPaste(ev)) return false;
    if (isEditableFocused()) return false;
    ev.preventDefault();
    ev.stopPropagation();

    void (async () => {
      const seq = ++smartCopyCopySeq;
      let text = "";
      try {
        text = await readClipboardTextSafe();
      } catch {
        text = "";
      }
      if (disposed || seq !== smartCopyCopySeq) return;
      const parsed = parseSmartCopyValue(text, activeSession()?.total);
      if (!state) return;
      state.lastCopiedValue = String(text || "").trim();
      clipboardFlashUntil = Date.now() + 700;
      debouncedSave();
      renderPanel();
      if (!parsed) {
        showToast(MSG("smartCopyNoValue"), "error");
        return;
      }
      syncMainInputFromClipboard(parsed);
    })();
    return true;
  }

  /**
   * Used by UI buttons (clip-block ops, Enter in clip-input).
   * Reads operand from the clip-input DOM field, falls back to state.lastCopiedValue.
   */
  function applySmartCopyOperation(op) {
    if (!smartCopyEnabledOnPage()) return;
    const sess = activeSession();
    // Prefer the value currently shown in the clip-input over raw state
    const clipInp = shadow && shadow.getElementById("pc-clip-input");
    const rawFromInput = clipInp ? clipInp.value : null;
    const raw = rawFromInput != null ? rawFromInput : clipboardRawValue();
    if (raw !== null && raw !== undefined && raw !== clipboardRawValue()) {
      state.lastCopiedValue = raw;
    }
    const parsed = parseClipboardValue(sess, raw);
    if (!parsed || !Number.isFinite(parsed.value)) {
      showToast(MSG("smartCopyNoValue"), "error");
      return;
    }
    applyOperation(normalizeSmartCopyOp(op), parsed.raw, {
      value: parsed.value,
      precision: parsed.precision,
    });
  }

  /**
   * Used by keyboard hotkeys (Alt+A / Alt+S) and the chrome.commands API.
   * Reads operand ONLY from the current page text selection — never from clipboard.
   */
  function applySelectionOperation(op) {
    const raw = getSelectionText();
    if (!raw) {
      showToast(MSG("errNoSelection"), "error");
      return;
    }
    applyOperation(normalizeSmartCopyOp(op), raw, null);
  }

  async function refreshClipboardFromSystem() {
    const seq = ++smartCopyCopySeq;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      throw new Error("clipboard_read_failed");
    }
    if (seq !== smartCopyCopySeq || disposed || !state) return;
    state.lastCopiedValue = String(text || "").trim();
    clipboardFlashUntil = Date.now() + 700;
    debouncedSave();
    renderPanel();
  }

  function previewNumericValue(sess, raw) {
    const t = String(raw ?? "").trim();
    if (!t) {
      if (sess?.initialized && sess.total != null && Number.isFinite(sess.total)) return sess.total;
      return null;
    }
    try {
      return parseOperand(t, sess?.total);
    } catch {
      return null;
    }
  }

  function syncDisplaySubline() {
    const sub = shadow && shadow.getElementById("pc-display-sub");
    if (!sub) return;
    const sess = activeSession();
    const inp = getMainInput();
    const draft = inp ? inp.value : sess?.calcDraft ?? "";
    const v = previewNumericValue(sess, draft);
    sub.textContent = v != null && Number.isFinite(v) ? formatNumberSpaced(v) : "";
  }

  function getCalcDraft(sess) {
    if (!sess) return "";
    if (sess.calcDraft != null && String(sess.calcDraft).length) return String(sess.calcDraft);
    if (sess.initialized && sess.total != null && Number.isFinite(sess.total)) return formatPlain(sess.total);
    return "";
  }

  function setDraftFromTotal(sess) {
    if (!sess) return;
    if (sess.initialized && sess.total != null && Number.isFinite(sess.total)) sess.calcDraft = formatPlain(sess.total);
    else sess.calcDraft = "";
  }

  function getSessionPrecision(sess) {
    return sessionDisplayDecimals(sess);
  }

  function trimHistory(sess) {
    const lim = Math.max(10, Math.min(5000, state.settings.historyLimit | 0 || 200));
    if (sess.history.length > lim) {
      sess.history.splice(0, sess.history.length - lim);
    }
  }

  function snapshotSession(sess) {
    return {
      total: sess.total,
      displayDecimals: sess.displayDecimals,
      initialized: sess.initialized,
      history: sess.history.map((h) => Object.assign({}, h)),
      calcDraft: sess.calcDraft != null ? String(sess.calcDraft) : "",
    };
  }

  function pushUndo(sess) {
    const stack = ensureUndoStack(state, sess.id);
    stack.push(snapshotSession(sess));
    if (stack.length > 80) stack.shift();
  }

  function effectiveShowPanel() {
    if (!state) return false;
    const mode = state.settings.panelStartup || "remember";
    if (mode === "show") return state.settings.showPanel !== false;
    return !!state.settings.showPanel;
  }

  function openPanel() {
    if (!state) return;
    state.settings.showPanel = true;
    debouncedSave();
    renderPanel();
  }

  function togglePanelVisible() {
    if (!state) return;
    state.settings.showPanel = !effectiveShowPanel();
    debouncedSave();
    renderPanel();
  }

  function applyOperation(op, rawOverride, meta) {
    if (!["add", "subtract", "multiply", "divide"].includes(op)) return;
    const sess = activeSession();
    if (!sess) return;
    clearRedoStack(state, sess.id);

    const raw = rawOverride != null ? String(rawOverride).trim() : getSelectionText();
    if (!raw) {
      showToast(MSG("errNoSelection"), "error");
      return;
    }
    let operand;
    try {
      operand = parseOperand(raw, sess.total);
    } catch {
      showToast(MSG("errNoNumber"), "error");
      return;
    }
    if (!Number.isFinite(operand)) {
      showToast(MSG("errNoNumber"), "error");
      return;
    }

    pushUndo(sess);

    const currentPrecision = getSessionPrecision(sess);
    const operandPrecision =
      meta && Number.isInteger(meta.precision)
        ? Math.max(0, Math.min(CalcMath.MAX_DECIMALS, meta.precision))
        : CalcMath.decimalPlacesFromText(raw);
    const basePrecision = Math.max(currentPrecision ?? 0, operandPrecision ?? 0);
    const symMap = {
      add: "+",
      subtract: "−",
      multiply: "×",
      divide: "÷",
    };
    const sym = symMap[op];
    let label = "";
    let nextTotal;
    let precision = basePrecision;

    if (!sess.initialized) {
      if (op === "subtract") {
        nextTotal = 0 - operand;
      } else {
        nextTotal = operand;
      }
      sess.initialized = true;
    } else {
      const cur = sess.total;
      if (op === "add") nextTotal = cur + operand;
      else if (op === "subtract") nextTotal = cur - operand;
      else if (op === "multiply") nextTotal = cur * operand;
      else nextTotal = operand === 0 ? NaN : cur / operand;
    }

    const normalized = normalizeFloatResult(nextTotal, precision);
    precision = normalized.precision;
    nextTotal = normalized.value;

    if (!Number.isFinite(nextTotal)) {
      showToast(op === "divide" && operand === 0 ? MSG("errDivZero") : MSG("errNoNumber"), "error");
      ensureUndoStack(state, sess.id).pop();
      return;
    }

    setSessionResult(sess, nextTotal, precision);
    label = `${sym}${formatNumber(operand, operandPrecision ?? precision)}`;
    sess.history.push({
      op,
      label,
      operand,
      raw,
      result: nextTotal,
      precision,
      t: Date.now(),
    });
    trimHistory(sess);
    sess.calcDraft = formatNumber(nextTotal, precision);
    debouncedSave();
    renderPanel();
    showToast(`${label} → ${formatNumber(nextTotal, precision)}`, "ok");
  }

  function undoLast() {
    const sess = activeSession();
    if (!sess) return;
    const stack = ensureUndoStack(state, sess.id);
    const prev = stack.pop();
    if (!prev) {
      showToast("—", "muted");
      return;
    }
    const redo = ensureRedoStack(state, sess.id);
    redo.push(snapshotSession(sess));
    sess.total = prev.total;
    sess.displayDecimals = prev.displayDecimals ?? null;
    sess.initialized = prev.initialized;
    sess.history = prev.history;
    sess.calcDraft = prev.calcDraft != null ? prev.calcDraft : "";
    debouncedSave();
    renderPanel();
    showToast(MSG("undo"), "ok");
  }

  function redoLast() {
    const sess = activeSession();
    if (!sess) return;
    const stack = ensureRedoStack(state, sess.id);
    const next = stack.pop();
    if (!next) {
      showToast("—", "muted");
      return;
    }
    pushUndo(sess);
    sess.total = next.total;
    sess.displayDecimals = next.displayDecimals ?? null;
    sess.initialized = next.initialized;
    sess.history = next.history;
    sess.calcDraft = next.calcDraft != null ? next.calcDraft : "";
    debouncedSave();
    renderPanel();
    showToast(MSG("redo"), "ok");
  }

  function resetSession() {
    const sess = activeSession();
    if (!sess) return;
    clearRedoStack(state, sess.id);
    pushUndo(sess);
    sess.total = null;
    sess.displayDecimals = null;
    sess.initialized = false;
    sess.history = [];
    sess.calcDraft = "";
    debouncedSave();
    renderPanel();
    showToast(MSG("sessionReset"), "ok");
  }

  function clearAll() {
    const sess = activeSession();
    if (!sess) return;
    clearRedoStack(state, sess.id);
    pushUndo(sess);
    sess.total = null;
    sess.displayDecimals = null;
    sess.initialized = false;
    sess.history = [];
    sess.calcDraft = "";
    debouncedSave();
    renderPanel();
    showToast(MSG("clearAll"), "ok");
  }

  function clearHistoryOnly() {
    const sess = activeSession();
    if (!sess) return;
    clearRedoStack(state, sess.id);
    pushUndo(sess);
    sess.history = [];
    debouncedSave();
    renderPanel();
  }

  function saveReplySnapshot() {
    const sess = activeSession();
    if (!sess) return;
    const snap = {
      id: newId(),
      t: Date.now(),
      total: sess.total,
      initialized: sess.initialized,
      history: sess.history.map((h) => Object.assign({}, h)),
    };
    if (!Array.isArray(sess.replySnapshots)) sess.replySnapshots = [];
    sess.replySnapshots.push(snap);
    if (sess.replySnapshots.length > 30) sess.replySnapshots.shift();
    debouncedSave();
    renderPanel();
    showToast(MSG("replySaved"), "ok");
  }

  async function copyResult() {
    const sess = activeSession();
    if (!sess || sess.total == null || !Number.isFinite(sess.total)) {
      showToast(MSG("errNoNumber"), "error");
      return;
    }
    const text = formatNumber(sess.total, sessionDisplayDecimals(sess));
    try {
      await navigator.clipboard.writeText(text);
      showToast(MSG("copied"), "ok");
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showToast(MSG("copied"), "ok");
      } catch {
        showToast(MSG("smartCopyCopyFailed"), "error");
      }
    }
  }

  function toggleSiteEnabled() {
    const h = hostname();
    if (!h) return;
    if (!state.disabledHosts) state.disabledHosts = {};
    if (state.disabledHosts[h]) {
      delete state.disabledHosts[h];
      showToast(MSG("resumedOnSite"), "ok");
    } else {
      state.disabledHosts[h] = true;
      showToast(MSG("pausedOnSite"), "muted");
    }
    persistStateToStorage();
    renderPanel();
  }

  function togglePin() {
    state.settings.panelPinned = !state.settings.panelPinned;
    debouncedSave();
    renderPanel();
  }

  function toggleMinimize() {
    state.settings.panelMinimized = !state.settings.panelMinimized;
    debouncedSave();
    renderPanel();
  }

  function hidePanel() {
    state.settings.showPanel = false;
    debouncedSave();
    renderPanel();
  }

  function exportHistoryTxt(sess) {
    const lines = [];
    lines.push(`${MSG("session")}: ${sess.name || MSG("session")}`);
    lines.push("");
    (sess.history || []).forEach((h) => {
      const note = h.raw && String(h.raw) !== String(h.label) ? ` (${h.raw})` : "";
      lines.push(`${h.label}${note}`);
    });
    if ((sess.history || []).length) lines.push("");
    lines.push(`${MSG("total")}: ${formatNumber(sess.total, sessionDisplayDecimals(sess)) || "0"}`);
    return lines.join("\n");
  }

  function downloadInPage(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showToast(MSG("exported"), "ok");
  }

  function exportSessionFull(sess) {
    const payload = {
      type: "notemath-session",
      version: 1,
      exportedAt: new Date().toISOString(),
      session: {
        name: sess.name,
        total: sess.total,
        displayDecimals: sess.displayDecimals ?? null,
        initialized: sess.initialized,
        history: sess.history,
        notes: sess.notes || "",
        replySnapshots: sess.replySnapshots || [],
        calcDraft: sess.calcDraft || "",
      },
    };
    downloadInPage(
      `notemath-note-full-${(sess.name || "note").replace(/\W+/g, "_")}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );
  }

  function importSessionJson(text) {
    let data;
    try {
      data = JSON.parse(String(text).replace(/^\uFEFF/, "").trim());
    } catch {
      showToast(MSG("importFailed"), "error");
      return;
    }
    const inner = data.session || data;
    if (!inner || typeof inner !== "object") {
      showToast(MSG("importFailed"), "error");
      return;
    }
    const sess = activeSession();
    if (!sess) return;
    clearRedoStack(state, sess.id);
    pushUndo(sess);
    sess.name = String(inner.name || sess.name).slice(0, 64);
    sess.total = inner.total != null ? Number(inner.total) : null;
    sess.displayDecimals =
      inner.displayDecimals != null ? Math.max(0, Math.min(CalcMath.MAX_DECIMALS, Number(inner.displayDecimals) || 0)) : null;
    sess.initialized = !!inner.initialized;
    sess.history = Array.isArray(inner.history) ? inner.history : [];
    sess.notes = typeof inner.notes === "string" ? inner.notes : "";
    sess.replySnapshots = Array.isArray(inner.replySnapshots) ? inner.replySnapshots : [];
    sess.calcDraft = typeof inner.calcDraft === "string" ? inner.calcDraft : "";
    if (!sess.calcDraft) setDraftFromTotal(sess);
    debouncedSave();
    renderPanel();
    showToast(MSG("importOk"), "ok");
  }

  function panelStyles() {
    const dark =
      state.settings.theme === "dark" ||
      (state.settings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const bg = dark ? "rgba(28,28,30,.94)" : "rgba(252,252,252,.96)";
    const fg = dark ? "#f5f5f7" : "#1c1c1e";
    const bd = dark ? "1px solid rgba(255,255,255,.12)" : "1px solid rgba(0,0,0,.08)";
    const sh = dark ? "0 16px 48px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06)" : "0 12px 40px rgba(0,0,0,.12), 0 0 0 1px rgba(0,0,0,.04)";
    const muted = dark ? "rgba(245,245,247,.55)" : "rgba(28,28,30,.45)";
    const surface = dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.04)";
    const surface2 = dark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.06)";
    const accent = dark ? "#64b5f6" : "#0078d4";
    const keyBg = dark ? "rgba(255,255,255,.1)" : "rgba(0,0,0,.05)";
    const keyBgHover = dark ? "rgba(255,255,255,.16)" : "rgba(0,0,0,.08)";
    const keyOp = dark ? "rgba(100,181,246,.28)" : "rgba(0,120,212,.14)";
    return { bg, fg, bd, sh, dark, muted, surface, surface2, accent, keyBg, keyBgHover, keyOp };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeDraftForEval(sess, raw) {
    const t = raw.trim();
    if (!t) return t;
    if (sess.initialized && sess.total != null && Number.isFinite(sess.total)) {
      if (/^[+\-]/.test(t)) return `(${sess.total})${t}`;
    }
    return t;
  }

  function getMainInput() {
    return shadow && shadow.getElementById("pc-calc-input");
  }

  function syncSessionDraftFromInput() {
    const sess = activeSession();
    const inp = getMainInput();
    if (!sess || !inp) return;
    sess.calcDraft = inp.value;
  }

  function insertIntoMainInput(fragment) {
    const sess = activeSession();
    const inp = getMainInput();
    if (!sess || !inp) return;
    const start = inp.selectionStart ?? inp.value.length;
    const end = inp.selectionEnd ?? inp.value.length;
    const v = inp.value;
    const next = v.slice(0, start) + fragment + v.slice(end);
    inp.value = next;
    sess.calcDraft = next;
    const pos = start + fragment.length;
    requestAnimationFrame(() => {
      inp.focus();
      inp.setSelectionRange(pos, pos);
      syncDisplaySubline();
    });
    debouncedSave();
  }

  function commitCalcEval() {
    const sess = activeSession();
    if (!sess) return;
    const inp = getMainInput();
    const raw = (inp ? inp.value : sess.calcDraft || "").trim();
    if (!raw) return;
    const expr = normalizeDraftForEval(sess, raw);
    try {
      const ctx = sess.total != null && Number.isFinite(sess.total) ? sess.total : 0;
      const v = evaluateExpression(expr, ctx);
      if (!Number.isFinite(v)) throw new Error("x");
      const normalized = normalizeFloatResult(v, CalcMath.decimalPlacesFromText(raw));
      clearRedoStack(state, sess.id);
      pushUndo(sess);
      sess.initialized = true;
      setSessionResult(sess, normalized.value, normalized.precision);
      sess.history.push({
        op: "add",
        label: `=${raw}`,
        operand: normalized.value,
        raw,
        result: normalized.value,
        precision: normalized.precision,
        t: Date.now(),
      });
      trimHistory(sess);
      sess.calcDraft = formatNumber(normalized.value, normalized.precision);
      debouncedSave();
      renderPanel();
    } catch {
      showToast(MSG("errNoNumber"), "error");
    }
  }

  function calcClearEntry() {
    const sess = activeSession();
    if (!sess) return;
    sess.calcDraft = "";
    debouncedSave();
    const inp = getMainInput();
    if (inp) {
      inp.value = "";
      inp.focus();
      syncDisplaySubline();
    } else renderPanel();
  }

  function calcAllClear() {
    resetSession();
  }

  function calcApplyPercent(delta) {
    const sess = activeSession();
    if (!sess || !sess.initialized || sess.total == null || !Number.isFinite(sess.total)) {
      showToast(MSG("errNoNumber"), "error");
      return;
    }
    const pct = delta > 0 ? 10 : -10;
    clearRedoStack(state, sess.id);
    pushUndo(sess);
    const old = sess.total;
    const normalized = normalizeFloatResult(old * (1 + pct / 100), getSessionPrecision(sess) ?? 0);
    const next = normalized.value;
    const label = `${pct > 0 ? "+" : ""}${pct}%`;
    setSessionResult(sess, next, normalized.precision);
    sess.history.push({
      op: "add",
      label,
      operand: next - old,
      raw: label,
      result: next,
      precision: normalized.precision,
      t: Date.now(),
    });
    trimHistory(sess);
    sess.calcDraft = formatNumber(next, normalized.precision);
    debouncedSave();
    renderPanel();
    showToast(`${label} → ${formatNumber(next, normalized.precision)}`, "ok");
  }

  function calcSquare() {
    const sess = activeSession();
    if (!sess) return;
    const raw = (getMainInput()?.value || sess.calcDraft || "").trim();
    if (!raw) return;
    try {
      const ctx = sess.total != null && Number.isFinite(sess.total) ? sess.total : 0;
      const v = evaluateExpression(`(${normalizeDraftForEval(sess, raw)})^2`, ctx);
      if (!Number.isFinite(v)) throw new Error("x");
      const normalized = normalizeFloatResult(v, CalcMath.decimalPlacesFromText(raw));
      sess.calcDraft = formatNumber(normalized.value, normalized.precision);
      sess.displayDecimals = normalized.precision;
      debouncedSave();
      renderPanel();
    } catch {
      showToast(MSG("errNoNumber"), "error");
    }
  }

  function calcSqrt() {
    const sess = activeSession();
    if (!sess) return;
    const raw = (getMainInput()?.value || sess.calcDraft || "").trim();
    if (!raw) return;
    try {
      const ctx = sess.total != null && Number.isFinite(sess.total) ? sess.total : 0;
      const v = evaluateExpression(`√(${normalizeDraftForEval(sess, raw)})`, ctx);
      if (!Number.isFinite(v)) throw new Error("x");
      const normalized = normalizeFloatResult(v, CalcMath.decimalPlacesFromText(raw));
      sess.calcDraft = formatNumber(normalized.value, normalized.precision);
      sess.displayDecimals = normalized.precision;
      debouncedSave();
      renderPanel();
    } catch {
      showToast(MSG("errNoNumber"), "error");
    }
  }

  function switchSession(id) {
    state.activeSessionId = id;
    debouncedSave();
    renderPanel();
  }

  function newTab() {
    const n = state.sessions.length + 1;
    const s = defaultSession(`${MSG("session")} ${n}`);
    state.sessions.push(s);
    state.activeSessionId = s.id;
    debouncedSave();
    renderPanel();
    showToast(MSG("newSession"), "ok");
  }

  function deleteActiveTab() {
    if (state.sessions.length <= 1) {
      showToast(MSG("lastTab"), "error");
      return;
    }
    const id = state.activeSessionId;
    state.sessions = state.sessions.filter((x) => x.id !== id);
    state.activeSessionId = state.sessions[0].id;
    if (state.undoStacks) delete state.undoStacks[id];
    if (state.redoStacks) delete state.redoStacks[id];
    debouncedSave();
    renderPanel();
  }

  function renameActiveTab() {
    const sess = activeSession();
    if (!sess) return;
    const name = window.prompt(MSG("renameTabPrompt"), sess.name);
    if (name == null) return;
    const t = name.trim().slice(0, 64);
    if (t) sess.name = t;
    debouncedSave();
    renderPanel();
  }

  function toggleCalcCollapsed() {
    state.settings.calculatorCollapsed = !state.settings.calculatorCollapsed;
    debouncedSave();
    renderPanel();
  }

  function toggleShowCalculatorSetting() {
    state.settings.showCalculator = state.settings.showCalculator === false;
    debouncedSave();
    renderPanel();
  }

  function positionMoreMenu() {
    if (disposed || !shadow) return;
    const menu = shadow.getElementById("pc-more-menu");
    const btn = shadow.getElementById("pc-more-btn");
    if (!menu || !btn || !menu.classList.contains("open")) return;
    menu.classList.remove("menu-up");
    const gap = 6;
    const br = btn.getBoundingClientRect();
    const mh = menu.scrollHeight || menu.offsetHeight || 200;
    const spaceBelow = window.innerHeight - br.bottom - gap;
    const spaceAbove = br.top - gap;
    if (spaceBelow < mh && spaceAbove > spaceBelow) menu.classList.add("menu-up");
  }

  function toggleMoreMenu() {
    if (disposed || !shadow) return;
    const menu = shadow.getElementById("pc-more-menu");
    if (!menu) return;
    const opening = !menu.classList.contains("open");
    if (opening) {
      menu.classList.add("open");
      requestAnimationFrame(() => requestAnimationFrame(() => positionMoreMenu()));
    } else {
      menu.classList.remove("open", "menu-up");
    }
  }

  function closeMoreMenu() {
    if (disposed || !shadow) return;
    const m = shadow.getElementById("pc-more-menu");
    if (!m) return;
    m.classList.remove("open", "menu-up");
  }

  function renderPanel() {
    if (disposed) return;
    if (!isExtensionContextValid()) {
      disposeContentUi();
      return;
    }
    if (!shadow) return;
    const sess = activeSession();
    const st = panelStyles();
    const pos = state.settings.panelPosition || { right: 16, bottom: 16 };
    host.style.right = `${pos.right}px`;
    host.style.bottom = `${pos.bottom}px`;
    host.style.left = "auto";
    host.style.top = "auto";
    const visible = effectiveShowPanel();
    host.style.pointerEvents = visible ? "auto" : "none";
    host.style.visibility = visible ? "visible" : "hidden";
    host.style.opacity = visible ? "1" : "0";

    const totalNum =
      sess && sess.initialized && sess.total != null && Number.isFinite(sess.total) ? sess.total : null;
    const last = sess?.history?.length > 0 ? sess.history[sess.history.length - 1] : null;
    const histAll = sess?.history || [];
    const histLines = histAll
      .slice(-12)
      .map((h) => h.label)
      .join("\n");
    const miniHistLines = histAll
      .slice(-4)
      .map((h) => `${h.label}${h.raw && String(h.raw) !== String(h.label) ? ` (${h.raw})` : ""}`)
      .join("\n");

    const vertTabs = state.settings.tabsLayout === "vertical";
    const pinOn = state.settings.panelPinned;
    const minOn = state.settings.panelMinimized;
    const showCalc = state.settings.showCalculator !== false;
    const calcCollapsed = !!state.settings.calculatorCollapsed;
    const showTabs = state.settings.showSessionTabs !== false;
    const totalPrecision = sessionDisplayDecimals(sess);
    const clipboardEnabled = smartCopyEnabledOnPage();
    const uiScale = Math.max(0.8, Math.min(1.3, Number(state.settings.uiScale) || 1.0));
    const clipboardButtons = smartCopyButtons();
    const clipboardRaw = clipboardRawValue();
    const clipboardState = clipboardStatus(sess, clipboardRaw);
    const clipboardPulse = Date.now() < clipboardFlashUntil ? " pulse" : "";

    const tabsHtml = state.sessions
      .map((s) => {
        const active = s.id === state.activeSessionId;
        return `<button type="button" class="tab${active ? " tab-active" : ""}" data-tab="${escapeHtml(s.id)}" title="${escapeHtml(s.name)}">${escapeHtml(s.name.length > 14 ? s.name.slice(0, 12) + "…" : s.name)}</button>`;
      })
      .join("");

    const icoCalc = `<svg class="ico" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 2h4.5v4.5H2V2zm7.5 0H14v4.5H9.5V2zM2 9.5h4.5V14H2V9.5zm7.5 0H14V14H9.5V9.5z"/></svg>`;
    const icoPin = `<svg class="ico" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.6c-.7 0-1.3.6-1.3 1.3v2.5L4.3 11h2.1v2.9h3.2V11h2.1L9.3 5.4V2.9c0-.7-.6-1.3-1.3-1.3z"/></svg>`;
    const icoMin = `<svg class="ico" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 8.2h10v1H3v-1z"/></svg>`;
    const icoRestore = `<svg class="ico" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.5 5h9v7h-9V5zm1 1v5h7V6h-7z"/></svg>`;
    const icoClose = `<svg class="ico" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
    const icoRefresh = `<svg class="ico" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M12.5 5.2A4.9 4.9 0 1 0 13 8h-1.5"/><path d="M12.5 2.8v2.9h-2.9"/></svg>`;
    const chevDown = `<svg class="ico ico-chev" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 5.5l4 4 4-4H4z"/></svg>`;
    const chevEnd = `<svg class="ico ico-chev" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5.5 4l4 4-4 4V4z"/></svg>`;
    const clipboardMiniOpsHtml = clipboardButtons
      .map(
        (btn) =>
          `<button type="button" class="btn icon clip-op-mini" data-clip-op="${btn.op}" title="${escapeHtml(btn.title)}">${escapeHtml(btn.label)}</button>`
      )
      .join("");
    const clipboardBlockHtml =
      clipboardEnabled && clipboardButtons.length
        ? `<div class="clip-block">
            <div class="clip-lbl">${escapeHtml(MSG("clipboardLastCopied"))}</div>
            <div class="clip-row">
              <input
                type="text"
                id="pc-clip-input"
                class="clip-input state-${clipboardState}${clipboardPulse}"
                value="${escapeHtml(clipboardRaw)}"
                placeholder="${escapeHtml(MSG("clipboardPlaceholder"))}"
                spellcheck="false"
                autocomplete="off"
              />
              <button type="button" class="iconbtn sm clip-refresh" data-act="cliprefresh" title="${escapeHtml(
                MSG("clipboardRefresh")
              )}">${icoRefresh}</button>
            </div>
          </div>`
        : "";

    const calcBoardHtml = showCalc
      ? `
      <div class="calc-grid">
        <button type="button" class="key" data-calc="C">${escapeHtml(MSG("keyCE"))}</button>
        <button type="button" class="key" data-calc="AC">${escapeHtml(MSG("keyAC"))}</button>
        <button type="button" class="key" data-calc="%">%</button>
        <button type="button" class="key op" data-calc="/">÷</button>

        <button type="button" class="key" data-calc="7">7</button>
        <button type="button" class="key" data-calc="8">8</button>
        <button type="button" class="key" data-calc="9">9</button>
        <button type="button" class="key op" data-calc="*">×</button>

        <button type="button" class="key" data-calc="4">4</button>
        <button type="button" class="key" data-calc="5">5</button>
        <button type="button" class="key" data-calc="6">6</button>
        <button type="button" class="key op" data-calc="−">−</button>

        <button type="button" class="key" data-calc="1">1</button>
        <button type="button" class="key" data-calc="2">2</button>
        <button type="button" class="key" data-calc="3">3</button>
        <button type="button" class="key op" data-calc="+">+</button>

        <button type="button" class="key" data-calc=".">.</button>
        <button type="button" class="key" data-calc="0">0</button>
        <button type="button" class="key op wide" data-calc="=">=</button>
      </div>
      <div class="calc-row2">
        <button type="button" class="btn sm" data-act="bksp">${escapeHtml(MSG("backspaceOne"))}</button>
        <button type="button" class="btn sm" data-act="pctplus">+10%</button>
        <button type="button" class="btn sm" data-act="pctminus">−10%</button>
        <button type="button" class="btn sm" data-act="sq">x²</button>
        <button type="button" class="btn sm" data-act="sqrt">√</button>
      </div>`
      : "";

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .shell {
          display: flex;
          flex-direction: ${vertTabs ? "row" : "column"};
          align-items: stretch;
          gap: 0;
          width: ${minOn ? "auto" : vertTabs ? "min(380px, 94vw)" : "min(320px, 92vw)"};
          max-width: 94vw;
          background: ${st.bg};
          color: ${st.fg};
          border: ${st.bd};
          border-radius: 12px;
          box-shadow: ${st.sh};
          backdrop-filter: saturate(1.2) blur(16px);
          -webkit-backdrop-filter: saturate(1.2) blur(16px);
          font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
          overflow: hidden;
          transition: opacity .12s ease, box-shadow .2s ease, transform .2s ease;
        }
        .shell:hover { box-shadow: ${st.sh}; }
        .tabs {
          display: flex;
          flex-direction: ${vertTabs ? "column" : "row"};
          flex-wrap: nowrap;
          gap: 4px;
          padding: 8px;
          background: ${st.surface};
          border-${vertTabs ? "right" : "bottom"}: ${st.bd};
          max-height: ${vertTabs ? "min(340px, 52vh)" : "auto"};
          overflow-x: ${vertTabs ? "hidden" : "auto"};
          overflow-y: ${vertTabs ? "auto" : "hidden"};
          min-width: ${vertTabs ? "92px" : "0"};
        }
        .tab {
          border: none;
          border-radius: 8px;
          padding: 7px 9px;
          font-size: 11px;
          cursor: pointer;
          background: transparent;
          color: inherit;
          text-align: ${vertTabs ? "left" : "center"};
          white-space: nowrap;
          opacity: .72;
          transition: background .15s ease, opacity .15s ease, transform .1s ease;
        }
        .tab:hover { opacity: 1; background: ${st.surface2}; }
        .tab:active { transform: scale(0.98); }
        .tab-active {
          opacity: 1;
          font-weight: 600;
          background: ${st.dark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.06)"};
          box-shadow: inset 0 0 0 1px ${st.dark ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.08)"};
        }
        .tabbar-actions {
          display: flex;
          flex-direction: ${vertTabs ? "column" : "row"};
          gap: 4px;
          margin-${vertTabs ? "top" : "left"}: auto;
          flex-shrink: 0;
        }
        .maincol { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .panel-top {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 12px;
          cursor: ${pinOn ? "default" : "grab"};
          user-select: none;
          border-bottom: ${st.bd};
          background: ${st.surface};
        }
        .panel-top:active { cursor: ${pinOn ? "default" : "grabbing"}; }
        .panel-brand {
          flex: 1;
          font-weight: 600;
          font-size: 12px;
          letter-spacing: .02em;
          color: ${st.muted};
        }
        .panel-actions {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
          align-items: center;
        }
        .ico { display: block; pointer-events: none; }
        .ico-chev { opacity: .75; }
        .iconbtn {
          width: 30px; height: 30px;
          border: none; border-radius: 6px;
          cursor: pointer;
          background: ${st.surface2};
          color: inherit;
          font-size: 15px;
          line-height: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: background .15s ease, transform .1s ease, box-shadow .15s ease;
        }
        .iconbtn.sm { width: 28px; height: 28px; border-radius: 5px; }
        .iconbtn:hover { background: ${st.dark ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.08)"}; }
        .iconbtn:active { transform: scale(0.96); }
        .iconbtn.on { box-shadow: inset 0 0 0 2px ${st.accent}; }
        .body { padding: 12px 14px 14px; }
        .display-wrap { margin-bottom: 10px; }
        .display-lbl {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: .08em;
          color: ${st.muted};
          margin-bottom: 6px;
        }
        .main-display {
          width: 100%;
          font-family: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace;
          font-size: 22px;
          font-weight: 500;
          letter-spacing: -0.02em;
          padding: 12px 14px;
          border-radius: 10px;
          border: ${st.bd};
          background: ${st.dark ? "rgba(0,0,0,.35)" : "rgba(255,255,255,.95)"};
          color: inherit;
          outline: none;
          transition: border-color .15s ease, box-shadow .2s ease;
        }
        .main-display:focus {
          border-color: ${st.accent};
          box-shadow: 0 0 0 3px ${st.dark ? "rgba(100,181,246,.25)" : "rgba(0,120,212,.2)"};
        }
        .main-display::placeholder { color: ${st.muted}; }
        .display-sub {
          font-size: 11px;
          font-family: ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace;
          color: ${st.muted};
          margin-top: 5px;
          padding: 0 3px;
          min-height: 1.25em;
          letter-spacing: 0.02em;
          line-height: 1.3;
        }
        .last-line {
          font-size: 11px;
          color: ${st.muted};
          margin-bottom: 10px;
          min-height: 1.3em;
        }
        .block-hist {
          border-radius: 10px;
          border: ${st.bd};
          padding: 8px 10px;
          margin-bottom: 10px;
          max-height: 88px;
          overflow: auto;
          transition: border-color .15s ease;
        }
        .block-hist .hl { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: ${st.muted}; margin-bottom: 4px; }
        .block-hist .lines {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 10px;
          color: ${st.muted};
          white-space: pre-wrap;
          line-height: 1.45;
        }
        .clip-block {
          border-radius: 10px;
          border: ${st.bd};
          padding: 8px 10px;
          margin-bottom: 10px;
          background: ${st.dark ? "rgba(255,255,255,.02)" : "rgba(0,0,0,.01)"};
        }
        .clip-lbl {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: .06em;
          color: ${st.muted};
          margin-bottom: 4px;
        }
        .clip-row {
          display: flex;
          gap: 6px;
          align-items: center;
        }
        .clip-input {
          width: 100%;
          min-width: 0;
          border-radius: 8px;
          padding: 7px 9px;
          font: 600 12px/1.3 ui-monospace, "SF Mono", Consolas, monospace;
          border: 1px solid transparent;
          color: inherit;
          background: ${st.dark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.05)"};
          transition: background .18s ease, border-color .18s ease, box-shadow .18s ease, color .18s ease;
        }
        .clip-input::placeholder { color: ${st.muted}; font-weight: 500; }
        .clip-input:focus {
          outline: none;
          border-color: ${st.accent};
          box-shadow: 0 0 0 3px ${st.dark ? "rgba(100,181,246,.22)" : "rgba(0,120,212,.18)"};
        }
        .clip-input.state-empty {
          background: ${st.dark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.05)"};
          color: ${st.muted};
        }
        .clip-input.state-valid {
          background: ${st.dark ? "rgba(60,160,90,.22)" : "rgba(46,125,50,.12)"};
          border-color: ${st.dark ? "rgba(80,190,120,.38)" : "rgba(46,125,50,.28)"};
          color: ${st.dark ? "#c8f5d7" : "#1b5e20"};
        }
        .clip-input.state-invalid {
          background: ${st.dark ? "rgba(210,90,90,.2)" : "rgba(198,40,40,.11)"};
          border-color: ${st.dark ? "rgba(230,120,120,.38)" : "rgba(198,40,40,.28)"};
          color: ${st.dark ? "#ffd4d4" : "#8e1c1c"};
        }
        .clip-input.pulse {
          animation: clipPulse .32s ease;
        }
        .clip-refresh {
          flex-shrink: 0;
          width: 30px;
          height: 30px;
        }
        .clip-op-mini {
          min-width: 30px;
          padding: 6px 8px;
          font-weight: 700;
        }
        @keyframes clipPulse {
          0% { box-shadow: 0 0 0 0 ${st.dark ? "rgba(120,190,255,.42)" : "rgba(0,120,212,.24)"}; }
          100% { box-shadow: 0 0 0 8px transparent; }
        }
        .toolbar {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          align-items: center;
          margin-bottom: 10px;
        }
        .btn {
          border: none; border-radius: 8px; padding: 7px 11px;
          font-size: 12px; cursor: pointer;
          background: ${st.surface2};
          color: inherit;
          transition: background .15s ease, transform .1s ease;
        }
        .btn:hover { background: ${st.dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.09)"}; }
        .btn:active { transform: scale(0.98); }
        .btn.sm { padding: 5px 9px; font-size: 11px; }
        .btn.icon { padding: 7px 10px; min-width: 36px; }
        .more-wrap { position: relative; }
        .more-menu {
          display: none;
          position: absolute;
          right: 0;
          top: calc(100% + 6px);
          bottom: auto;
          min-width: 200px;
          max-height: min(70vh, 400px);
          overflow-y: auto;
          padding: 6px;
          border-radius: 10px;
          background: ${st.bg};
          border: ${st.bd};
          box-shadow: ${st.sh};
          z-index: 20;
        }
        .more-menu.menu-up {
          top: auto;
          bottom: calc(100% + 6px);
        }
        .more-menu.open { display: block; animation: menuIn .18s ease-out; }
        .more-menu.open.menu-up { animation: menuInUp .18s ease-out; }
        @keyframes menuIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
        @keyframes menuInUp { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        .more-menu button {
          display: block;
          width: 100%;
          text-align: left;
          border: none;
          border-radius: 8px;
          padding: 8px 10px;
          margin: 2px 0;
          background: transparent;
          color: inherit;
          font: 12px/1.3 system-ui, sans-serif;
          cursor: pointer;
          transition: background .12s ease;
        }
        .more-menu button:hover { background: ${st.surface2}; }
        .calc-section { margin-top: 2px; }
        .calc-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin: 0 0 6px;
        }
        .calc-title { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: ${st.muted}; }
        .calc-collapse {
          display: grid;
          grid-template-rows: 0fr;
          transition: grid-template-rows .24s ease;
        }
        .calc-collapse.expanded { grid-template-rows: 1fr; }
        .calc-collapse-inner { min-height: 0; overflow: hidden; }
        .calc-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 5px;
          margin-bottom: 8px;
        }
        .key {
          border: none;
          border-radius: 4px;
          padding: 11px 0;
          font-size: 15px;
          font-weight: 500;
          cursor: pointer;
          background: ${st.keyBg};
          color: inherit;
          transition: background .12s ease, transform .08s ease;
        }
        .key:hover { background: ${st.keyBgHover}; }
        .key:active { transform: scale(0.98); }
        .key.op { background: ${st.keyOp}; font-weight: 600; }
        .key.wide { grid-column: span 2; }
        .calc-row2 { display: flex; flex-wrap: wrap; gap: 6px; }
        .min-body {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 12px 14px 14px;
        }
        .min-total {
          font-size: 20px;
          font-weight: 700;
          font-family: ui-monospace, monospace;
          letter-spacing: -0.02em;
          line-height: 1.1;
        }
        .min-total-sub {
          font-size: 11px;
          font-family: ui-monospace, monospace;
          color: ${st.muted};
          letter-spacing: 0.02em;
          line-height: 1.3;
        }
        .min-history {
          border-radius: 10px;
          border: ${st.bd};
          padding: 8px 10px;
          background: ${st.dark ? "rgba(0,0,0,.18)" : "rgba(0,0,0,.02)"};
        }
        .min-history .mh-lbl {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: .06em;
          color: ${st.muted};
          margin-bottom: 4px;
        }
        .min-history .mh-lines {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 10px;
          white-space: pre-wrap;
          line-height: 1.45;
          color: ${st.muted};
        }
        .min-actions {
          display: flex;
          gap: 6px;
        }
        .min-actions .btn {
          flex: 1;
        }
        input[type="file"] { display: none; }
      </style>
      <div class="shell" part="shell" style="${uiScale !== 1.0 ? `transform: scale(${uiScale}); transform-origin: bottom right;` : ""}">
        ${
          showTabs
            ? `<div class="tabs">
          ${tabsHtml}
          <div class="tabbar-actions">
            <button type="button" class="iconbtn sm" data-act="tabnew" title="${escapeHtml(MSG("newSession"))}">+</button>
            <button type="button" class="iconbtn sm" data-act="tabdel" title="${escapeHtml(MSG("deleteSession"))}">×</button>
          </div>
        </div>`
            : ""
        }
        <div class="maincol">
          <div class="panel-top" id="pc-drag">
            <span class="panel-brand">${escapeHtml(MSG("widgetTitle"))}</span>
            <div class="panel-actions">
              <button type="button" class="iconbtn sm${showCalc && !calcCollapsed ? " on" : ""}" data-act="togglecalcvis" title="${escapeHtml(MSG("toggleCalcKeys"))}">${icoCalc}</button>
              <button type="button" class="iconbtn sm${pinOn ? " on" : ""}" data-act="pin" title="${escapeHtml(MSG("pin"))}">${icoPin}</button>
              <button type="button" class="iconbtn sm" data-act="min" title="${escapeHtml(minOn ? MSG("expand") : MSG("minimize"))}">${minOn ? icoRestore : icoMin}</button>
              <button type="button" class="iconbtn sm" data-act="close" title="${escapeHtml(MSG("closePanel"))}">${icoClose}</button>
            </div>
          </div>
          ${
            minOn
              ? `<div class="min-body">
              <div class="min-total">${escapeHtml(totalNum != null ? formatNumber(totalNum, totalPrecision) : "0")}</div>
              <div class="min-total-sub">${escapeHtml(totalNum != null ? formatNumberSpaced(totalNum) : "")}</div>
              <div class="min-history">
                <div class="mh-lbl">${escapeHtml(MSG("history"))}</div>
                <div class="mh-lines">${escapeHtml(miniHistLines || MSG("historyEmpty"))}</div>
              </div>
              ${clipboardBlockHtml}
              <div class="min-actions">
                <button type="button" class="btn icon" data-act="undo" title="${escapeHtml(MSG("undo"))}">↶</button>
                <button type="button" class="btn icon" data-act="redo" title="${escapeHtml(MSG("redo"))}">↷</button>
                ${clipboardEnabled && clipboardButtons.length ? clipboardMiniOpsHtml : ""}
                <button type="button" class="btn icon" data-act="clearall" title="${escapeHtml(MSG("clearAll"))}">AC</button>
              </div>
            </div>`
              : `<div class="body">
            <div class="display-wrap">
              <div class="display-lbl">${escapeHtml(MSG("total"))}</div>
              <input type="text" class="main-display" id="pc-calc-input" autocomplete="off" spellcheck="false" inputmode="decimal" placeholder="0" />
              <div class="display-sub" id="pc-display-sub" aria-hidden="true"></div>
            </div>
            <div class="last-line">${escapeHtml(last ? `${last.label} → ${formatNumber(last.result, last.precision ?? totalPrecision)}` : "")}</div>
            <div class="block-hist">
              <div class="hl">${escapeHtml(MSG("history"))}</div>
              <div class="lines">${escapeHtml(histLines || MSG("historyEmpty"))}</div>
            </div>
            ${clipboardBlockHtml}
            <div class="toolbar">
              <button type="button" class="btn icon" data-act="undo" title="${escapeHtml(MSG("undo"))}">↶</button>
              <button type="button" class="btn icon" data-act="redo" title="${escapeHtml(MSG("redo"))}">↷</button>
              ${clipboardEnabled && clipboardButtons.length ? clipboardMiniOpsHtml : ""}
              <button type="button" class="btn" data-act="copy">${escapeHtml(MSG("copy"))}</button>
              <button type="button" class="btn" data-act="reset">${escapeHtml(MSG("reset"))}</button>
              <button type="button" class="btn" data-act="clearall">${escapeHtml(MSG("clearAll"))}</button>
              <button type="button" class="btn" data-act="clearhist">${escapeHtml(MSG("clearHistory"))}</button>
              <div class="more-wrap">
                <button type="button" class="btn" data-act="more" id="pc-more-btn">${escapeHtml(MSG("more"))} ▾</button>
                <div class="more-menu" id="pc-more-menu">
                  <button type="button" data-act="rename">${escapeHtml(MSG("renameTab"))}</button>
                  <button type="button" data-act="site">${escapeHtml(isSiteDisabled() ? MSG("toggleOnPageOff") : MSG("toggleOnPage"))}</button>
                  <button type="button" data-act="reply">${escapeHtml(MSG("reply"))}</button>
                  <button type="button" data-act="exptxt">${escapeHtml(MSG("exportTxt"))}</button>
                  <button type="button" data-act="expjson">${escapeHtml(MSG("exportJson"))}</button>
                  <button type="button" data-act="expsess">${escapeHtml(MSG("exportSession"))}</button>
                  <button type="button" data-act="imp">${escapeHtml(MSG("importSession"))}</button>
                </div>
              </div>
            </div>
            <input type="file" id="pc-file" accept=".json,application/json" />
            ${
              showCalc
                ? `<div class="calc-section">
              <div class="calc-head">
                <span class="calc-title">${escapeHtml(MSG("calculator"))}</span>
                <button type="button" class="iconbtn sm" data-act="calctoggle" title="${escapeHtml(MSG("toggleCalc"))}">${calcCollapsed ? chevEnd : chevDown}</button>
              </div>
              <div class="calc-collapse${calcCollapsed ? "" : " expanded"}">
                <div class="calc-collapse-inner">
                  ${calcBoardHtml}
                </div>
              </div>
            </div>`
                : ""
            }
          </div>`
          }
        </div>
      </div>
    `;

    const fileInput = shadow.getElementById("pc-file");
    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          importSessionJson(String(r.result || ""));
          fileInput.value = "";
        };
        r.readAsText(f);
      });
    }

    const mainInp = shadow.getElementById("pc-calc-input");
    if (mainInp && sess) {
      mainInp.value = getCalcDraft(sess);
      mainInp.addEventListener("input", () => {
        sess.calcDraft = mainInp.value;
        debouncedSave();
        syncDisplaySubline();
      });
      mainInp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitCalcEval();
        } else {
          requestAnimationFrame(() => syncDisplaySubline());
        }
      });
      syncDisplaySubline();
    }

    const clipInp = shadow.getElementById("pc-clip-input");
    if (clipInp && state) {
      clipInp.value = clipboardRawValue();
      clipInp.addEventListener("input", () => {
        state.lastCopiedValue = clipInp.value;
        debouncedSave();
        updateClipboardInputVisual(clipInp.value, false);
      });
      clipInp.addEventListener("blur", () => {
        state.lastCopiedValue = clipInp.value;
        debouncedSave();
        updateClipboardInputVisual(clipInp.value, false);
      });
      clipInp.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        applySmartCopyOperation(clipboardButtons[0]?.op || "add");
      });
      updateClipboardInputVisual(clipInp.value, Date.now() < clipboardFlashUntil);
    }

    if (!panelKeydownBound) {
      panelKeydownBound = true;
      shadow.addEventListener("keydown", onPanelKeyDown, true);
    }

    shadow.querySelector(".shell")?.addEventListener("click", (e) => {
      const clipBtn = e.target.closest("[data-clip-op]");
      if (clipBtn) {
        const op = clipBtn.getAttribute("data-clip-op");
        if (op) applySmartCopyOperation(op);
        return;
      }
      const t = e.target.closest("[data-act]");
      if (!t) return;
      const act = t.getAttribute("data-act");
      if (act === "more") {
        e.stopPropagation();
        toggleMoreMenu();
        return;
      }
      closeMoreMenu();
      if (act === "undo") undoLast();
      else if (act === "redo") redoLast();
      else if (act === "reset") resetSession();
      else if (act === "clearall") clearAll();
      else if (act === "copy")
        void copyResult().catch((err) => {
          if (isContextInvalidatedError(err) || !isExtensionContextValid()) disposeContentUi();
        });
      else if (act === "clearhist") clearHistoryOnly();
      else if (act === "site") toggleSiteEnabled();
      else if (act === "pin") togglePin();
      else if (act === "min") toggleMinimize();
      else if (act === "close") hidePanel();
      else if (act === "reply") saveReplySnapshot();
      else if (act === "tabnew") newTab();
      else if (act === "tabdel") deleteActiveTab();
      else if (act === "rename") renameActiveTab();
      else if (act === "exptxt") {
        const s = activeSession();
        if (s) downloadInPage(`notemath-${(s.name || "h").replace(/\W+/g, "_")}.txt`, exportHistoryTxt(s));
      } else if (act === "expjson") {
        const s = activeSession();
        if (s)
          downloadInPage(
            `notemath-${(s.name || "h").replace(/\W+/g, "_")}.json`,
            JSON.stringify({ history: s.history, total: s.total, name: s.name }, null, 2),
            "application/json"
          );
      } else if (act === "expsess") {
        const s = activeSession();
        if (s) exportSessionFull(s);
      } else if (act === "imp") fileInput?.click();
      else if (act === "calctoggle") toggleCalcCollapsed();
      else if (act === "togglecalcvis") toggleShowCalculatorSetting();
      else if (act === "pctplus") calcApplyPercent(1);
      else if (act === "pctminus") calcApplyPercent(-1);
      else if (act === "sq") calcSquare();
      else if (act === "sqrt") calcSqrt();
      else if (act === "bksp") calcBackspace();
      else if (act === "cliprefresh") {
        void refreshClipboardFromSystem().catch(() => {
          showToast(MSG("smartCopyNoValue"), "error");
        });
      }
    });

    shadow.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchSession(btn.getAttribute("data-tab")));
      btn.addEventListener("dblclick", (ev) => {
        ev.preventDefault();
        const id = btn.getAttribute("data-tab");
        if (id === state.activeSessionId) renameActiveTab();
      });
    });

    shadow.querySelectorAll("[data-calc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.getAttribute("data-calc");
        if (v === "C") calcClearEntry();
        else if (v === "AC") calcAllClear();
        else if (v === "=") commitCalcEval();
        else insertIntoMainInput(v === "−" ? "-" : v);
      });
    });

    const head = shadow.getElementById("pc-drag");
    if (head && !state.settings.panelPinned) {
      head.addEventListener("mousedown", onDragStart);
    }
  }

  function onPanelKeyDown(ev) {
    if (!effectiveShowPanel() || state.settings.panelMinimized) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;

    const key = ev.key;
    const isMain = t && t.id === "pc-calc-input";

    if (isMain) {
      if (key === "Enter") return;
      if (key.length === 1 && /[0-9+\-.*\/%]/.test(key)) {
        syncSessionDraftFromInput();
        requestAnimationFrame(() => syncDisplaySubline());
        return;
      }
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Delete", "Tab", "Escape"].includes(key))
        return;
    }

    if (t && t.tagName === "BUTTON") {
      if (!/^[0-9+\-.*\/=]$/.test(key) && key !== "Backspace") return;
    }

    if (key === "Escape") {
      closeMoreMenu();
      return;
    }

    if (/^[0-9]$/.test(key)) {
      ev.preventDefault();
      insertIntoMainInput(key);
      requestAnimationFrame(() => syncDisplaySubline());
      return;
    }
    if (["+", "-", ".", "*", "/"].includes(key)) {
      ev.preventDefault();
      insertIntoMainInput(key);
      requestAnimationFrame(() => syncDisplaySubline());
      return;
    }
    if (key === "Enter" || key === "=") {
      ev.preventDefault();
      commitCalcEval();
      return;
    }
    if (key === "Backspace") {
      ev.preventDefault();
      calcBackspace();
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const inp = getMainInput();
      if (!inp) return;
      ev.preventDefault();
      const pos = inp.selectionStart ?? 0;
      const delta = key === "ArrowLeft" ? -1 : 1;
      const next = Math.max(0, Math.min(inp.value.length, pos + delta));
      inp.focus();
      inp.setSelectionRange(next, next);
    }
  }

  function calcBackspace() {
    const inp = getMainInput();
    if (!inp) return;
    const start = inp.selectionStart ?? inp.value.length;
    const end = inp.selectionEnd ?? inp.value.length;
    if (start !== end) {
      inp.value = inp.value.slice(0, start) + inp.value.slice(end);
      inp.setSelectionRange(start, start);
    } else if (start > 0) {
      inp.value = inp.value.slice(0, start - 1) + inp.value.slice(start);
      inp.setSelectionRange(start - 1, start - 1);
    }
    const sess = activeSession();
    if (sess) sess.calcDraft = inp.value;
    debouncedSave();
    syncDisplaySubline();
  }

  function onDragStart(e) {
    if (e.button !== 0) return;
    if (e.target.closest("button")) return;
    if (e.target.closest("input") || e.target.closest("textarea") || e.target.closest("select")) return;
    if (state.settings.panelPinned) return;
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      right: state.settings.panelPosition.right,
      bottom: state.settings.panelPosition.bottom,
    };
    window.addEventListener("mousemove", onDragMove, true);
    window.addEventListener("mouseup", onDragEnd, true);
    e.preventDefault();
  }

  function onDragMove(e) {
    if (disposed || !dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    state.settings.panelPosition = {
      right: Math.max(8, dragState.right - dx),
      bottom: Math.max(8, dragState.bottom - dy),
    };
    if (dragRaf != null) return;
    dragRaf = requestAnimationFrame(() => {
      dragRaf = null;
      if (!disposed) renderPanel();
    });
  }

  function onDragEnd() {
    if (dragRaf != null) {
      cancelAnimationFrame(dragRaf);
      dragRaf = null;
    }
    if (disposed) {
      dragState = null;
      window.removeEventListener("mousemove", onDragMove, true);
      window.removeEventListener("mouseup", onDragEnd, true);
      return;
    }
    dragState = null;
    window.removeEventListener("mousemove", onDragMove, true);
    window.removeEventListener("mouseup", onDragEnd, true);
    renderPanel();
    debouncedSave();
  }

  let toastTimer = null;
  function showToast(text, kind) {
    if (disposed || !toastShadow || !state?.settings?.showToast) return;
    const dark =
      state.settings.theme === "dark" ||
      (state.settings.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const panelVisible = !!(host && host.style.visibility !== "hidden" && host.style.opacity !== "0");
    const panelRect = panelVisible && typeof host.getBoundingClientRect === "function" ? host.getBoundingClientRect() : null;
    const toastBottom = panelRect ? Math.max(16, Math.ceil(panelRect.height + 18)) : 16;
    const bg =
      kind === "error"
        ? dark
          ? "#c5221f"
          : "#e53935"
        : kind === "muted"
          ? dark
            ? "rgba(255,255,255,.14)"
            : "rgba(0,0,0,.72)"
          : dark
            ? "rgba(60,130,80,.96)"
            : "rgba(46,125,50,.96)";
    toastShadow.innerHTML = `
      <style>
        .t-wrap {
          position: fixed;
          right: 20px;
          bottom: ${toastBottom}px;
          max-width: min(300px, calc(100vw - 40px));
          pointer-events: none;
          z-index: 1;
        }
        .t {
          padding: 9px 14px;
          border-radius: 10px;
          color: #fff;
          font: 13px/1.4 system-ui, sans-serif;
          box-shadow: 0 4px 20px rgba(0,0,0,.22), 0 1px 4px rgba(0,0,0,.12);
          animation: tEnter .2s cubic-bezier(0.22, 1, 0.36, 1) forwards;
          will-change: opacity, transform;
        }
        @keyframes tEnter {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes tLeave {
          from { opacity: 1; transform: translateY(0); }
          to { opacity: 0; transform: translateY(6px); }
        }
        .t.leave { animation: tLeave .2s ease-in forwards; }
      </style>
      <div class="t-wrap"><div class="t" id="pc-toast-el" style="background:${bg}">${escapeHtml(text)}</div></div>
    `;
    clearTimeout(toastTimer);
    const el = toastShadow.getElementById("pc-toast-el");
    const ms = 1850;
    toastTimer = setTimeout(() => {
      if (el) el.classList.add("leave");
      toastTimer = setTimeout(() => {
        toastShadow.innerHTML = "";
        toastTimer = null;
      }, 240);
    }, ms);
  }

  function hotkeyDebounceMs() {
    return Math.max(0, Math.min(500, state.settings.hotkeyDebounceMs | 0 || 140));
  }

  function scheduleHotkey(fn) {
    const seq = ++hotkeySeq;
    const ms = hotkeyDebounceMs();
    clearTimeout(hotkeyTimer);
    hotkeyTimer = setTimeout(() => {
      if (seq !== hotkeySeq) return;
      hotkeyTimer = null;
      fn();
    }, ms);
  }

  function shouldHandleHotkey(ev) {
    if (!state?.settings?.fallbackHotkeys) return false;
    if (isSiteDisabled()) return false;
    if (!ev.altKey) return false;
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return false;
    if (!state.settings.allowInInputs && isEditableFocused() && !isFocusInsidePanel()) return false;
    return true;
  }

  function keyToOp(code) {
    if (code === "KeyA") return "add";
    if (code === "KeyS") return "subtract";
    return null;
  }

  function onKeyDown(ev) {
    if (disposed) return;
    if (!isExtensionContextValid()) {
      disposeContentUi();
      return;
    }
    if (!state) return;

    if (handleSmartCopyPaste(ev)) return;

    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && ev.code === "KeyF" && shouldHandleHotkey(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
      scheduleHotkey(() => togglePanelVisible());
      return;
    }

    if (!shouldHandleHotkey(ev)) return;
    const op = keyToOp(ev.code);
    if (!op) return;
    ev.preventDefault();
    ev.stopPropagation();
    pendingHotkeyOp = op;
    const ms = hotkeyDebounceMs();
    clearTimeout(hotkeyTimer);
    hotkeyTimer = setTimeout(() => {
      hotkeyTimer = null;
      const o = pendingHotkeyOp;
      pendingHotkeyOp = null;
      if (o) applySelectionOperation(o);
    }, ms);
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "RUN_OPERATION" && msg.source === "command") {
      if (msg.op !== "add" && msg.op !== "subtract") return;
      if (isSiteDisabled()) return;
      if (!state.settings.allowInInputs && isEditableFocused() && !isFocusInsidePanel()) return;
      const ms = hotkeyDebounceMs();
      pendingHotkeyOp = msg.op;
      clearTimeout(hotkeyTimer);
      hotkeyTimer = setTimeout(() => {
        hotkeyTimer = null;
        const o = pendingHotkeyOp;
        pendingHotkeyOp = null;
        if (o) applySelectionOperation(o);
      }, ms);
      return;
    }
    if (msg.type === "TOGGLE_PANEL") {
      if (!isTopFrame) return;
      togglePanelVisible();
      return;
    }
    if (msg.type === "OPEN_PANEL") {
      if (!isTopFrame) return;
      openPanel();
      return;
    }
    if (msg.type === "STATE_UPDATED") {
      loadState()
        .then((s) => {
          if (disposed) return;
          state = s;
          migrateIfNeeded();
          renderPanel();
        })
        .catch((err) => {
          if (isContextInvalidatedError(err) || !isExtensionContextValid()) disposeContentUi();
        });
    }
    if (msg.type === "GET_STATE") {
      return Promise.resolve(state);
    }
  }

  async function init() {
    if (isRestrictedPage()) return;

    try {
      state = await loadState();
    } catch (e) {
      if (isContextInvalidatedError(e)) return;
      throw e;
    }
    migrateIfNeeded();
    if (!document.body) return;

    if (isTopFrame) {
      host = document.createElement("div");
      host.id = "notemath-host";
      shadow = host.attachShadow({ mode: "closed" });
      document.body.appendChild(host);

      toastHost = document.createElement("div");
      toastHost.id = "notemath-toast-host";
      toastShadow = toastHost.attachShadow({ mode: "closed" });
      document.body.appendChild(toastHost);
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("copy", captureCopiedText, true);

    window.addEventListener("resize", onWindowResize);

    chrome.storage.onChanged.addListener(onChromeStorageChanged);

    chrome.runtime.onMessage.addListener(onChromeRuntimeMessage);

    themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    themeMediaQuery.addEventListener("change", onThemeMediaChange);

    window.addEventListener("click", onWindowClickForMenu, true);

    renderPanel();
  }

  function migrateIfNeeded() {
    if (!state.sessions) return;
    state.sessions.forEach((se) => {
      if (se.notes == null) se.notes = "";
      if (!Array.isArray(se.replySnapshots)) se.replySnapshots = [];
      if (se.calcDraft == null) se.calcDraft = "";
    });
    if (state.lastCopiedValue == null) state.lastCopiedValue = "";
    if (!state.redoStacks) state.redoStacks = {};
    state.settings = Object.assign(CalcStorageModel.defaultSettings(), state.settings || {});
  }

  init().catch((err) => {
    if (isContextInvalidatedError(err)) return;
  });
})();
