'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Check, ChevronDown, Copy, Download, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import {
    exportLibraryAdvisoryMarkdownAction,
    exportProjectAdvisoryMarkdownAction
} from '@/lib/actions/export'

type DepType = 'all' | 'prod' | 'dev'

type Props =
    | { scope: 'project'; projectId: string; depType: DepType }
    | { scope: 'library'; packageName: string; ecosystem: string; depType: DepType }

function triggerDownload(filename: string, markdown: string) {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    // Revoke on the next tick — some browsers race the click handler if revoked synchronously.
    setTimeout(function revoke() { URL.revokeObjectURL(url) }, 0)
}

async function copyToClipboard(markdown: string): Promise<boolean> {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(markdown)
            return true
        } catch {
            // fall through to legacy path
        }
    }
    // Legacy fallback for non-secure contexts (http on a LAN, older browsers). Avoids `document.execCommand`
    // failing silently — the textarea must be visible-ish for selection to succeed in some engines.
    const textarea = document.createElement('textarea')
    textarea.value = markdown
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    let ok: boolean
    try {
        ok = document.execCommand('copy')
    } catch {
        ok = false
    }
    document.body.removeChild(textarea)
    return ok
}

async function fetchExport(props: Props): Promise<{ filename: string; markdown: string }> {
    if (props.scope === 'project') {
        return await exportProjectAdvisoryMarkdownAction(props.projectId, props.depType)
    }
    return await exportLibraryAdvisoryMarkdownAction(props.packageName, props.depType, props.ecosystem)
}

export function ExportAdvisoryButton(props: Props) {
    const t = useTranslations('Triage')
    const [open, setOpen] = useState<boolean>(false)
    const [pending, startTransition] = useTransition()
    const [copied, setCopied] = useState(false)
    const wrapperRef = useRef<HTMLDivElement>(null)
    useEffect(function bindOutsideClick() {
        if (!open) return
        function onMouseDown(e: MouseEvent) {
            const target = e.target as Node | null
            if (wrapperRef.current && target && !wrapperRef.current.contains(target)) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', onMouseDown)
        return function cleanup() {
            document.removeEventListener('mousedown', onMouseDown)
        }
    }, [open])
    function toggle() {
        setOpen(function next(prev) { return !prev })
    }
    function chooseCopy() {
        setOpen(false)
        startTransition(async function run() {
            const result = await fetchExport(props)
            const ok = await copyToClipboard(result.markdown)
            if (ok) {
                setCopied(true)
                setTimeout(function clear() { setCopied(false) }, 2000)
            }
        })
    }
    function chooseDownload() {
        setOpen(false)
        startTransition(async function run() {
            const result = await fetchExport(props)
            triggerDownload(result.filename, result.markdown)
        })
    }
    let label = t('export.advisory')
    if (pending) label = t('export.exporting')
    else if (copied) label = t('export.copied')
    return (
        <div ref={wrapperRef} className="relative">
            <Button
                variant="outline"
                onClick={toggle}
                disabled={pending}
                aria-haspopup="menu"
                aria-expanded={open}
            >
                {copied ? <Check className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                {label}
                <ChevronDown className="h-4 w-4 opacity-60" />
            </Button>
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 top-full z-40 mt-1 min-w-48 rounded-md border bg-card p-1 shadow-md"
                >
                    <button
                        type="button"
                        role="menuitem"
                        onClick={chooseCopy}
                        className={cn(
                            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                            'hover:bg-accent hover:text-accent-foreground'
                        )}
                    >
                        <Copy className="h-4 w-4" />
                        {t('export.copyToClipboard')}
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={chooseDownload}
                        className={cn(
                            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                            'hover:bg-accent hover:text-accent-foreground'
                        )}
                    >
                        <Download className="h-4 w-4" />
                        {t('export.downloadMd')}
                    </button>
                </div>
            )}
        </div>
    )
}
