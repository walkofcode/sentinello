'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { requestFullSweep } from '@/lib/actions/scan-request'

type Props = {
    scanning: boolean
}

export function ScanAllButton({ scanning }: Props) {
    const t = useTranslations('Home')
    const [pending, startTransition] = useTransition()
    function handleClick() {
        startTransition(async function trigger() {
            await requestFullSweep()
        })
    }
    const busy = scanning || pending
    let label = t('scanNow')
    if (pending) label = t('scanQueueing')
    else if (scanning) label = t('scanScanning')
    return (
        <Button variant="outline" size="sm" onClick={handleClick} disabled={busy}>
            <RefreshCw className={'h-3.5 w-3.5 ' + (busy && 'animate-spin' || '')} />
            {label}
        </Button>
    )
}
