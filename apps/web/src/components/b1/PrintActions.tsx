import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Bar, BusyIndicator, Button, Dialog, MessageStrip } from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";

// The one place printing exists in the UI. Everything that can print a SAP document — the object
// page, the list report's count bar, the portal timeline — renders this and nothing else, so
// there is exactly one blob-URL lifecycle to get right.
//
// apps/web does not depend on @hera/server at runtime (only `import type` for the router), so the
// PRINTABLE list is restated here rather than imported — the same reason portalUi.ts inlines
// ProjectStatus. The server's entity-profiles.ts PRINTABLE is the real boundary; this only
// decides whether to draw a button.
export const PRINTABLE_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

/** base64 -> a blob URL the browser's own PDF viewer can open.
 *  // ponytail: iframe + the browser's viewer; a real viewer only if someone needs annotations. */
const toBlobUrl = (pdf: string) =>
  URL.createObjectURL(new Blob([Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], { type: "application/pdf" }));

export function PrintActions({
  entity, docEntry, scope = "internal", disabled,
}: {
  entity: string;
  docEntry: number;
  scope?: "internal" | "portal";
  disabled?: boolean;
}) {
  const [preview, setPreview] = useState<{ url: string; fileName: string } | null>(null);

  // Two mutation option factories, one call site. `scope` is fixed for a given mount, so this is
  // not a conditional hook.
  const options = scope === "portal" ? orpc.portal.docs.print.mutationOptions() : orpc.entities.print.mutationOptions();
  const print = useMutation(options);

  // A blob URL is a document-lifetime allocation; release it when the dialog closes or we unmount.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  if (!PRINTABLE_ENTITIES.has(entity) || !Number.isFinite(docEntry)) return null;

  const run = async (then: (r: { url: string; fileName: string }) => void) => {
    const res = await print.mutateAsync({ entity, docEntry });
    then({ url: toBlobUrl(res.pdf), fileName: res.fileName });
  };

  const close = () => {
    setPreview((p) => { if (p) URL.revokeObjectURL(p.url); return null; });
  };

  return (
    <>
      <Button icon="pdf-attachment" design="Transparent" disabled={disabled || print.isPending}
        onClick={() => void run(setPreview)}>
        Preview
      </Button>
      <Button icon="download" design="Transparent" disabled={disabled || print.isPending}
        onClick={() =>
          void run(({ url, fileName }) => {
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            a.click();
            // The download has already been handed to the browser by the time click() returns.
            URL.revokeObjectURL(url);
          })
        }>
        Download
      </Button>
      {print.error ? <MessageStrip design="Negative" hideCloseButton>{print.error.message}</MessageStrip> : null}
      {print.isPending ? <BusyIndicator active delay={0} /> : null}
      <Dialog
        stretch
        open={!!preview}
        headerText={preview?.fileName ?? ""}
        onClose={close}
        footer={<Bar design="Footer" endContent={<Button onClick={close}>Close</Button>} />}
      >
        {preview ? (
          <iframe src={preview.url} title={preview.fileName}
            style={{ width: "100%", height: "100%", border: 0 }} />
        ) : null}
      </Dialog>
    </>
  );
}
