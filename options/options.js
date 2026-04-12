(function () {
  const { loadState, saveState, defaultSession, parseSettingsJson, serializeSettings } = CalcStorageModel;
  const MSG = (k) => chrome.i18n.getMessage(k) || k;

  const $ = (id) => document.getElementById(id);

  function activeSession(state) {
    return state.sessions.find((s) => s.id === state.activeSessionId) || state.sessions[0];
  }

  function formatTotal(n) {
    if (n == null || !Number.isFinite(n)) return "";
    try {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 }).format(n);
    } catch {
      return String(n);
    }
  }

  function exportHistoryTxt(sess) {
    const lines = (sess.history || []).map((h) => {
      const note = h.raw && String(h.raw) !== String(h.label) ? ` (${h.raw})` : "";
      return `${h.label}${note}`;
    });
    lines.push(`= ${formatTotal(sess.total) || "0"}`);
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
      initialized: sess.initialized,
      history: sess.history.map((h) => Object.assign({}, h)),
    });
    state.redoStacks[sess.id] = [];
    sess.name = String(inner.name || sess.name).slice(0, 64);
    sess.total = inner.total != null ? Number(inner.total) : null;
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
    $("chkNotes").checked = s.showNotes !== false;

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

    const sess = activeSession(state);
    $("inpName").value = sess.name || "";
  }

  async function savePartial(partial) {
    const state = await loadState();
    Object.assign(state.settings, partial);
    await saveState(state);
  }

  function bind() {
    $("pageTitle").textContent = MSG("optionsTitle");
    $("lblTheme").textContent = MSG("theme");
    $("tLight").textContent = MSG("themeLight");
    $("tDark").textContent = MSG("themeDark");
    $("tSystem").textContent = MSG("themeSystem");
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
    $("txtNotesField").textContent = MSG("enableNotesField");
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
    $("lblSessions").textContent = MSG("session");
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
    $("chkNotes").addEventListener("change", async (e) => {
      await savePartial({ showNotes: e.target.checked });
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
      download(`NoteMath-${(sess.name || "h").replace(/\W+/g, "_")}.txt`, exportHistoryTxt(sess));
    });

    $("btnJson").addEventListener("click", async () => {
      const state = await loadState();
      const sess = activeSession(state);
      const payload = {
        name: sess.name,
        total: sess.total,
        initialized: sess.initialized,
        history: sess.history,
        exportedAt: new Date().toISOString(),
      };
      download(
        `NoteMath-${(sess.name || "h").replace(/\W+/g, "_")}.json`,
        JSON.stringify(payload, null, 2),
        "application/json"
      );
    });

    $("btnSessFull").addEventListener("click", async () => {
      const state = await loadState();
      const sess = activeSession(state);
      const payload = {
        type: "NoteMath-session",
        version: 1,
        exportedAt: new Date().toISOString(),
        session: {
          name: sess.name,
          total: sess.total,
          initialized: sess.initialized,
          history: sess.history,
          notes: sess.notes || "",
          replySnapshots: sess.replySnapshots || [],
        },
      };
      download(
        `NoteMath-session-${(sess.name || "s").replace(/\W+/g, "_")}.json`,
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
      download("NoteMath-settings.txt", body, "text/plain;charset=utf-8");
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
