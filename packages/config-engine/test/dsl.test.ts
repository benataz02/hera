import { describe, expect, test } from "bun:test";
import { DslError, parse, evaluate } from "../src/dsl";
import { lookups } from "./fixture";

describe("parse", () => {
  test("precedence: 1 + 2 * 3 groups as 1 + (2*3)", () => {
    const ast = parse("1 + 2 * 3");
    expect(ast.t).toBe("bin");
    if (ast.t === "bin") {
      expect(ast.op).toBe("+");
      expect(ast.r.t).toBe("bin");
    }
  });

  test("comparison binds looser than arithmetic, && looser than ==", () => {
    const ast = parse('a + 1 > 2 && b == "x"');
    expect(ast.t).toBe("bin");
    if (ast.t === "bin") expect(ast.op).toBe("&&");
  });

  test("ternary", () => {
    const ast = parse("a > 1 ? 2 : 3");
    expect(ast.t).toBe("tern");
  });

  test("call with args and spans covering the whole call", () => {
    const src = 'LOOKUP("t", "k", x, "v")';
    const ast = parse(src);
    expect(ast.t).toBe("call");
    expect(ast.from).toBe(0);
    expect(ast.to).toBe(src.length);
  });

  test("true/false/null are literals", () => {
    expect(parse("true").t).toBe("lit");
    expect(parse("null").t).toBe("lit");
  });

  test("error carries span: unterminated string", () => {
    try {
      parse('CONCAT("abc');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      expect((e as DslError).from).toBe(7);
    }
  });

  test("error carries span: trailing garbage", () => {
    try {
      parse("1 + 2 )");
      expect.unreachable();
    } catch (e) {
      expect((e as DslError).from).toBe(6);
      expect((e as DslError).to).toBe(7);
    }
  });

  test("unexpected character", () => {
    expect(() => parse("a $ b")).toThrow(DslError);
  });
});

describe("evaluate", () => {
  const scope = { vars: { a: 2, s: "steel", flag: true, empty: null as null }, tables: lookups.tables };

  test("arithmetic and precedence", () => {
    expect(evaluate("1 + a * 3", scope)).toBe(7);
    expect(evaluate("-a + 10", scope)).toBe(8);
    expect(evaluate("7 % 4", scope)).toBe(3);
  });

  test("strict equality without coercion", () => {
    expect(evaluate('s == "steel"', scope)).toBe(true);
    expect(evaluate('a == "2"', scope)).toBe(false);
    expect(evaluate("empty == null", scope)).toBe(true);
    expect(evaluate("empty != null", scope)).toBe(false);
  });

  test("boolean ops are strict and short-circuit", () => {
    expect(evaluate("flag && a > 1", scope)).toBe(true);
    expect(evaluate("!flag || a > 1", scope)).toBe(true);
    // short-circuit: RHS would error (unknown ident), but LHS decides
    expect(evaluate("!flag && nosuch > 1", scope)).toBe(false);
    expect(() => evaluate("a && flag", scope)).toThrow(DslError); // number as boolean
  });

  test("type errors carry the offending span", () => {
    try {
      evaluate('1 + "x"', scope);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      expect((e as DslError).from).toBe(4); // the "x" literal
    }
  });

  test("division by zero errors", () => {
    expect(() => evaluate("1 / 0", scope)).toThrow(DslError);
    expect(() => evaluate("1 % 0", scope)).toThrow(DslError);
  });

  test("unknown identifier errors with span", () => {
    try {
      evaluate("a + nosuch", scope);
      expect.unreachable();
    } catch (e) {
      expect((e as DslError).from).toBe(4);
      expect((e as DslError).to).toBe(10);
    }
  });

  test("functions", () => {
    expect(evaluate("IF(a > 1, 10, 20)", scope)).toBe(10);
    expect(evaluate("MIN(3, 1, 2)", scope)).toBe(1);
    expect(evaluate("MAX(3, 1, 2)", scope)).toBe(3);
    expect(evaluate("ROUND(2.345, 2)", scope)).toBe(2.35);
    expect(evaluate("ROUND(2.5)", scope)).toBe(3);
    expect(evaluate("CEIL(1.01)", scope)).toBe(2);
    expect(evaluate("FLOOR(1.99)", scope)).toBe(1);
    expect(evaluate("ABS(0 - a)", scope)).toBe(2);
    expect(evaluate('CONCAT("x-", s, "-", a)', scope)).toBe("x-steel-2");
    expect(evaluate('CONCAT("n=", empty)', scope)).toBe("n=");
  });

  test("LOOKUP hits fixture table", () => {
    expect(evaluate('LOOKUP("prices", "code", "COND-alu", "price")', scope)).toBe(2.5);
  });

  test("LOOKUP errors: unknown table, column, missing row", () => {
    expect(() => evaluate('LOOKUP("nope", "code", "x", "price")', scope)).toThrow(DslError);
    expect(() => evaluate('LOOKUP("prices", "nope", "x", "price")', scope)).toThrow(DslError);
    expect(() => evaluate('LOOKUP("prices", "code", "MISSING", "price")', scope)).toThrow(DslError);
  });

  test("HAS on multi-value params; lists rejected elsewhere", () => {
    const s2 = { vars: { opts: ["a", "b"] as string[] } };
    expect(evaluate('HAS(opts, "a")', s2)).toBe(true);
    expect(evaluate('HAS(opts, "z")', s2)).toBe(false);
    expect(() => evaluate("opts + 1", s2)).toThrow(DslError);
    expect(() => evaluate('CONCAT(opts, "x")', s2)).toThrow(DslError);
  });

  test("unknown function errors", () => {
    expect(() => evaluate("NOPE(1)", scope)).toThrow(DslError);
  });

  test("prototype members are not identifiers", () => {
    expect(() => evaluate("toString", scope)).toThrow(DslError);
  });
});
