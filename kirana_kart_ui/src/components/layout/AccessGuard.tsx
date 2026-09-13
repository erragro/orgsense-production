import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth.store'
import { hasPermission, type AppModule, type Permission } from '@/lib/access'

export function AccessGuard({
  module,
  permission = 'view',
  children,
}: {
  module: AppModule
  permission?: Permission
  children: React.ReactNode
}) {
  const user = useAuthStore((s) => s.user)
  const location = useLocation()

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (!hasPermission(user, module, permission)) {
    return <Navigate to="/dashboard" replace />
  }

  return <>{children}</>
}
