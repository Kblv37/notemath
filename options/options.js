(function () {
  const { loadState, saveState, defaultSession, parseSettingsJson, serializeSettings } = CalcStorageModel;
  const MSG = (k) => chrome.i18n.getMessage(k) || k;

  const $ = (id) => document.getElementById(id);

  function activeSession(state) {
    return state.sessions.find((s) => s.id === state.activeSessionId) || state.sessions[0];
  }

  function formatTotal(n, decimals) {
    if (n == null || !Number.isFinite(n)) return "";
    try {
      if (Number.isInteger(decimals) && decimals >= 0) {
        return new Intl.NumberFormat(undefined, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(n);
      }
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 }).format(n);
    } catch {
      return Number.isInteger(decimals) && decimals >= 0 ? n.toFixed(decimals) : String(n);
    }
  }

  function defaultSmartCopyPanel() {
    return CalcStorageModel.defaultSmartCopyPanel();
  }

  function smartCopyPanelState(state) {
    return Object.assign(defaultSmartCopyPanel(), state.settings.smartCopyPanel || {});
  }

  async function saveSmartCopyPanel(partial) {
    const state = await loadState();
    const current = smartCopyPanelState(state);
    if (partial.buttons) current.buttons = Object.assign({}, current.buttons, partial.buttons);
    if (Object.prototype.hasOwnProperty.call(partial, "enabled")) current.enabled = !!partial.enabled;
    state.settings.smartCopyPanel = current;
    await saveState(state);
  }

  function updateSmartCopyControls() {
    const enabled = $("chkSmartCopyEnabled")?.checked !== false;
    ["chkSmartCopyAdd", "chkSmartCopySubtract", "chkSmartCopyMultiply", "chkSmartCopyDivide"].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !enabled;
    });
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
    lines.push(`${MSG("total")}: ${formatTotal(sess.total, sess.displayDecimals) || "0"}`);
    return lines.join("\n");
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function mergeImportedSession(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      alert(MSG("importFailed"));
      return;
    }
    const inner = data.session || data;
    if (!inner || typeof inner !== "object") {
      alert(MSG("importFailed"));
      return;
    }
    const state = await loadState();
    const sess = activeSession(state);
    if (!sess) return;
    if (!state.redoStacks) state.redoStacks = {};
    CalcStorageModel.ensureUndoStack(state, sess.id).push({
      total: sess.total,
      displayDecimals: sess.displayDecimals ?? null,
      initialized: sess.initialized,
      history: sess.history.map((h) => Object.assign({}, h)),
    });
    state.redoStacks[sess.id] = [];
    sess.name = String(inner.name || sess.name).slice(0, 64);
    sess.total = inner.total != null ? Number(inner.total) : null;
    sess.displayDecimals =
      inner.displayDecimals != null ? Math.max(0, Math.min(12, Number(inner.displayDecimals) || 0)) : null;
    sess.initialized = !!inner.initialized;
    sess.history = Array.isArray(inner.history) ? inner.history : [];
    sess.notes = typeof inner.notes === "string" ? inner.notes : "";
    sess.replySnapshots = Array.isArray(inner.replySnapshots) ? inner.replySnapshots : [];
    sess.calcDraft = typeof inner.calcDraft === "string" ? inner.calcDraft : "";
    await saveState(state);
    await load();
  }

  async function load() {
    const state = await loadState();
    const s = state.settings;
    document.querySelector(`input[name="theme"][value="${s.theme || "system"}"]`).checked = true;
    $("chkFallback").checked = !!s.fallbackHotkeys;
    $("chkInputs").checked = !!s.allowInInputs;
    $("chkPanel").checked = !!s.showPanel;
    $("chkToast").checked = s.showToast !== false;
    $("chkCalc").checked = s.showCalculator !== false;
    $("chkTabs").checked = s.showSessionTabs !== false;

    const sc = smartCopyPanelState(state);
    $("chkSmartCopyEnabled").checked = sc.enabled !== false;
    $("chkSmartCopyAdd").checked = sc.buttons.add !== false;
    $("chkSmartCopySubtract").checked = sc.buttons.subtract !== false;
    $("chkSmartCopyMultiply").checked = sc.buttons.multiply !== false;
    $("chkSmartCopyDivide").checked = sc.buttons.divide !== false;
    updateSmartCopyControls();

    const ps = s.panelStartup || "remember";
    const pr = document.querySelector(`input[name="pstart"][value="${ps}"]`);
    if (pr) pr.checked = true;
    else document.querySelector(`input[name="pstart"][value="remember"]`).checked = true;

    const tl = s.tabsLayout || "horizontal";
    const tr = document.querySelector(`input[name="tabs"][value="${tl}"]`);
    if (tr) tr.checked = true;

    $("inpRight").value = String(s.panelPosition?.right ?? 16);
    $("inpBottom").value = String(s.panelPosition?.bottom ?? 16);
    $("inpHistLimit").value = String(s.historyLimit ?? 200);
    $("inpDebounce").value = String(s.hotkeyDebounceMs ?? 140);

    const scale = Math.max(0.8, Math.min(1.3, Number(s.uiScale) || 1.0));
    $("inpUiScale").value = String(scale);
    $("uiScaleVal").textContent = Math.round(scale * 100) + "%";

    const sess = activeSession(state);
    $("inpName").value = sess.name || "";
  }

  async function savePartial(partial) {
    const state = await loadState();
    Object.assign(state.settings, partial);
    await saveState(state);
  }

  function bind() {
    document.title = MSG("optionsTitle");
    $("pageTitle").textContent = MSG("optionsTitle");
    const sub = $("pageSubtitle");
    if (sub) sub.textContent = MSG("optionsSubtitle") || "NoteMath";
    const setIfExists = (id, key) => { const el = $(id); if (el) el.textContent = MSG(key); };
    setIfExists("secInterface",  "secInterface");
    setIfExists("secClipboard",  "secClipboard");
    setIfExists("secHotkeys",    "secHotkeys");
    setIfExists("secBehavior",   "secBehavior");
    setIfExists("secSessions",   "secSessions");
    setIfExists("secExport",     "secExport");
    setIfExists("secDanger",     "secDanger");
    setIfExists("descTheme",     "descTheme");
    setIfExists("descDanger",    "descDanger");
    setIfExists("secContact",    "secContact");
    setIfExists("lblContact",    "lblContact");
    setIfExists("descContact",   "descContact");
    $("lblTheme").textContent = MSG("theme");
    $("tLight").textContent = MSG("themeLight");
    $("tDark").textContent = MSG("themeDark");
    $("tSystem").textContent = MSG("themeSystem");
    $("lblUiScale").textContent = MSG("uiScaleLabel");
    $("lblHotkeys").textContent = MSG("hotkeysTitle");
    $("hintShortcuts").textContent = MSG("shortcutsHint");
    $("lblDebounce").textContent = MSG("hotkeyDebounce");
    $("lblBehavior").textContent = MSG("settings");
    $("txtFallback").textContent = MSG("fallbackHotkeys");
    $("txtInputs").textContent = MSG("allowInInputs");
    $("txtPanel").textContent = MSG("showFloatingPanel");
    $("txtToast").textContent = MSG("enableToast");
    $("txtCalc").textContent = MSG("enableCalculator");
    $("txtTabs").textContent = MSG("enableSessionTabs");
    $("lblSmartCopy").textContent = MSG("smartCopySettingsTitle");
    $("hintSmartCopy").textContent = MSG("smartCopySettingsHint");
    $("txtSmartCopyEnabled").textContent = MSG("smartCopyEnabled");
    $("lblSmartCopyButtons").textContent = MSG("smartCopyButtons");
    $("txtSmartCopyAdd").textContent = MSG("smartCopyAdd");
    $("txtSmartCopySubtract").textContent = MSG("smartCopySubtract");
    $("txtSmartCopyMultiply").textContent = MSG("smartCopyMultiply");
    $("txtSmartCopyDivide").textContent = MSG("smartCopyDivide");
    $("lblStartup").textContent = MSG("startupPanel");
    $("hintStartup").textContent = MSG("startupPanelHint");
    $("psRemember").textContent = MSG("startupRemember");
    $("psShow").textContent = MSG("startupShow");
    $("psHide").textContent = MSG("startupHide");
    $("lblTabs").textContent = MSG("tabsLayout");
    $("tabsHoriz").textContent = MSG("tabsHorizontal");
    $("tabsVert").textContent = MSG("tabsVertical");
    $("lblPosition").textContent = MSG("widgetPosition");
    $("lblRight").textContent = MSG("offsetRight");
    $("lblBottom").textContent = MSG("offsetBottom");
    $("btnPosBr").textContent = MSG("presetBottomRight");
    $("btnPosBl").textContent = MSG("presetBottomLeft");
    $("lblHistory").textContent = MSG("historySettings");
    $("lblHistLimit").textContent = MSG("historyLimit");
    $("lblSessions").textContent = MSG("notesTitle");
    $("lblRename").textContent = MSG("renameSession");
    $("btnRename").textContent = MSG("applyRename");
    $("btnDelete").textContent = MSG("deleteSession");
    $("lblExport").textContent = MSG("exportSection");
    $("btnTxt").textContent = MSG("exportTxt");
    $("btnJson").textContent = MSG("exportJson");
    $("btnSessFull").textContent = MSG("exportSession");
    $("hintImportSess").textContent = MSG("importSessionHint");
    $("btnImportSess").textContent = MSG("importSession");
    $("lblSettingsIO").textContent = MSG("settingsBackup");
    $("btnExportSettings").textContent = MSG("exportSettingsTxt");
    $("btnImportSettings").textContent = MSG("importSettingsTxt");
    $("lblDanger").textContent = MSG("dangerZone");
    $("btnResetAll").textContent = MSG("resetAll");

    document.querySelectorAll('input[name="theme"]').forEach((el) => {
      el.addEventListener("change", async () => {
        const v = document.querySelector('input[name="theme"]:checked')?.value;
        if (v) await savePartial({ theme: v });
      });
    });

    $("inpUiScale").addEventListener("input", () => {
      const v = Math.max(0.8, Math.min(1.3, Number($("inpUiScale").value) || 1.0));
      $("uiScaleVal").textContent = Math.round(v * 100) + "%";
    });
    $("inpUiScale").addEventListener("change", async () => {
      const v = Math.max(0.8, Math.min(1.3, Number($("inpUiScale").value) || 1.0));
      $("uiScaleVal").textContent = Math.round(v * 100) + "%";
      await savePartial({ uiScale: v });
    });

    $("chkFallback").addEventListener("change", async (e) => {
      await savePartial({ fallbackHotkeys: e.target.checked });
    });
    $("chkInputs").addEventListener("change", async (e) => {
      await savePartial({ allowInInputs: e.target.checked });
    });
    $("chkPanel").addEventListener("change", async (e) => {
      await savePartial({ showPanel: e.target.checked });
    });
    $("chkToast").addEventListener("change", async (e) => {
      await savePartial({ showToast: e.target.checked });
    });
    $("chkCalc").addEventListener("change", async (e) => {
      await savePartial({ showCalculator: e.target.checked });
    });
    $("chkTabs").addEventListener("change", async (e) => {
      await savePartial({ showSessionTabs: e.target.checked });
    });

    $("chkSmartCopyEnabled").addEventListener("change", async (e) => {
      await saveSmartCopyPanel({ enabled: e.target.checked });
      await load();
    });
    $("chkSmartCopyAdd").addEventListener("change", async (e) => {
      await saveSmartCopyPanel({ buttons: { add: e.target.checked } });
    });
    $("chkSmartCopySubtract").addEventListener("change", async (e) => {
      await saveSmartCopyPanel({ buttons: { subtract: e.target.checked } });
    });
    $("chkSmartCopyMultiply").addEventListener("change", async (e) => {
      await saveSmartCopyPanel({ buttons: { multiply: e.target.checked } });
    });
    $("chkSmartCopyDivide").addEventListener("change", async (e) => {
      await saveSmartCopyPanel({ buttons: { divide: e.target.checked } });
    });

    document.querySelectorAll('input[name="pstart"]').forEach((el) => {
      el.addEventListener("change", async () => {
        const v = document.querySelector('input[name="pstart"]:checked')?.value;
        if (!v) return;
        if (v === "show") await savePartial({ panelStartup: v, showPanel: true });
        else if (v === "hide") await savePartial({ panelStartup: v, showPanel: false });
        else await savePartial({ panelStartup: v });
      });
    });

    document.querySelectorAll('input[name="tabs"]').forEach((el) => {
      el.addEventListener("change", async () => {
        const v = document.querySelector('input[name="tabs"]:checked')?.value;
        if (v) await savePartial({ tabsLayout: v });
      });
    });

    async function savePosition() {
      const right = Math.max(0, Number($("inpRight").value) || 16);
      const bottom = Math.max(0, Number($("inpBottom").value) || 16);
      await savePartial({ panelPosition: { right, bottom } });
    }
    $("inpRight").addEventListener("change", savePosition);
    $("inpBottom").addEventListener("change", savePosition);

    $("btnPosBr").addEventListener("click", async () => {
      $("inpRight").value = "16";
      $("inpBottom").value = "16";
      await savePosition();
    });
    $("btnPosBl").addEventListener("click", async () => {
      $("inpRight").value = "320";
      $("inpBottom").value = "16";
      await savePosition();
    });

    $("inpHistLimit").addEventListener("change", async () => {
      const v = Math.max(10, Math.min(5000, Number($("inpHistLimit").value) || 200));
      $("inpHistLimit").value = String(v);
      await savePartial({ historyLimit: v });
    });

    $("inpDebounce").addEventListener("change", async () => {
      const v = Math.max(0, Math.min(500, Number($("inpDebounce").value) || 140));
      $("inpDebounce").value = String(v);
      await savePartial({ hotkeyDebounceMs: v });
    });

    $("btnRename").addEventListener("click", async () => {
      const state = await loadState();
      const sess = activeSession(state);
      const name = $("inpName").value.trim() || sess.name;
      sess.name = name;
      await saveState(state);
    });

    $("btnDelete").addEventListener("click", async () => {
      if (!confirm(MSG("deleteSession") + "?")) return;
      const state = await loadState();
      if (state.sessions.length <= 1) {
        const s = defaultSession("Default");
        state.sessions = [s];
        state.activeSessionId = s.id;
      } else {
        const id = state.activeSessionId;
        state.sessions = state.sessions.filter((x) => x.id !== id);
        state.activeSessionId = state.sessions[0].id;
        if (state.undoStacks) delete state.undoStacks[id];
        if (state.redoStacks) delete state.redoStacks[id];
      }
      await saveState(state);
      load();
    });

    $("btnTxt").addEventListener("click", async () => {
      const state = await loadState();
      const sess = activeSession(state);
      download(`notemath-note-${(sess.name || "h").replace(/\W+/g, "_")}.txt`, exportHistoryTxt(sess));
    });

    $("btnJson").addEventListener("click", async () => {
      const state = await loadState();
      const sess = activeSession(state);
      const payload = {
        name: sess.name,
        total: sess.total,
        displayDecimals: sess.displayDecimals ?? null,
        initialized: sess.initialized,
        history: sess.history,
        exportedAt: new Date().toISOString(),
      };
      download(
        `notemath-note-${(sess.name || "h").replace(/\W+/g, "_")}.json`,
        JSON.stringify(payload, null, 2),
        "application/json"
      );
    });

    $("btnSessFull").addEventListener("click", async () => {
      const state = await loadState();
      const sess = activeSession(state);
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
        },
      };
      download(
        `notemath-note-full-${(sess.name || "s").replace(/\W+/g, "_")}.json`,
        JSON.stringify(payload, null, 2),
        "application/json"
      );
    });

    $("btnImportSess").addEventListener("click", () => $("fileSess").click());
    $("fileSess").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        mergeImportedSession(String(r.result || ""));
        e.target.value = "";
      };
      r.readAsText(f);
    });

    $("btnExportSettings").addEventListener("click", async () => {
      const state = await loadState();
      const body = serializeSettings(state);
      download("notemath-settings.txt", body, "text/plain;charset=utf-8");
    });

    $("btnImportSettings").addEventListener("click", () => $("fileSettings").click());
    $("fileSettings").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = async () => {
        try {
          const next = parseSettingsJson(String(r.result || ""));
          const state = await loadState();
          state.settings = Object.assign(CalcStorageModel.defaultSettings(), next);
          await saveState(state);
          await load();
        } catch {
          alert(MSG("importFailed"));
        }
        e.target.value = "";
      };
      r.readAsText(f);
    });

    $("btnResetAll").addEventListener("click", async () => {
      if (!confirm(MSG("resetAll") + "?")) return;
      await chrome.storage.local.set({
        [CalcStorageModel.STORAGE_KEY]: CalcStorageModel.defaultState(),
      });
      load();
    });
  }

  bind();
  load();
})();
