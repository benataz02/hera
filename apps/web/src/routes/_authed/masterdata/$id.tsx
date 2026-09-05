import { createFileRoute } from "@tanstack/react-router";
import { MasterdataEditor } from "../../../components/masterdata/MasterdataEditor.tsx";

export const Route = createFileRoute("/_authed/masterdata/$id")({ component: Editor });

function Editor() {
  const { id } = Route.useParams();
  return <MasterdataEditor key={id} id={id} />;
}
