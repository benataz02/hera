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

// Beas (and b1s/v1) wrap message as {lang,value}, echo the HTTP status as the code, and pad the
// text with a leading space — the raw body used to reach the browser's MessageStrip verbatim.
test("beas {lang,value} message, status echoed as code", () => {
  const raw = JSON.stringify({
    value: [],
    error: { code: "404", message: { lang: "en-us", value: " Entity Collection 'Operations' not found" } },
  });
  const r = parseSlError(404, "Not Found", raw, "Beas");
  expect(r.code).toBe("404");
  expect(r.message).toBe("Beas 404: Entity Collection 'Operations' not found");
});
