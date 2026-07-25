'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { requestScanForProject } from '@/lib/actions/scan-request'

type Props = {
    projectId: string
    scanning: boolean
    // Compact form for the project-list row actions: icon only, with the label moved to the
    // accessible name and tooltip so the row stays narrow. Mirrors MuteDialog / TagEditor.
    iconOnly?: boolean
}

export function ScanNowButton({ projectId, scanning, iconOnly }: Props) {
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
    if (iconOnly) {
        return (
            <Button variant="outline" size="icon" onClick={handleClick} disabled={busy} title={label} aria-label={label}>
                <RefreshCw className={'h-4 w-4 ' + (busy && 'animate-spin' || '')} />
            </Button>
        )
    }
    return (
        <Button variant="default" onClick={handleClick} disabled={busy}>
            <RefreshCw className={'h-4 w-4 ' + (busy && 'animate-spin' || '')} />
            {label}
        </Button>
    )
}
