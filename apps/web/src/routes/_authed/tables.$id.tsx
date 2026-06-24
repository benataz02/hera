import { createFileRoute } from "@tanstack/react-router";
import { TableEditor } from "../../components/TableEditor.tsx";

export const Route = createFileRoute("/_authed/tables/$id")({ component: Page });

function Page() {
  const { id } = Route.useParams();
  return <TableEditor id={id} />;
}
