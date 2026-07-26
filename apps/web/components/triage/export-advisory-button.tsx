'use client'

import { useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Check, ChevronDown, Copy, Download, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAnchoredPanel } from '@/components/ui/use-anchored-panel'
import { cn } from '@/lib/cn'
import {
    exportLibraryAdvisoryMarkdownAction,
    exportProjectAdvisoryMarkdownAction
} from '@/lib/actions/export'

type DepType = 'all' | 'prod' | 'dev'

const MENU_WIDTH = 224
const FLIP_THRESHOLD = 140

// iconOnly is the compact form used by the project-list row actions: the trigger collapses to an
// icon (label moves to the accessible name / tooltip) while the copy + download menu is unchanged.
type Props =
    | { scope: 'project'; projectId: string; depType: DepType; iconOnly?: boolean }
    | { scope: 'library'; packageName: string; ecosystem: string; depType: DepType; iconOnly?: boolean }

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
    const [pending, startTransition] = useTransition()
    const [copied, setCopied] = useState(false)
    const { open, close, toggle, triggerRef, panelRef, style } = useAnchoredPanel<HTMLButtonElement>({
        align: 'right',
        width: MENU_WIDTH,
        flipThreshold: FLIP_THRESHOLD
    })
    function chooseCopy() {
        close()
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
        close()
        startTransition(async function run() {
            const result = await fetchExport(props)
            triggerDownload(result.filename, result.markdown)
        })
    }
    let label = t('export.advisory')
    if (pending) label = t('export.exporting')
    else if (copied) label = t('export.copied')
    return (
        <div className="inline-flex">
            <Button
                ref={triggerRef}
                variant="outline"
                size={props.iconOnly ? 'icon' : 'default'}
                onClick={toggle}
                disabled={pending}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={props.iconOnly ? label : undefined}
                title={props.iconOnly ? label : undefined}
            >
                {copied ? <Check className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                {props.iconOnly ? null : label}
                {props.iconOnly ? null : <ChevronDown className="h-4 w-4 opacity-60" />}
            </Button>
            {open && style && typeof document !== 'undefined'
                ? createPortal(
                      <div
                          ref={panelRef}
                          role="menu"
                          style={style}
                          className="z-50 min-w-48 rounded-md border bg-card p-1 shadow-md"
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
                      </div>,
                      document.body
                  )
                : null}
        </div>
    )
}
