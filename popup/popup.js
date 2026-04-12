(function () {
  const { parseOperand } = CalcParser;
  const { loadState, saveState, defaultSession, ensureUndoStack, ensureRedoStack, clearRedoStack } =
    CalcStorageModel;
  const MSG = (k) => chrome.i18n.getMessage(k) || k;

  const $ = (id) => document.getElementById(id);

  function formatTotal(n) {
    if (n == null || !Number.isFinite(n)) return "";
    try {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 }).format(n);
    } catch {
      return String(n);
    }
  }

  function sessionLines(sess) {
    if (!sess?.history?.length) return MSG("historyEmpty");
    return sess.history.map((h) => h.label).join("\n");
  }

  function exportHistoryTxt(sess) {
    const lines = (sess.history || []).map((h) => {
      const note = h.raw && String(h.raw) !== String(h.label) ? ` (${h.raw})` : "";
      return `${h.label}${note}`;
    });
    lines.push(`= ${formatTotal(sess.total) || "0"}`);
    return lines.join("\n");
  }

  function snapshotSession(sess) {
    return {
      total: sess.total,
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
    const sess =
      state.sessions.find((s) => s.id === state.activeSessionId) || state.sessions[0];

    $("selSession").innerHTML = "";
    state.sessions.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.name;
      if (s.id === state.activeSessionId) o.selected = true;
      $("selSession").appendChild(o);
    });

    $("elTotal").textContent = formatTotal(sess.total) || "0";
    $("hist").textContent = sessionLines(sess);
    $("chkPanel").checked = !!state.settings.showPanel;
    $("elCalcOut").textContent = "";

    window.__pcState = state;
    window.__pcSession = sess;
  }

  function bind() {
    $("extTitle").textContent = chrome.runtime.getManifest().name.split("—")[0].trim();
    $("btnOpenCalc").textContent = MSG("openCalculator");
    $("btnOptions").textContent = MSG("popupOpenOptions");
    $("lblSession").textContent = MSG("session");
    $("btnNew").textContent = MSG("newSession");
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
    $("lblPanel").textContent = MSG("showFloatingPanel");

    $("btnOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

    $("btnOpenCalc").addEventListener("click", async () => {
      const st = await loadState();
      st.settings.showPanel = true;
      await saveState(st);
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id != null) {
          await chrome.tabs.sendMessage(tab.id, { type: "OPEN_PANEL" });
        }
      } catch {
        /* content script may be unavailable on restricted pages */
      }
      window.close();
    });

    $("selSession").addEventListener("change", async (e) => {
      const state = await loadState();
      state.activeSessionId = e.target.value;
      await saveState(state);
      render();
    });

    $("btnNew").addEventListener("click", async () => {
      const state = await loadState();
      const n = state.sessions.length + 1;
      const s = defaultSession(`${MSG("session")} ${n}`);
      state.sessions.push(s);
      state.activeSessionId = s.id;
      await saveState(state);
      render();
    });

    $("btnAdd").addEventListener("click", async () => {
      const raw = $("inpExpr").value.trim();
      if (!raw) return;
      const state = await loadState();
      const sess = state.sessions.find((s) => s.id === state.activeSessionId);
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
      let label;
      if (!sess.initialized) {
        nextTotal = operand;
        label = `${sym}${operand}`;
        sess.initialized = true;
      } else {
        nextTotal = sess.total + operand;
        label = `${sym}${operand}`;
      }
      if (!Number.isFinite(nextTotal)) {
        $("elCalcOut").textContent = MSG("errNoNumber");
        ensureUndoStack(state, sess.id).pop();
        return;
      }
      sess.total = nextTotal;
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
      const sess = state.sessions.find((s) => s.id === state.activeSessionId);
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
      const sess = window.__pcSession;
      if (!sess || sess.total == null || !Number.isFinite(sess.total)) return;
      await copyText(String(sess.total));
    });

    $("btnUndo").addEventListener("click", async () => {
      const state = await loadState();
      const sess = state.sessions.find((s) => s.id === state.activeSessionId);
      if (!sess) return;
      const stack = ensureUndoStack(state, sess.id);
      const prev = stack.pop();
      if (!prev) return;
      const redo = ensureRedoStack(state, sess.id);
      redo.push(snapshotSession(sess));
      sess.total = prev.total;
      sess.initialized = prev.initialized;
      sess.history = prev.history;
      await saveState(state);
      render();
    });

    $("btnRedo").addEventListener("click", async () => {
      const state = await loadState();
      const sess = state.sessions.find((s) => s.id === state.activeSessionId);
      if (!sess) return;
      const stack = ensureRedoStack(state, sess.id);
      const next = stack.pop();
      if (!next) return;
      pushUndo(state, sess);
      sess.total = next.total;
      sess.initialized = next.initialized;
      sess.history = next.history;
      await saveState(state);
      render();
    });

    $("btnReset").addEventListener("click", async () => {
      const state = await loadState();
      const sess = state.sessions.find((s) => s.id === state.activeSessionId);
      if (!sess) return;
      clearRedoStack(state, sess.id);
      CalcStorageModel.ensureUndoStack(state, sess.id).push(snapshotSession(sess));
      sess.total = null;
      sess.initialized = false;
      sess.history = [];
      await saveState(state);
      render();
    });

    $("btnTxt").addEventListener("click", async () => {
      const sess = window.__pcSession;
      if (!sess) return;
      download(`NoteMath-${sess.name.replace(/\W+/g, "_")}.txt`, exportHistoryTxt(sess));
    });

    $("btnJson").addEventListener("click", async () => {
      const sess = window.__pcSession;
      if (!sess) return;
      const payload = {
        name: sess.name,
        total: sess.total,
        initialized: sess.initialized,
        history: sess.history,
        exportedAt: new Date().toISOString(),
      };
      download(
        `NoteMath-${sess.name.replace(/\W+/g, "_")}.json`,
        JSON.stringify(payload, null, 2),
        "application/json"
      );
    });

    $("chkPanel").addEventListener("change", async (e) => {
      const state = await loadState();
      state.settings.showPanel = e.target.checked;
      await saveState(state);
    });
  }

  bind();
  render();
})();
