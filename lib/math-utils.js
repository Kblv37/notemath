(function (root) {
  const MAX_DECIMALS = 12;

  function clampDecimals(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(MAX_DECIMALS, Math.trunc(v)));
  }

  function roundTo(value, decimals) {
    if (!Number.isFinite(value)) return value;
    const d = clampDecimals(decimals);
    const factor = 10 ** d;
    const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  function baseTextForDecimals(raw) {
    const np = root.CalcNumberParse;
    let s = String(raw ?? "").trim();
    if (!s) return "";
    try {
      if (np?.stripCurrency) s = np.stripCurrency(s);
    } catch {
    }
    s = s.replace(/%$/, "").trim();
    s = s.replace(/[kKmMbB]$/, "");
    try {
      if (np?.normalizeSeparators) s = np.normalizeSeparators(s);
    } catch {
    }
    return s;
  }

  function decimalPlacesFromText(raw) {
    const s = baseTextForDecimals(raw).replace(/^[+-]/, "");
    const dot = s.lastIndexOf(".");
    if (dot < 0) return 0;
    const frac = s.slice(dot + 1).match(/^\d+/);
    return frac ? frac[0].length : 0;
  }

  function estimateDecimals(value, minDecimals, maxDecimals) {
    if (!Number.isFinite(value)) return 0;
    const min = clampDecimals(minDecimals);
    const max = clampDecimals(maxDecimals ?? MAX_DECIMALS);
    const limit = Math.max(min, max);
    const tol = (d) => Math.max(1e-12, 0.5 * 10 ** -(d + 1));
    for (let d = min; d <= limit; d++) {
      const rounded = roundTo(value, d);
      if (Math.abs(rounded - value) <= tol(d)) return d;
    }
    return limit;
  }

  function safeFloatResult(value, minDecimals, maxDecimals) {
    const precision = estimateDecimals(value, minDecimals, maxDecimals);
    return {
      value: roundTo(value, precision),
      precision,
    };
  }

  function formatNumber(value, decimals) {
    if (value == null || !Number.isFinite(value)) return "";
    const d = decimals == null ? null : clampDecimals(decimals);
    const rounded = d == null ? value : roundTo(value, d);
    try {
      if (d == null) {
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: MAX_DECIMALS }).format(rounded);
      }
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      }).format(rounded);
    } catch {
      return d == null ? String(rounded) : rounded.toFixed(d);
    }
  }

  root.CalcMath = {
    MAX_DECIMALS,
    roundTo,
    decimalPlacesFromText,
    safeFloatResult,
    formatNumber,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
