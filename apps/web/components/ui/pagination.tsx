'use client'

import { useTranslations } from 'next-intl'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

// itemLabel is a key into the Pagination.items.* ICU plurals (e.g. 'finding', 'library', 'scan').
type Props = {
    page: number
    totalPages: number
    totalItems: number
    pageSize: number
    itemLabel: string
    onChange: (page: number) => void
}

export function Pagination({ page, totalPages, totalItems, pageSize, itemLabel, onChange }: Props) {
    const t = useTranslations('Pagination')
    if (totalItems <= pageSize) return null
    const start = (page - 1) * pageSize + 1
    const end = Math.min(page * pageSize, totalItems)
    const items = t('items.' + itemLabel, { count: totalItems })
    function prev() { onChange(Math.max(1, page - 1)) }
    function next() { onChange(Math.min(totalPages, page + 1)) }
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 text-xs text-muted-foreground">
            <span>{t('showing', { start, end, total: totalItems, items })}</span>
            <div className="flex items-center gap-2">
                <span className="hidden sm:inline">{t('pageOf', { page, total: totalPages })}</span>
                <Button variant="outline" size="sm" onClick={prev} disabled={page <= 1} aria-label={t('prevAria')}>
                    <ChevronLeft className="h-4 w-4" />
                    <span className="hidden sm:inline">{t('prev')}</span>
                </Button>
                <Button variant="outline" size="sm" onClick={next} disabled={page >= totalPages} aria-label={t('nextAria')}>
                    <span className="hidden sm:inline">{t('next')}</span>
                    <ChevronRight className="h-4 w-4" />
                </Button>
            </div>
        </div>
    )
}
