import { describe, expect, test } from "bun:test";
import { DslError, parse } from "../src/dsl";

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
