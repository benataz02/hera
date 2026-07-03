import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/models/$id")({ component: Builder });

function Builder() {
  const { id } = Route.useParams();
  return <div style={{ padding: "1rem" }}>Builder for {id} (Task 4)</div>;
}
