import { createFileRoute } from "@tanstack/react-router";
import { MasterdataEditor } from "../../components/MasterdataEditor.tsx";

export const Route = createFileRoute("/_authed/masterdata/$id")({ component: Page });

function Page() {
  const { id } = Route.useParams();
  return <MasterdataEditor id={id} />;
}
