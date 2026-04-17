(function (root) {
  const { parseSingleNumber } = root.CalcNumberParse;

  function isSpace(c) {
    return c && /\s/.test(c);
  }

  function evaluateExpression(str, contextTotal) {
    const s = String(str).trim();
    if (!s) throw new Error("EMPTY");

    const p = new Parser(s, contextTotal);
    return p.parseExpr();
  }

  class Parser {
    constructor(input, contextTotal) {
      this.input = input;
      this.i = 0;
      this.contextTotal = contextTotal;
    }

    skipSpaces() {
      while (isSpace(this.input[this.i])) this.i++;
    }

    peek() {
      this.skipSpaces();
      return this.input[this.i] || "";
    }

    startsWithWord(w) {
      this.skipSpaces();
      return this.input.slice(this.i, this.i + w.length) === w;
    }

    parseNumberOnly() {
      this.skipSpaces();
      const start = this.i;
      const c = this.input[this.i];
      if (c === "+" || c === "-") this.i++;
      while (this.i < this.input.length) {
        const ch = this.input[this.i];
        if (/[0-9]/.test(ch) || ch === "." || ch === "," || ch === " ") {
          this.i++;
          continue;
        }
        if (/[kKmMbB]/.test(ch)) {
          this.i++;
          break;
        }
        break;
      }
      const raw = this.input.slice(start, this.i).trim();
      if (!raw || raw === "+" || raw === "-") throw new Error("BAD_NUMBER");
      return parseSingleNumber(raw, {});
    }

    parseAtom() {
      this.skipSpaces();
      const c = this.peek();
      if (c === "(") {
        this.i++;
        const v = this.parseAddSub();
        this.skipSpaces();
        if (this.input[this.i] !== ")") throw new Error("EXPECTED_PAREN");
        this.i++;
        return v;
      }
      if (/[0-9.,]/.test(c)) {
        return this.parseNumberOnly();
      }
      throw new Error("UNEXPECTED");
    }

    parseSqrtOrAtom() {
      this.skipSpaces();
      if (this.startsWithWord("sqrt")) {
        this.i += 4;
        this.skipSpaces();
        if (this.input[this.i] !== "(") throw new Error("EXPECTED_PAREN");
        this.i++;
        const v = this.parseAddSub();
        this.skipSpaces();
        if (this.input[this.i] !== ")") throw new Error("EXPECTED_PAREN");
        this.i++;
        if (v < 0) throw new Error("BAD_NUMBER");
        const r = Math.sqrt(v);
        if (!Number.isFinite(r)) throw new Error("BAD_NUMBER");
        return r;
      }
      if (this.peek() === "√") {
        this.i++;
        this.skipSpaces();
        let v;
        if (this.input[this.i] === "(") {
          this.i++;
          v = this.parseAddSub();
          this.skipSpaces();
          if (this.input[this.i] !== ")") throw new Error("EXPECTED_PAREN");
          this.i++;
        } else {
          v = this.parseAtom();
        }
        if (v < 0) throw new Error("BAD_NUMBER");
        const r = Math.sqrt(v);
        if (!Number.isFinite(r)) throw new Error("BAD_NUMBER");
        return r;
      }
      return this.parseAtom();
    }

    parsePow() {
      let left = this.parseSqrtOrAtom();
      for (;;) {
        this.skipSpaces();
        if (this.input[this.i] === "^" && this.input[this.i + 1] === "2") {
          this.i += 2;
          left = left * left;
          if (!Number.isFinite(left)) throw new Error("BAD_NUMBER");
          continue;
        }
        if (this.input[this.i] === "²") {
          this.i++;
          left = left * left;
          if (!Number.isFinite(left)) throw new Error("BAD_NUMBER");
          continue;
        }
        break;
      }
      return left;
    }

    parseUnary() {
      this.skipSpaces();
      const c = this.peek();
      if (c === "-") {
        this.i++;
        const v = this.parseUnary();
        return -v;
      }
      if (c === "+") {
        this.i++;
        return this.parseUnary();
      }
      return this.parsePow();
    }

    parseMulDiv() {
      let left = this.parseUnary();
      for (;;) {
        this.skipSpaces();
        const op = this.input[this.i];
        if (op !== "*" && op !== "×" && op !== "/" && op !== "÷") break;
        this.i++;
        let right = this.parseUnary();
        this.skipSpaces();
        if (this.input[this.i] === "%") {
          this.i++;
          const p = right;
          const isMul = op === "*" || op === "×";
          if (isMul) right = (left * p) / 100;
          else right = p === 0 ? NaN : p / 100;
        }
        const isMul = op === "*" || op === "×";
        if (isMul) left = left * right;
        else left = right === 0 ? NaN : left / right;
        if (!Number.isFinite(left)) throw new Error("BAD_NUMBER");
      }
      return left;
    }

    parseAddSub() {
      let left = this.parseMulDiv();
      for (;;) {
        this.skipSpaces();
        const op = this.input[this.i];
        if (op !== "+" && op !== "-" && op !== "−") break;
        this.i++;
        let right = this.parseMulDiv();
        this.skipSpaces();
        if (this.input[this.i] === "%") {
          this.i++;
          const p = right;
          right = (left * p) / 100;
        }
        const isSub = op === "-" || op === "−";
        if (isSub) left = left - right;
        else left = left + right;
        if (!Number.isFinite(left)) throw new Error("BAD_NUMBER");
      }
      return left;
    }

    parseExpr() {
      let v = this.parseAddSub();
      this.skipSpaces();
      if (this.input[this.i] === "%") {
        this.i++;
        const base = this.contextTotal;
        const baseOk = base != null && Number.isFinite(base) && base !== 0;
        v = baseOk ? (base * v) / 100 : v / 100;
      }
      this.skipSpaces();
      if (this.i < this.input.length) throw new Error("TRAILING");
      return v;
    }
  }

  function parseOperand(raw, currentTotal) {
    const s = String(raw).trim();
    if (!s) throw new Error("EMPTY");
    const ctx =
      currentTotal != null && Number.isFinite(currentTotal) ? currentTotal : 0;
    const hasParenOrOp = /[+\-*/()×÷√^²%]/.test(s) || /\bsqrt\b/i.test(s);
    if (hasParenOrOp) {
      return evaluateExpression(s, ctx);
    }
    return parseSingleNumber(s, {
      percentMode: "ofContext",
      contextTotal: ctx,
    });
  }

  root.CalcParser = { evaluateExpression, parseOperand };
})(typeof globalThis !== "undefined" ? globalThis : this);
