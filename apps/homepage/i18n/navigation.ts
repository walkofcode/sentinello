import { createNavigation } from 'next-intl/navigation'
import { routing } from './routing'

// Locale-aware Link / usePathname / useRouter — they keep the active locale prefix on navigation
// and let the language switcher swap only the prefix.
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing)
