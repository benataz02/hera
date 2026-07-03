import { createFileRoute } from "@tanstack/react-router";
import { ModelsPage } from "../../../components/configurator/ModelsPage.tsx";

export const Route = createFileRoute("/_authed/models/")({ component: ModelsPage });
