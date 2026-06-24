import { createFileRoute } from "@tanstack/react-router";
import { ModelBuilder } from "../../components/ModelBuilder.tsx";

export const Route = createFileRoute("/_authed/models/$id")({ component: Page });

function Page() {
  const { id } = Route.useParams();
  return <ModelBuilder id={id} />;
}
