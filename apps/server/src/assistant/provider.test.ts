import { describe, expect, test } from "bun:test";
import { listProviders, resolveProvider } from "../src/provider.ts";

describe("Gemini provider profiles", () => {
  test("allows Gemini 3.5 Flash with its documented capability limits", () => {
    const env = {
      GEMINI_API_KEY: "test-key",
      GEMINI_MODEL: "gemini-3.5-flash",
    };

    expect(listProviders(env)).toContainEqual({
      provider: "gemini",
      model: "gemini-3.5-flash",
      available: true,
    });
    expect(resolveProvider("gemini", env).profile).toEqual({
      model: "gemini-3.5-flash",
      contextTokens: 1_048_576,
      maxOutputTokens: 65_536,
    });
  });
});

describe("provider API errors", () => {
  test("extracts the public message from a nested API error response", async () => {
    const providerModule = await import("../src/provider.ts");
    const toProviderApiError = (providerModule as Record<string, unknown>).toProviderApiError as
      | ((error: unknown) => Error & { code: string; retryable: boolean })
      | undefined;
    const error = toProviderApiError?.(new Error(JSON.stringify({
      error: {
        message: JSON.stringify({
          error: {
            code: 503,
            message: "This model is currently experiencing high demand. Please try again later.",
            status: "UNAVAILABLE",
          },
        }),
        code: 503,
        status: "Service Unavailable",
      },
    })));

    expect(error).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: "This model is currently experiencing high demand. Please try again later.",
      retryable: true,
    });
  });

  test("does not expose an unstructured provider exception", async () => {
    const providerModule = await import("../src/provider.ts");
    const toProviderApiError = (providerModule as Record<string, unknown>).toProviderApiError as
      | ((error: unknown) => Error & { code: string; retryable: boolean })
      | undefined;
    const error = toProviderApiError?.(new Error("request failed with api-key=secret"));

    expect(error?.message).toBe("The AI provider could not complete the request. Please try again.");
  });

  test("extracts the public message from status-prefixed Anthropic JSON", async () => {
    const providerModule = await import("../src/provider.ts");
    const toProviderApiError = (providerModule as Record<string, unknown>).toProviderApiError as
      | ((error: unknown) => Error & { code: string; retryable: boolean })
      | undefined;
    const error = toProviderApiError?.(new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CdLuEVWR32mK8tVMtDrZq"}',
    ));

    expect(error?.message).toBe(
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    );
  });
});
