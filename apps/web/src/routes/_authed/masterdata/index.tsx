import { createFileRoute } from "@tanstack/react-router";
import { MasterdataPage } from "../../../components/masterdata/MasterdataPage.tsx";

export const Route = createFileRoute("/_authed/masterdata/")({ component: MasterdataPage });
