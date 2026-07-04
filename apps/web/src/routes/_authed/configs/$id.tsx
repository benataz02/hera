import { createFileRoute } from "@tanstack/react-router";
import { ConfigProcessPage } from "../../../components/configurator/ConfigProcessPage.tsx";

export const Route = createFileRoute("/_authed/configs/$id")({ component: Process });

function Process() {
  const { id } = Route.useParams();
  return <ConfigProcessPage key={id} id={id} />;
}
