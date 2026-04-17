(function () {
  const { parseOperand } = CalcParser;
  const { loadState, saveState, defaultSession, ensureUndoStack, ensureRedoStack, clearRedoStack } =
    CalcStorageModel;
  const MSG = (k) => chrome.i18n.getMessage(k) || k;
  const DEFAULT_PANEL_POSITION = { right: 16, bottom: 16 };

  const $ = (id) => document.getElementById(id);
  let notesTimer = null;
  let pendingNotes = null;

  function activeNote(state) {
    return state.sessions.find((s) => s.id === state.activeSessionId) || state.sessions[0];
  }

  async function flushNotes() {
    if (!pendingNotes) return;
    const { sessionId, text } = pendingNotes;
    pendingNotes = null;
    clearTimeout(notesTimer);
    notesTimer = null;
    const state = await loadState();
    const sess = state.sessions.find((s) => s.id === sessionId);
    if (!sess) return;
    sess.notes = text;
    await saveState(state);
  }

  function queueNotesSave(sessionId, text) {
    pendingNotes = { sessionId, text };
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      void flushNotes().catch(() => {});
    }, 220);
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

  function sessionPrecision(sess) {
    return Number.isInteger(sess?.displayDecimals) && sess.displayDecimals >= 0 ? sess.displayDecimals : 0;
  }

  function safeResult(value, minDecimals) {
    if (CalcMath?.safeFloatResult) {
      return CalcMath.safeFloatResult(value, minDecimals, CalcMath.MAX_DECIMALS);
    }
    const precision = Math.max(0, Math.min(12, minDecimals | 0));
    const factor = 10 ** precision;
    const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
    return { value: Object.is(rounded, -0) ? 0 : rounded, precision };
  }

  function precisionHint(raw) {
    if (CalcMath?.decimalPlacesFromText) return CalcMath.decimalPlacesFromText(raw);
    const m = String(raw || "").match(/[.,](\d+)\s*$/);
    return m ? m[1].length : 0;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function noteTabsHtml(state) {
    const closeSvg =
      '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    return state.sessions
      .map((s) => {
        const active = s.id === state.activeSessionId;
        const title = s.name || MSG("session");
        return `
          <div class="noteTab${active ? " active" : ""}" role="presentation">
            <button type="button" class="noteTabBtn" data-note="${escapeHtml(s.id)}" role="tab" aria-selected="${active ? "true" : "false"}" title="${escapeHtml(title)}">${escapeHtml(title)}</button>
            <button type="button" class="noteTabClose" data-note-close="${escapeHtml(s.id)}" aria-label="${escapeHtml(MSG("deleteSession"))}">${closeSvg}</button>
          </div>`;
      })
      .join("");
  }

  function noteHistoryLines(sess) {
    if (!sess?.history?.length) return MSG("historyEmpty");
    return sess.history
      .map((h) => {
        const note = h.raw && String(h.raw) !== String(h.label) ? ` (${h.raw})` : "";
        return `${h.label}${note}`;
      })
      .join("\n");
  }

  function exportHistoryTxt(sess) {
    const lines = [];
    lines.push(`${MSG("session")}: ${sess.name || MSG("session")}`);
    lines.push("=".repeat(40));
    lines.push("");
    const history = sess.history || [];
    if (history.length === 0) {
      lines.push(MSG("historyEmpty"));
    } else {
      history.forEach((h) => {
        const note = h.raw && String(h.raw) !== String(h.label) ? ` (${h.raw})` : "";
        lines.push(`${h.label}${note}`);
      });
    }
    lines.push("");
    lines.push(`${MSG("total")}: ${formatTotal(sess.total, sess.displayDecimals) || "0"}`);
    if (sess.notes && sess.notes.trim()) {
      lines.push("");
      lines.push(`${MSG("notesTitle")}:`);
      lines.push(sess.notes.trim());
    }
    lines.push("");
    lines.push(`NoteMath — ${new Date().toLocaleString()}`);
    return lines.join("\n");
  }

  function snapshotSession(sess) {
    return {
      total: sess.total,
      displayDecimals: sess.displayDecimals ?? null,
      initialized: sess.initialized,
      history: sess.history.map((h) => Object.assign({}, h)),
    };
  }

  function pushUndo(state, sess) {
    const stack = ensureUndoStack(state, sess.id);
    stack.push(snapshotSession(sess));
    if (stack.length > 80) stack.shift();
  }

  function trimHistory(state, sess) {
    const lim = Math.max(10, Math.min(5000, state.settings.historyLimit | 0 || 200));
    if (sess.history.length > lim) {
      sess.history.splice(0, sess.history.length - lim);
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
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

  async function render() {
    const state = await loadState();
    const sess = activeNote(state);

    $("noteTabs").innerHTML = noteTabsHtml(state);

    $("elTotal").textContent = formatTotal(sess.total, sess.displayDecimals) || "0";
    $("hist").textContent = noteHistoryLines(sess);
    $("inpNoteName").value = sess.name || "";
    $("txtNotes").value = sess.notes || "";
    $("noteState").textContent = MSG("notesAutosave");
    $("chkPanel").checked = !!state.settings.showPanel;
    $("elCalcOut").textContent = "";

    window.__pcState = state;
    window.__pcSession = sess;
    window.__pcNote = sess;
  }

  function bind() {
    document.title = MSG("extName");
    $("extTitle").textContent = MSG("extName");
    $("btnOpenCalc").textContent = MSG("openCalculator");
    $("btnOptions").textContent = MSG("popupOpenOptions");
    $("lblNotesList").textContent = MSG("notesTitle");
    $("btnNew").innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M7.25 2h1.5v4.25H13v1.5H8.75V12H7.25V7.75H3v-1.5h4.25z"/></svg>';
    $("btnNew").title = MSG("newSession");
    $("btnNew").setAttribute("aria-label", MSG("newSession"));
    $("lblExpr").textContent = MSG("expression");
    $("btnAdd").textContent = MSG("addToTotal");
    $("btnEval").textContent = MSG("calculateOnly");
    $("lblTotal").textContent = MSG("total");
    $("btnCopy").textContent = MSG("copy");
    $("btnUndo").textContent = MSG("undo");
    $("btnRedo").textContent = MSG("redo");
    $("btnReset").textContent = MSG("reset");
    $("btnTxt").textContent = MSG("exportTxt");
    $("btnJson").textContent = MSG("exportJson");
    $("inpNoteName").placeholder = MSG("renameSession");
    $("btnRename").textContent = MSG("applyRename");
    $("btnRename").title = MSG("applyRename");
    $("btnDelete").textContent = MSG("deleteSession");
    $("btnDelete").title = MSG("deleteSession");
    $("btnDelete").setAttribute("aria-label", MSG("deleteSession"));
    $("lblNotes").textContent = MSG("notesTitle");
    $("txtNotes").placeholder = MSG("notesPlaceholder");
    $("noteHint").textContent = MSG("notesAutosave");
    $("lblPanel").textContent = MSG("showFloatingPanel");
    $("btnResetPos").textContent = MSG("resetPosition");

    $("btnOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

    $("btnOpenCalc").addEventListener("click", async () => {
      await flushNotes().catch(() => {});
      const st = await loadState();
      st.settings.showPanel = true;
      await saveState(st);
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id != null) {
          await chrome.tabs.sendMessage(tab.id, { type: "OPEN_PANEL" });
        }
      } catch {
      }
      window.close();
    });

    async function selectNote(id) {
      await saveNoteName().catch(() => {});
      await flushNotes().catch(() => {});
      const state = await loadState();
      if (!state.sessions.some((s) => s.id === id)) return;
      state.activeSessionId = id;
      await saveState(state);
      await render();
    }

    async function saveNoteName() {
      const state = await loadState();
      const sess = activeNote(state);
      if (!sess) return;
      const name = $("inpNoteName").value.trim().slice(0, 64);
      if (!name || name === sess.name) {
        $("inpNoteName").value = sess.name || "";
        return;
      }
      sess.name = name;
      await saveState(state);
      await render();
    }

    async function createNote() {
      await saveNoteName().catch(() => {});
      await flushNotes().catch(() => {});
      const state = await loadState();
      const n = state.sessions.length + 1;
      const note = defaultSession(`${MSG("session")} ${n}`);
      state.sessions.push(note);
      state.activeSessionId = note.id;
      await saveState(state);
      await render();
    }

    async function deleteNote(id) {
      await saveNoteName().catch(() => {});
      await flushNotes().catch(() => {});
      const state = await loadState();
      if (state.sessions.length <= 1) {
        const note = defaultSession(MSG("session"));
        state.sessions = [note];
        state.activeSessionId = note.id;
      } else {
        const targetId = id || state.activeSessionId;
        const idx = state.sessions.findIndex((s) => s.id === targetId);
        if (idx < 0) return;
        state.sessions = state.sessions.filter((s) => s.id !== targetId);
        const next = state.sessions[Math.max(0, idx - 1)] || state.sessions[0];
        state.activeSessionId = next.id;
        if (state.undoStacks) delete state.undoStacks[targetId];
        if (state.redoStacks) delete state.redoStacks[targetId];
      }
      await saveState(state);
      await render();
    }

    $("btnNew").addEventListener("click", createNote);
    $("btnRename").addEventListener("click", saveNoteName);
    $("btnDelete").addEventListener("click", async () => {
      if (!confirm(MSG("deleteSession") + "?")) return;
      const state = await loadState();
      await deleteNote(state.activeSessionId);
    });

    $("inpNoteName").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void saveNoteName();
      }
    });

    $("inpNoteName").addEventListener("blur", () => {
      void saveNoteName().catch(() => {});
    });

    $("noteTabs").addEventListener("click", async (e) => {
      const close = e.target.closest?.("[data-note-close]");
      if (close) {
        e.preventDefault();
        e.stopPropagation();
        const id = close.getAttribute("data-note-close");
        if (!confirm(MSG("deleteSession") + "?")) return;
        await deleteNote(id);
        return;
      }
      const tab = e.target.closest?.("[data-note]");
      if (!tab) return;
      const id = tab.getAttribute("data-note");
      if (id && id !== (window.__pcState?.activeSessionId || "")) {
        await selectNote(id);
      }
    });

    $("btnAdd").addEventListener("click", async () => {
      const raw = $("inpExpr").value.trim();
      if (!raw) return;
      const state = await loadState();
      const sess = activeNote(state);
      if (!sess) return;
      let operand;
      try {
        operand = parseOperand(raw, sess.total);
      } catch {
        $("elCalcOut").textContent = MSG("errNoNumber");
        return;
      }
      if (!Number.isFinite(operand)) {
        $("elCalcOut").textContent = MSG("errNoNumber");
        return;
      }
      clearRedoStack(state, sess.id);
      pushUndo(state, sess);
      const sym = "+";
      let nextTotal;
      let nextPrecision;
      let label;
      const operandPrecision = precisionHint(raw);
      if (!sess.initialized) {
        const normalized = safeResult(operand, operandPrecision);
        nextTotal = normalized.value;
        nextPrecision = normalized.precision;
        label = `${sym}${operand}`;
        sess.initialized = true;
      } else {
        const minPrecision = Math.max(sessionPrecision(sess), operandPrecision);
        const normalized = safeResult(sess.total + operand, minPrecision);
        nextTotal = normalized.value;
        nextPrecision = normalized.precision;
        label = `${sym}${operand}`;
      }
      if (!Number.isFinite(nextTotal)) {
        $("elCalcOut").textContent = MSG("errNoNumber");
        ensureUndoStack(state, sess.id).pop();
        return;
      }
      sess.total = nextTotal;
      sess.displayDecimals = nextPrecision;
      sess.history.push({
        op: "add",
        label,
        operand,
        raw,
        result: nextTotal,
        t: Date.now(),
      });
      trimHistory(state, sess);
      await saveState(state);
      $("inpExpr").value = "";
      $("elCalcOut").textContent = "";
      render();
    });

    $("btnEval").addEventListener("click", async () => {
      const raw = $("inpExpr").value.trim();
      if (!raw) return;
      const state = await loadState();
      const sess = activeNote(state);
      const ctx = sess?.total != null && Number.isFinite(sess.total) ? sess.total : 0;
      try {
        const v = parseOperand(raw, ctx);
        if (!Number.isFinite(v)) throw new Error("x");
        $("elCalcOut").textContent = formatTotal(v);
      } catch {
        $("elCalcOut").textContent = MSG("errNoNumber");
      }
    });

    $("btnCopy").addEventListener("click", async () => {
      const sess = window.__pcNote || window.__pcSession;
      if (!sess || sess.total == null || !Number.isFinite(sess.total)) return;
      await copyText(formatTotal(sess.total, sess.displayDecimals));
    });

    $("btnUndo").addEventListener("click", async () => {
      const state = await loadState();
      const sess = activeNote(state);
      if (!sess) return;
      const stack = ensureUndoStack(state, sess.id);
      const prev = stack.pop();
      if (!prev) return;
      const redo = ensureRedoStack(state, sess.id);
      redo.push(snapshotSession(sess));
      sess.total = prev.total;
      sess.displayDecimals = prev.displayDecimals ?? null;
      sess.initialized = prev.initialized;
      sess.history = prev.history;
      await saveState(state);
      render();
    });

    $("btnRedo").addEventListener("click", async () => {
      const state = await loadState();
      const sess = activeNote(state);
      if (!sess) return;
      const stack = ensureRedoStack(state, sess.id);
      const next = stack.pop();
      if (!next) return;
      pushUndo(state, sess);
      sess.total = next.total;
      sess.displayDecimals = next.displayDecimals ?? null;
      sess.initialized = next.initialized;
      sess.history = next.history;
      await saveState(state);
      render();
    });

    $("btnReset").addEventListener("click", async () => {
      const state = await loadState();
      const sess = activeNote(state);
      if (!sess) return;
      clearRedoStack(state, sess.id);
      CalcStorageModel.ensureUndoStack(state, sess.id).push(snapshotSession(sess));
      sess.total = null;
      sess.displayDecimals = null;
      sess.initialized = false;
      sess.history = [];
      await saveState(state);
      render();
    });

    $("txtNotes").addEventListener("input", () => {
      const state = window.__pcState;
      const sess = window.__pcSession;
      if (!state || !sess) return;
      queueNotesSave(sess.id, $("txtNotes").value);
      $("noteState").textContent = MSG("notesAutosave");
    });

    $("txtNotes").addEventListener("blur", () => {
      void flushNotes().catch(() => {});
    });

    $("btnResetPos").addEventListener("click", async () => {
      await flushNotes().catch(() => {});
      const state = await loadState();
      state.settings.panelPosition = Object.assign({}, DEFAULT_PANEL_POSITION);
      await saveState(state);
      await render();
    });

    $("btnTxt").addEventListener("click", async () => {
      await flushNotes().catch(() => {});
      const state = await loadState();
      const sess = activeNote(state);
      if (!sess) return;
      const filename = `notemath-${(sess.name || "note").replace(/\W+/g, "_")}.txt`;
      download(filename, exportHistoryTxt(sess));
    });

    $("btnJson").addEventListener("click", async () => {
      await flushNotes().catch(() => {});
      const state = await loadState();
      const sess = activeNote(state);
      if (!sess) return;
      const payload = {
        name: sess.name,
        total: sess.total,
        displayDecimals: sess.displayDecimals ?? null,
        initialized: sess.initialized,
        history: sess.history,
        notes: sess.notes || "",
        exportedAt: new Date().toISOString(),
      };
      download(
        `notemath-${(sess.name || "note").replace(/\W+/g, "_")}.json`,
        JSON.stringify(payload, null, 2),
        "application/json"
      );
    });

    $("chkPanel").addEventListener("change", async (e) => {
      const state = await loadState();
      state.settings.showPanel = e.target.checked;
      await saveState(state);
    });

    window.addEventListener("beforeunload", () => {
      void flushNotes().catch(() => {});
    });
  }

  bind();
  render();
})();
