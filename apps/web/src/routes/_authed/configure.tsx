import { createFileRoute } from "@tanstack/react-router";
import { Configurator } from "../../components/Configurator.tsx";

export const Route = createFileRoute("/_authed/configure")({ component: Configurator });
