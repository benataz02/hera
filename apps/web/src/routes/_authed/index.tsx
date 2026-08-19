import { createFileRoute } from '@tanstack/react-router'
import { DashboardPage } from '../../components/dashboard/DashboardPage.tsx'

export const Route = createFileRoute('/_authed/')({
  component: DashboardPage,
})
