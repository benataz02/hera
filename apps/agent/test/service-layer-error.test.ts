import { expect, test } from "bun:test";
import { parseSlError } from "../src/service-layer-client.ts";

// The regression: v2's string-shaped message resolved to undefined and the whole B1 error
// collapsed to statusText ("Bad Request"), leaving nothing to debug with.
test("b1s/v2 (OData 4) string message", () => {
  const r = parseSlError(400, "Bad Request", JSON.stringify({ error: { code: "-1", message: "Invalid field: Foo" } }));
  expect(r.code).toBe("-1");
  expect(r.message).toBe("B1 400 code -1: Invalid field: Foo");
});

test("non-JSON body is kept raw instead of becoming statusText", () => {
  expect(parseSlError(502, "Bad Gateway", "<html>nginx</html>").message).toBe("B1 502: <html>nginx</html>");
});

test("empty body falls back to statusText", () => {
  expect(parseSlError(400, "Bad Request", "").message).toBe("B1 400: Bad Request");
});
