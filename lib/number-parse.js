/**
 * Parses a single numeric literal from user-selected text.
 * Supports: spaces as thousands, comma/dot heuristics, currencies, suffixes k/m/b, trailing %.
 */
(function (root) {
  const SUFFIX = { k: 1e3, m: 1e6, b: 1e9, K: 1e3, M: 1e6, B: 1e9 };

  const CURRENCY_TAIL =
    /\s*(руб\.?|р\.?|₽|сум|сўм|so'm|uzs|USD|US\$|\$|EUR|€|GBP|£|UAH|₴|KZT|₸|TRY|₺|INR|₹)\s*$/i;

  function stripCurrency(s) {
    let t = String(s).trim();
    let prev;
    do {
      prev = t;
      t = t.replace(CURRENCY_TAIL, "").trim();
    } while (t !== prev);
    return t;
  }

  /**
   * Join digit groups separated by spaces when forming one number.
   * - "12 843 98" / "12843 98" → last group 2 digits = fractional (kopeks): 12843.98
   * - "120 000" → thousands (last group 3 digits, prior groups ≤3)
   * - Otherwise concatenate all groups (e.g. legacy "120 12" → 12012 when last ≠ 2 digits)
   */
  function joinSpaceSeparatedDigits(parts) {
    const allDigits = parts.every((p) => /^\d+$/.test(p));
    if (!allDigits || parts.length < 2) return parts.join(" ");

    const last = parts[parts.length - 1];
    const rest = parts.slice(0, -1);

    if (last.length === 2 && rest.length >= 1) {
      return `${rest.join("")}.${last}`;
    }

    const thousandsLike =
      last.length === 3 && rest.length > 0 && rest.every((p) => p.length >= 1 && p.length <= 3);
    if (thousandsLike) return rest.join("") + last;

    return parts.join("");
  }

  /**
   * Remove spaces used as thousand separators between digits; keep semantic spaces handled above.
   */
  function collapseDigitSpaces(s) {
    if (!/\s/.test(s)) return s;
    const chunks = s.split(/\s+/).filter(Boolean);
    if (chunks.length > 1 && chunks.every((c) => /^[\d.,]+$/.test(c))) {
      const noSepInChunks = chunks.every((c) => !/[.,]/.test(c));
      if (noSepInChunks) return joinSpaceSeparatedDigits(chunks);
    }
    return s.replace(/(\d)\s+(?=\d)/g, "$1");
  }

  /**
   * Heuristic: if both ',' and '.' appear, the rightmost separator is decimal;
   * the other groups thousands (European 1.234,56 → 1234.56; US 1,234.56 → 1234.56).
   */
  function normalizeSeparators(raw) {
    let s = raw.trim();
    if (!s) return s;

    let sign = "";
    const signMatch = s.match(/^([+-])\s*/);
    if (signMatch) {
      sign = signMatch[1];
      s = s.slice(signMatch[0].length).trimStart();
    }

    s = collapseDigitSpaces(s);

    const compact = s.replace(/\s/g, "");
    if (!compact.includes(",") && /^\d{1,3}(\.\d{3})+$/.test(compact)) {
      return sign + compact.replace(/\./g, "");
    }
    if (!compact.includes(".") && /^\d{1,3}(,\d{3})+$/.test(compact)) {
      return sign + compact.replace(/,/g, "");
    }

    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      const lastComma = s.lastIndexOf(",");
      const lastDot = s.lastIndexOf(".");
      if (lastComma > lastDot) {
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (hasComma && !hasDot) {
      const parts = s.split(",");
      if (parts.length === 2 && parts[1].length <= 2) {
        s = parts[0].replace(/\s/g, "") + "." + parts[1];
      } else {
        s = s.replace(/,/g, "");
      }
    } else {
      s = s.replace(/,/g, "");
    }
    return sign + s;
  }

  function parseSingleNumber(str, options) {
    const opts = options || {};
    let s = stripCurrency(String(str).trim());
    if (!s) throw new Error("EMPTY");

    let percent = false;
    if (s.endsWith("%")) {
      percent = true;
      s = s.slice(0, -1).trim();
    }

    s = stripCurrency(s);
    s = normalizeSeparators(s);

    let suf = 1;
    const last = s.slice(-1);
    if (SUFFIX[last] !== undefined) {
      suf = SUFFIX[last];
      s = s.slice(0, -1);
      s = normalizeSeparators(s);
    }

    if (s === "" || s === "-" || s === "+") throw new Error("BAD_NUMBER");

    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error("BAD_NUMBER");

    let v = n * suf;
    if (percent) {
      const ctx = opts.contextTotal;
      const ctxOk =
        opts.percentMode === "ofContext" &&
        ctx != null &&
        Number.isFinite(ctx) &&
        ctx !== 0;
      if (ctxOk) {
        v = (ctx * n) / 100;
      } else {
        v = (n * suf) / 100;
      }
    }
    return v;
  }

  root.CalcNumberParse = { parseSingleNumber, normalizeSeparators, stripCurrency };
})(typeof globalThis !== "undefined" ? globalThis : this);
