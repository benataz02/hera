import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as tools from "../src/tools.ts";

describe("Gemini-compatible tool schemas", () => {
  test("preview overrides do not emit unsupported propertyNames", () => {
    const makeSchema = (
      tools as typeof tools & {
        makePreviewCandidatesInputZ?: (paramKeys: string[]) => z.ZodType;
      }
    ).makePreviewCandidatesInputZ;

    expect(makeSchema).toBeDefined();
    const schema = z.toJSONSchema(makeSchema!(["width", "finish"]));
    expect(JSON.stringify(schema)).not.toContain('"propertyNames"');
  });
});
