import { Modals, MessageBoxAction } from "@ui5/webcomponents-react";

// Promise-returning confirm built on Modals.showMessageBox — no host component or context needed,
// but <Modals /> must be rendered once in the tree (see main.tsx). Resolves true when the user
// picks the confirm action, false on Cancel/Escape.
export function confirm({
  title,
  message,
  actionText = "OK",
  destructive = false,
}: {
  title?: string;
  message: string;
  /** label of the confirming button, e.g. "Delete" */
  actionText?: string;
  /** show the warning highlight (destructive/irreversible actions) */
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Modals.showMessageBox({
      type: destructive ? "Warning" : "Confirm",
      titleText: title,
      children: message,
      actions: [actionText, MessageBoxAction.Cancel],
      emphasizedAction: actionText,
      onClose: (action) => resolve(action === actionText),
    });
  });
}
