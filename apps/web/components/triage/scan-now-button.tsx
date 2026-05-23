'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { requestScanForProject } from '@/lib/actions/scan-request'

type Props = {
    projectId: string
    scanning: boolean
}

export function ScanNowButton({ projectId, scanning }: Props) {
    const t = useTranslations('Triage')
    const [pending, startTransition] = useTransition()
    function handleClick() {
        startTransition(async function trigger() {
            await requestScanForProject(projectId)
        })
    }
    const busy = scanning || pending
    let label = t('scan.scanNow')
    if (pending) label = t('scan.queueing')
    else if (scanning) label = t('scan.scanning')
    return (
        <Button variant="default" onClick={handleClick} disabled={busy}>
            <RefreshCw className={'h-4 w-4 ' + (busy && 'animate-spin' || '')} />
            {label}
        </Button>
    )
}
