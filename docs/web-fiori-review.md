# `apps/web` — SAP Fiori design-system review

Reviewed against the SAP Fiori design guidelines (`.claude/skills/sap-fiori-guidelines`) and
UI5 Web Components v2 (`@ui5/webcomponents-react` 2.24) usage patterns. Every finding cites
`file:line` at the time of review.

## Verdict

The **floorplan-level work is genuinely good** — list report, object page, wizard and the
messaging split (toast / MessageStrip / MessageBox) are all built the way SAP builds them, and
the reasoning is written down in the code. Findings cluster in three places:

1. **The shell** (`AppShell.tsx`) — hardcoded identity and four affordances that do nothing.
2. **The AI assistant** (`AssistantWindow.tsx`) — Joule's visual identity is reproduced, and
   there is no AI disclaimer anywhere in a pricing product.
3. **Small-scale semantics** — heading levels, label association, sentence case, theme tokens.

Nothing here is architectural. The list is long because it is exhaustive, not because the app
is far off.

---

## High

### 1. The avatar shows the same two letters to every user
`components/AppShell.tsx:161`

```tsx
profile={<Avatar id="user-menu-opener" initials='BA' />}
```

The correct initials are already computed eight lines below for `UserMenuAccount`
(`AppShell.tsx:172`). This is a correctness bug as much as a design one — every signed-in user
sees another person's initials in the shell bar.

### 2. Four shell affordances that do nothing
`components/AppShell.tsx:162,164,178-181`

- `showNotifications` with no `notificationsCount` and no `onNotificationsClick` — a bell that
  never rings and never opens anything.
- `assistant={<ToggleButton icon="da" tooltip="Joule" />}` — inert, and it duplicates Chati,
  which is reached from the object page instead.
- `showEditAccounts` / `showEditButton` / `showManageAccount` / `showOtherAccounts` — all four
  enabled with no handlers and no other accounts to switch to.

Fiori's rule is that an affordance implies a capability. Remove them, or wire them.

### 3. Chati reproduces Joule's visual identity
`components/configurator/AssistantWindow.tsx:40-41,412,474-478`

```ts
const JOULE_TOP = "#6b21d8";
const JOULE_HERO = `linear-gradient(150deg, ${JOULE_TOP} 0%, #8d1fd2 55%, #b826c6 100%)`;
```

…plus the `da-2` Joule mark and the "How can I help you?" hero. Chati is not Joule; presenting a
third-party assistant in Joule's colours, icon and welcome copy is not a use of the design system,
it is an impersonation of one of its products.

It is also a theming bug independent of the branding question: `#fff`, `"white"` and
`rgba(255,255,255,0.85)` are hardcoded against a hardcoded purple, so the panel ignores the theme
the user picked in the very same shell — including both high-contrast themes.

Use `@ui5/webcomponents-ai`'s own components and the AI theme parameters, or a HERA/Confire
accent derived from theme params.

### 4. No AI acknowledgment and no AI disclaimer, anywhere
`components/configurator/AssistantWindow.tsx`, `components/configurator/ExtractPanel.tsx`

A search for `disclaim|may be inaccurate|AI-generated|verify` across `apps/web/src` returns
nothing. Chati writes parameter values that feed pricing, and drawing extraction proposes values
off a PDF. By SAP's own classification (`references/ui-ai.md` → *High-stakes situations*:
financial forecasting, contract recommendations) this is high-stakes and the AI acknowledgment
pattern is **highly recommended**, not optional.

Two things are missing:

- **AI acknowledgment** — a MessageBox-type dialog on first use of an AI-enabled screen, with
  the standard wording and a *Don't show me again* checkbox (`ui-ai.md:73-101`).
- **A persistent disclaimer** in the Chati window and on the extraction panel.

The underlying behaviour is already right — extraction re-validates server-side, nothing
auto-applies, and every AI-set value carries a revertable "AI" chip. The transparency layer on
top of it is what is absent.

### 5. High contrast is only offered in the deprecated theme family
`components/AppShell.tsx:60-67`

```ts
{ id: 'sap_fiori_3_hcb', labelKey: 'High Contrast Black' },
{ id: 'sap_fiori_3_hcw', labelKey: 'High Contrast White' },
```

A user on Morning/Evening Horizon who needs high contrast is thrown into the Quartz family.
`sap_horizon_hcb` and `sap_horizon_hcw` exist and are what Horizon users should get. Either add
them, or drop the Fiori 3 entries and offer Horizon + its two HC variants only.

### 6. Global search disappears below 900px
`components/GlobalSearch.tsx:13-27`

The component injects a `<style>` into `document.head` at module scope that takes the search
field out of the ShellBar's flow (`position:fixed; left:50%`), pins it to a **private** theme
variable (`--_ui5_shellbar_root_height`), overrides `ui5-search`'s background, and then:

```css
@media (max-width:900px){.hera-shell-search{display:none}}
```

The app's only search is gone on every tablet and phone. Adaptive is one of the five Fiori
principles, and the ShellBar already solves this — its search slot collapses to a magnifier
rather than vanishing. The `// ponytail:` comment acknowledges the trade-off; this is the note
that it has a real cost.

### 7. The value-help (F4) trigger is not reachable by keyboard
`components/ValueHelp.tsx:264`

```tsx
icon={<Icon name="value-help" style={{ cursor: "pointer" }} onClick={...} />}
```

A bare `Icon` with a click handler: no tab stop, no `role`, no accessible name, no Enter/Space.
For a keyboard-only user the dialog is unreachable on **every** query-backed parameter in the
configurator. `Icon` takes `mode="Interactive"` (focusable, keyboard-operable) plus
`accessibleName` — that is the fix, and it is one line.

Same shape, lower severity, on the decorative search icons at `ValueHelp.tsx:114` and
`b1/EntityCatalogPage.tsx:55` — those want `mode="Decorative"` so they are hidden from assistive
tech (`foundations-visual.md:198-206`).

---

## Medium

### 8. Heading hierarchy is unsystematic
Across `apps/web/src`: 1×H1, 2×H3, 6×H4, 17×H5, 5×H6, and 2 `<Title>` with no level at all.

| Where | Level | File |
|---|---|---|
| Object page — configuration name | H5 | `ConfigProcessPage.tsx:272` |
| Object page — model name | H4 | `ModelBuilderPage.tsx:86` |
| Object page — B1 row | *(none)* | `b1/EntityObjectPage.tsx:109` |
| List report page title | H4 | `ListReport.tsx:235` |
| Table title inside that page | H5 | `ListReport.tsx:298` |
| Chati floating window | H1 | `AssistantWindow.tsx:478` |

An object-page title is the page's top heading and should not be H5; an H1 inside a floating
overlay outranks the page behind it. `foundations-best-practices.md` ("Title Hierarchy Guidance")
asks for sequential levels that match the content structure. Pick one scale — object title H2,
section H3, table/group H4 — and apply it.

### 9. Model builder Save is in the title bar, not the footer
`components/configurator/ModelBuilderPage.tsx:88-94`

The model builder is an always-editable object page, so Save belongs in `footerArea` with
`Bar design="FloatingFooter"` — which this codebase already does correctly in
`EntityObjectPage.tsx:137` and `ConfigProcessPage.tsx:214`. There is also no Cancel/Discard
beside it; discard is only reachable by trying to navigate away (`useBlocker`, `:37-51`).

### 10. No Message Popover for model validation
`components/configurator/ModelBuilderPage.tsx:56,68`

`check.ts` produces structured `Issue`s with paths, and the page surfaces them as a count
appended to each section title — `Rules (2)`. Fiori's aggregate-message pattern is a message
button in the footer opening a **MessagePopover**, where each entry navigates to the offending
field. `ExprInput.tsx:41` already carries a `/** DOM id (MessageView jump target) */` comment, so
the jump targets exist; the popover was never built.

### 11. Labels not associated with their controls
37 of 44 `<Label>` have no `for`. Most sit inside `FormItem labelContent`, where the Form wires
the relation — those are fine. These do not:

- `configurator/RulesTab.tsx:154,163` — plain `<div>`s inside a Dialog
- `routes/_authed/settings.tsx:107,109` — plain `FlexBox` inside a Dialog

Both dialogs should use `Form`/`FormGroup`/`FormItem` like the rest of the app
(`SettingsTab.tsx:26-69` is the model to copy).

Related: `routes/login.tsx:70-83` wraps a UI5 `Input` in a native `<label>`. Shadow DOM means
that association never happens — the inputs need `accessibleName`.

### 12. Table count bar reads `(0/247)`
`components/ListReport.tsx:298`

```tsx
startContent={<Title level="H5">{title} ({selected.rows.length}/{total})</Title>}
```

Fiori's table title is `Configurations (247)` — the item count, full stop. Selection is stated
separately and only when non-zero. As written, a user with nothing selected reads `0/247` and has
to work out which number is which.

### 13. Empty states are inconsistent
The list reports and route boundaries use `IllustratedMessage` properly. These do not:

- `ConfigProcessPage.tsx:341` — `<Text>No candidates yet.</Text>`
- `ConfigProcessPage.tsx:348` — `<Text>Save a candidate selection to continue.</Text>`
- `DashboardPage.tsx:147` — `<ListItemStandard>Nothing waiting on you</ListItemStandard>`
  (a fake row that looks clickable)

The first two are whole-tab empty states and are exactly what `IllustratedMessage` is for.

### 14. A KPI that is always green
`components/dashboard/DashboardPage.tsx:85`

```tsx
trend={trendOf(d.orderValue.total, d.orderValue.prevTotal)} state="Good"
```

`state` is hardcoded regardless of the trend it sits next to. A semantic colour that never
changes carries no information and trains users to ignore it. The margin card two cards over
(`:106`) derives its state properly — do the same here.

### 15. Cancel button design varies by dialog
`Transparent` in `ListReport.tsx:432`; bare default in `ConfigProcessPage.tsx:362`,
`EntityObjectPage.tsx:147`, `settings.tsx:88`, `PortalRequestPage.tsx:197`,
`ValueHelp.tsx:107-108`. Pick one (Transparent is the Fiori convention for the dialog's tertiary
action) and apply it everywhere.

### 16. Dashboard and Settings have no page floorplan
`dashboard/DashboardPage.tsx:47` is a bare `FlexBox`; `routes/_authed/settings.tsx:37` is a bare
`div`. Neither has a page title, so the browser and the shell give the user no idea what page
they are on. Every other page in the app uses `DynamicPage` or `ObjectPage`; the dashboard is an
overview-page floorplan and should get a `DynamicPageTitle` at minimum.

### 17. Portal wizard uses a `Bar` as a page header
`components/portal/PortalRequestPage.tsx:108`

`Bar design="Header"` predates the dynamic page header. The wizard floorplan wants a
`DynamicPage`/`Page` title area — which also gives it the status and the back path for free.

### 18. Row actions dispatched on the button's visible label
`components/configurator/StepCandidatesReview.tsx:71-77`

```ts
const action = (e.detail.action as HTMLElement).getAttribute("text");
...
else if (action === "Reset") ...
else if (action === "Restore") ...
```

Application logic keyed to display strings. Any rewording or translation silently changes
behaviour — a reworded "Restore" would fall through to the `else` branch and *remove* the line.
Key off `data-*` or an `id` instead.

### 19. A table column with no header
`components/configurator/StepCandidatesReview.tsx:97,145`

```tsx
<TableHeaderCell><span></span></TableHeaderCell>
```

The status column has no accessible name. Give it a real header, or an `accessibleName` with a
visually hidden label.

---

## Low / polish

20. **Sentence case in status text.** `"added"` / `"removed"` / `"edited"`
    (`StepCandidatesReview.tsx:60-64`), `"auto"` (`ConfiguratorForm.tsx:255`), `"unavailable"`
    (`ConfiguratorForm.tsx:179`). `foundations-writing-and-wording.md` asks for sentence case.
21. **A literal `✓` inside `ObjectStatus`.** `ConfiguratorForm.tsx:36` — `ObjectStatus` already
    renders the semantic icon for its state; use `showDefaultIcon` rather than a glyph in the
    string.
22. **`ObjectStatus` with no `state` used as a price label.** `ConfiguratorForm.tsx:246` — that
    is `Text`/`Label` work; `ObjectStatus` means "this value has a semantic state".
23. **Hardcoded font sizes and opacity for muted text.** `0.7rem`–`0.875rem` and `opacity: 0.6`
    in `ConfiguratorForm.tsx:258`, `ExtractPanel.tsx:101`, `EntityCatalogPage.tsx:89`,
    `AssistantWindow.tsx:564,625,697,701`. Use `var(--sapFontSmallSize)` and
    `var(--sapContent_LabelColor)` — the file at `ConfiguratorForm.tsx:258` already gets the
    colour right and the size wrong in the same style object.
24. **A `✕` glyph standing in for a delete affordance.** `AssistantWindow.tsx:458` —
    `Tag interactive` with `{file.name} ✕`. `Token` has a real, labelled delete.
25. **Icon-only buttons without a tooltip.** `DashboardPage.tsx:67` (refresh),
    `HistoryPane.tsx:54` (refresh), `AssistantWindow.tsx:627` (delete conversation). Everything
    else in the app gets this right.
26. **`ui5-content-density-cozy` is not a UI5 class.** `AppShell.tsx:109-113` — cozy is the
    *absence* of `ui5-content-density-compact`. Harmless, but it reads as if it does something.
27. **Theme applies only inside `AppShell`.** `AppShell.tsx:117-120` — login, signup, select and
    accept never run the effect, so they always render in the default theme; and an authed page
    flashes the default theme before the effect lands. Read and apply the stored theme in
    `main.tsx` before render.
28. **Two product names.** `index.html:6` and `AuthLayout.tsx:14` say HERA; `AppShell.tsx:154-157`
    says Confire (including `alt="Confire"`).
29. **Auth pages ignore the theme entirely.** `AuthLayout.css` is a deliberate, documented
    departure for the brand panel — fine. But the *form* panel hardcodes `#fbfcfe`, `#0c1326`,
    `#0a6ed1`, so it stays light for a user who chose Evening Horizon or a high-contrast theme.
    At minimum, drive the form side from theme parameters and keep the custom treatment to the
    brand panel. (`prefers-reduced-motion` is handled correctly at `AuthLayout.css:240` — good.)
30. **Numeric alignment is partial.** `StepCandidatesReview.tsx:92-98` — "Line total" is
    `horizontalAlign="End"`, "Qty / unit" and "Unit price" are not.
31. **An eslint-disable in a repo with no lint step.** `AppShell.tsx:97`, contradicting
    `CLAUDE.md` ("There is no lint step").

---

## What is already right

Worth naming so it does not get refactored away:

- **`ListReport.tsx` is a textbook list report** — `DynamicPage` + `VariantManagement` +
  `FilterBar` (Go / Clear / Adapt Filters / Restore) over an `AnalyticalTable`, with
  `manualSortBy`/`manualFilters` so the local and OData executors cannot diverge. The
  `snappedHeading` duplication (`:321-322`) and the `additionalEmptyRowsCount` reasoning
  (`:369-377`) are exactly the kind of thing that should stay commented.
- **Object pages are correct** — `mode="IconTabBar"`, `hidePinButton`, footer actions in a
  `FloatingFooter`, and `Form accessibleMode` switching Display↔Edit
  (`b1/EntityObjectPage.tsx:164`) so the markup and ARIA change with the mode rather than the
  styling alone.
- **The messaging split follows Fiori exactly.** Transient success → `Modals.showToast`
  (`toast.ts`); destructive confirmation → `showMessageBox` with `type: "Warning"` and an
  emphasized destructive action (`confirm.ts`); errors that must persist → `MessageStrip`. Every
  delete in the app goes through `confirm()` — nine call sites, no exceptions.
- **Route boundaries use `IllustratedMessage`** with the required side-effect illustration
  imports (`Boundaries.tsx:3-5`).
- **`valueState` + `valueStateMessage`** on 15+ fields across the builder and masterdata editor.
- **Responsive `Form` layouts** — `labelSpan`/`layout` breakpoints in `SettingsTab.tsx:26`,
  `MasterdataEditor.tsx:313`, `EntityObjectPage.tsx:163`.
- **`DynamicSideContent`** for the insights rail (`ConfigProcessPage.tsx:257`) — the right
  component, with the reason it sits outside the `ObjectPage` written down.

---

## Suggested order

1. #1 and #2 — the shell. Small, visible, and #1 is a live bug.
2. #4 and #3 — the AI transparency layer, then the Joule branding. Highest exposure.
3. #7 and #11 — keyboard and label association. Both are one-line fixes with real users behind
   them.
4. #5 and #6 — theming and adaptive gaps.
5. #8 — settle the heading scale once, then apply it in one pass.
6. Everything else as it is touched.
