// apps/web doesn't depend on @hera/db (bun isolated installs need direct deps — see project memory),
// so the status union is inlined here rather than imported as `ProjectStatus`.
export type PortalStatus = "draft" | "calculated" | "quoted" | "requested" | "rejected";

// Client wording: `calculated` is an internal engine state — clients see Draft.
export const portalStatusUi: Record<PortalStatus, { state: "Information" | "Critical" | "Positive" | "Negative"; text: string }> = {
  draft: { state: "Information", text: "Draft" },
  calculated: { state: "Information", text: "Draft" },
  requested: { state: "Critical", text: "Submitted" },
  quoted: { state: "Positive", text: "Quoted" },
  rejected: { state: "Negative", text: "Needs changes" },
};
