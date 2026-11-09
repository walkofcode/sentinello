'use client'

import { useLocale } from 'next-intl'
import { noticeKindLabel, type Locale } from '@sentinello/core'
import { Badge } from '@/components/ui/badge'

// Where a vulnerability shows its severity, a notice shows what kind of notice it is: it claims no grade to
// act on, and is counted nowhere.
export function NoticeKindBadge({ kind }: { kind: string }) {
    const locale = useLocale() as Locale
    return <Badge variant="muted" data-testid="notice-kind">{noticeKindLabel(kind, locale)}</Badge>
}
