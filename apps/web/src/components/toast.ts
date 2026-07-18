import { Modals } from "@ui5/webcomponents-react";

// Fire-and-forget success/info toast built on Modals.showToast — no host component or context
// needed, but <Modals /> must be rendered once in the tree (see main.tsx). Use for transient
// confirmations (saved, deleted); use MessageStrip for errors that must stay on screen.
export function toast(message: string, duration = 3000) {
  Modals.showToast({ children: message, duration });
}
