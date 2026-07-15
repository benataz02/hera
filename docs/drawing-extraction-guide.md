# Drawing Extraction — Setup & User Guide

Drawing extraction lets a salesperson upload a customer's 2D technical drawing (PDF or image)
during configuration, have Gemini read it against the tenant's model, and get back per-parameter
**suggestions** — never values applied automatically. Nothing enters the configuration without an
explicit click.

> **Suggest-and-confirm, always.** The server validates every suggestion against the parameter's
> type, allowed values and range. Anything that doesn't fit is shown flagged, with a reason, and
> has no Accept button — it can never silently land in a quote.

---

## 1. Server setup (one-time, per deployment)

Drawing extraction needs a Gemini API key at the **platform level** — one key for the whole
server, not per tenant.

Add to the root `.env` (next to the other `apps/server` variables):

```
GEMINI_API_KEY=<your Gemini API key>
# Optional — defaults to gemini-3-flash
GEMINI_MODEL=gemini-3-flash
```

Restart `apps/server` after changing this. If `GEMINI_API_KEY` is unset, the upload button still
works but every extraction attempt fails with *"Drawing extraction is not configured on this
server"* — the wizard stays usable, values are just entered manually.

No other setup is required: no per-tenant keys, no new database tables, no migration. The
uploaded file is sent to Gemini and discarded — it is never written to disk or the database.

---

## 2. Model builder — help Gemini read your drawings

Two optional fields (**Configurator models** → open a model) make extraction accurate for a
specific product line. Neither is required — extraction works with defaults, but hints
meaningfully improve accuracy on real drawings.

### Extraction context (Settings tab)

A free-text note about drawing conventions for this whole model — units, title-block layout,
notation quirks. Shown to Gemini once per extraction, ahead of every parameter.

> *"Dimensions are in millimetres unless noted. Material is in the title block, field MATERIAL."*

### Extraction hint (per parameter)

In a parameter's edit dialog, **Extraction hint** describes where/how *that* value appears on a
drawing:

> *"Cross-section: read from the wire gauge table, column 'mm²'."*

Both fields feed directly into the prompt sent to Gemini — there's nothing to save or publish
separately; they're part of the model definition like any other field.

---

## 3. Using it — the Configure step

1. Open a configuration and go to the **Configure** step. Above the form, there's an
   **"Extract from drawing"** panel with an **Upload drawing** button.
2. Pick a **PDF, PNG or JPEG**, up to **15 MB**. Anything else is rejected immediately, before any
   request is sent — *"Only PDF, PNG or JPEG drawings are supported"* / *"The file exceeds the
   15MB limit."*
3. While Gemini reads the drawing, a busy indicator shows *"Reading drawing…"*. This can take a
   few seconds for a dense drawing.
4. Results appear as a list, one row per parameter Gemini found a value for:
   - **Label: value** and the **evidence** — the exact text/callout Gemini read and where.
   - A valid suggestion has an **Accept** button (applies just that one value) and a **Dismiss**.
   - An **invalid** suggestion (out of range, not an allowed option, wrong type) shows a red
     reason instead of Accept — e.g. *"Not among the allowed values for this parameter"* — and
     can only be dismissed.
5. **Accept all valid (N)** appears once there's more than one valid, unhandled suggestion —
   applies all of them in a single click.
6. Accepting a suggestion sets it exactly like typing it into the form: existing live propagation,
   conflict detection and dependent-domain narrowing all react immediately, same as manual entry.
7. If nothing on the drawing matched any parameter, you'll see *"Nothing could be extracted from
   this drawing."* If the request fails (server unreachable, Gemini error, unreadable response),
   the message is shown with a **Retry** button.

---

## 4. Known limitations

- **Multi-select parameters** (`ui: multicombo`) can only ever get a single suggested value per
  extraction — a drawing showing several applicable options for one multi-select field will only
  suggest one of them. Suggest-and-confirm still applies, so nothing wrong gets in automatically;
  just review multi-select suggestions before accepting.
- **No history.** The drawing and Gemini's raw response are not stored anywhere — re-uploading is
  the only way to see suggestions again for the same drawing.
- **No confidence scores.** A suggestion is either accepted or not; there's no "how sure" signal
  beyond the evidence text and the valid/invalid flag.
- Extraction uses the **same lookup resolution** as the rest of the Configure step (SAP-backed
  domains go through the on-prem agent) — if the model needs the agent and it's offline, upload
  fails the same way the form's own lookups would.

---

## Quick reference

| I want to… | Where |
|------------|-------|
| Turn extraction on for the server | Root `.env` → `GEMINI_API_KEY` (+ optional `GEMINI_MODEL`) |
| Tell Gemini about drawing conventions for a model | Model builder → **Settings** → Extraction context |
| Tell Gemini where one value appears on drawings | Model builder → parameter dialog → Extraction hint |
| Upload a drawing during configuration | **Configure** step → **Upload drawing** |
| Apply everything Gemini got right | **Accept all valid (N)** |
| See why a suggestion was rejected | The red reason next to that row |

| Message | Meaning | Fix |
|---------|---------|-----|
| "Drawing extraction is not configured on this server" | `GEMINI_API_KEY` unset | Set it in `.env`, restart the server |
| "Only PDF, PNG or JPEG drawings are supported" | Wrong file type | Re-export/scan as PDF, PNG or JPEG |
| "The file exceeds the 15MB limit" | File too large | Compress/re-export the drawing |
| "Drawing extraction failed: …" | Gemini call errored | Retry, or enter values manually |
| "The extraction service returned an unreadable result" | Gemini's response wasn't valid JSON | Retry, or enter values manually |
| "Nothing could be extracted from this drawing" | Gemini found no matching values | Check the drawing matches the model, or enter manually |
