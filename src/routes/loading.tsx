import { createFileRoute } from '@tanstack/react-router'
import { PageLoading } from '@/components/pampalo/PageLoading'

export const Route = createFileRoute('/loading')({ component: Loading })

function Loading() {
  return <PageLoading />
}
