# HERA — product description

A plain-language description of what HERA does, for use as prompting context and for
commercial planning. No code, no architecture. For the technical picture see `CLAUDE.md`;
for the original vision see `INITIAL-SPEC.md`.

---

## In one paragraph

HERA is a B2B quoting platform for small and mid-sized manufacturers that run **SAP Business One**.
It lets a company turn its "how we price a made-to-order product" knowledge into a guided
configurator: a salesperson answers a handful of questions, and HERA works out the valid
product variants, the bill of materials, the production operations, the cost and the sale price.
The same configurator can be opened to the manufacturer's own customers as a self-service
quote-request portal. Live SAP lookups, document history, dashboard figures and quote write-back
run through a small agent the customer installs next to their Service Layer, so SAP credentials
never leave their network.

## Who it is for

- **Made-to-order / configure-to-order SME manufacturers** (metal, plastics, packaging, industrial
  components) already on SAP Business One, typically 10–50 internal users.
- **The people who quote**: sales engineers and inside sales who today rebuild the same
  spreadsheet for every enquiry.
- **The person who owns the pricing logic**: a technical/commercial admin who knows the rules but
  is not a developer.
- **The manufacturer's own B2B customers**, who currently order by email and PDF.

## The problem it addresses

Quoting a configurable product in an SME is slow, inconsistent, and locked in one person's head or
one person's spreadsheet. Prices drift from real material costs, the BOM has to be re-keyed into
the ERP, and no one can tell whether a similar part was quoted last year and at what price. HERA
puts the rules in one place and makes the quote reproducible, and feeds it from live SAP master
data.

---

## What the product does today

### 1. Product model builder (admin)
A no-code workspace where an admin defines a configurable product once:

- **Questions** the salesperson will answer — dropdowns, numeric inputs, checkboxes, sliders,
  multi-select — grouped into sections and pages, with units, help text and defaults.
- **Rules and constraints** — formulas, conditional visibility, "if A then B is not allowed"
  combination tables. Invalid configurations become impossible rather than merely discouraged.
- **Bill of materials** — which materials the configuration consumes, in what quantity, at what
  cost, including scrap.
- **Routing** — which operations run on which resource, setup time, run time per unit, hourly rate.
- **Price** — the final selling-price formula on top of computed cost.
- **Lookup data** — option lists and price tables maintained inside HERA, plus query tables that
  read live from SAP B1 / Beas: an entity set with an optional filter, with Test fetch taking the
  column list straight from the response.
- **Live test drive** — the right-hand pane is the real configurator running the unsaved draft on
  every keystroke, with a running "consistent / N questions open / ~M valid variants left" status.
  A model with errors cannot be saved, so a broken model can never reach a salesperson.

### 2. Guided configuration and quoting (internal users)
A step-by-step wizard for the sales side:

- **Configure** — answer the model's questions; the engine narrows the remaining choices in real
  time and blocks contradictory combinations as they are made.
- **Quantities** — enter one or several batch sizes to compare.
- **Candidates** — when some questions are deliberately left open, HERA enumerates every valid
  remaining variant and shows them as a price matrix: variant × quantity, with the cheapest cell
  highlighted. This is the "give me the three ways to build this and what each costs" view.
- **Review** — full breakdown per selected line: materials, operations, cost build-up and price,
  with manual overrides where the salesperson needs the last word. All figures are recalculated
  server-side, so the stored numbers are always the engine's, not the browser's.
- Every calculation run is frozen as an immutable snapshot — the model, the data it used and the
  results — so an old quote can always be explained.

### 3. Historic help while configuring
A side pane that answers "have we done something like this before?" in two ways:

- **Customer & item history** — live SAP orders and quotations for this customer and/or this item
  code, listed line by line with the closest matches first.
- **Similar configurations** — a ranked list of past production/sales records already cached in
  HERA, scored on the parameters the admin decided matter (exact match, numeric closeness, text
  contains, each with a weight). One click copies a past configuration's values into the current
  one. **Sync now** re-pulls the model's history query from SAP.

### 4. Drawing extraction (AI assist)
The salesperson uploads a customer's technical drawing (PDF or image) and an AI model reads it
against the product model, returning **per-question suggestions** — never auto-applied values.
Every suggestion is validated server-side against the question's type, allowed values and range;
anything that does not fit is shown flagged with a reason and cannot be accepted. Suggest-and-confirm
by design: nothing enters a quote without an explicit click. Drawings are processed and discarded,
not stored.

### 5. B2B client portal
The manufacturer's own customers get logins bound to their SAP customer account:

- Admin invites a client by email and links them to a specific SAP business partner.
- Clients see a catalog of the product models the manufacturer has **published** to the portal.
- They run the same configurator (including drawing upload) and see **prices only** — material
  costs, labour, margin and the internal breakdown never leave the server.
- They submit a **quote request**, which lands in the internal team's queue for review; the
  internal user reviews it and either turns it into a quotation or rejects it with a note, which
  reopens it for the client to fix.
- Clients track status on a timeline (submitted → quoted / rejected) and can withdraw a request.
- Clients are structurally locked out of every internal function — the restriction is enforced on
  the server, not just hidden in the interface.

### 6. Multi-company setup, roles and access
- Each customer company gets its own workspace on its own address (`company.hera-domain`), with its
  own data and users.
- Sign-in by email/password, Google or Microsoft. Users can belong to more than one workspace.
- Three levels of access: **owner/admin** (builds models, manages settings, invites), **member**
  (configures and quotes), and **client** (portal only).
- A user's workspace is decided by the address they are on and their membership in it — a user can
  never reach a workspace they do not belong to.

### 7. Live SAP connection
The customer installs a small Windows service (the "agent") on a machine that can reach their SAP
Business One Service Layer. HERA talks to that agent over HTTPS; the SAP username and password stay
on that machine. Each workspace points at one agent, which serves one company database. In a
customer install the agent dials out through a tunnel, so no inbound firewall hole is needed.
Everything that reads or writes SAP — value help, document history, history sync, the dashboard
refresh and quotation write-back — goes through it, one named operation at a time.

Internal users also get a **SAP data** browser: every entity set the company's B1 exposes, grouped
by business area, with its real field labels, dropdown values and links between records read
straight from SAP's own definitions. Most of it is read-only. A short curated list — quotations,
orders, deliveries, invoices, purchase orders, business partners, items — can also be edited, and
only on the fields HERA names for each; a record changed by someone else in the meantime is
reported as a conflict rather than silently overwritten. From a sales order the user can create the
delivery note or invoice that follows it, linked in SAP the way the ERP expects.

---

## Not built yet (near-term)

- **Email notifications** — invitations are copy-link, and the "you have a new quote request"
  signal is in-app only.
- **Sales-order and production-order creation** (item master, BOM and routing pushed into SAP/Beas
  on order confirmation).

## On the roadmap (from the original vision)

- **Automated deep analysis of historical production and sales data** to discover, per product
  family, which parameters actually drive cost and price — and feed that back into the similarity
  ranking.
- **A conversational AI configurator**: hand it an email, a photo, a drawing or a spec sheet, and it
  fills the configuration itself, asking the user only where it is genuinely unsure.
- **MES / Beas manufacturing** integration for BOMs and routings beyond SAP B1.
- **Workflow automation** (n8n) across the sales-to-production process.
- Broader integration beyond SAP B1 as the second data source.

---

## Commercial shape

- **Deployment**: cloud (multi-tenant SaaS), one workspace per customer company.
- **Prerequisite**: SAP Business One with the Service Layer enabled, plus a Windows machine on the
  customer network to run the HERA agent. Beas is optional.
- **Typical account size**: fewer than 50 internal users, plus an unlimited-ish number of portal
  clients; historical datasets in the tens of thousands of work orders, not millions.
- **Onboarding effort**: the real work is building the first product model with the customer's
  pricing rules — that is the consulting-shaped part of the engagement and the main switching cost
  once done.
- **Value story**: quotes go from hours to minutes, pricing stops depending on one person, the BOM
  and routing are no longer re-keyed, and the manufacturer can hand a self-service quoting portal to
  its own customers — something ERP-native tooling at this segment does not offer.
- **Differentiators**: no-code configurator with a live test drive; historic evidence in front of
  the salesperson at the moment of pricing; AI as a validated suggestion layer rather than an
  unaudited black box.
