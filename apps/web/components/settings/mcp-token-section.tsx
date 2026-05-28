'use client'

import { useState, useTransition } from 'react'
import { Copy, KeyRound, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { clearMcpTokenAction, generateMcpTokenAction } from '@/lib/actions/mcp'

type Props = {
    hasStoredToken: boolean
    envManaged: boolean
}

// Settings → Advanced subsection for the MCP bearer token. The token itself is never round-tripped
// from the server after creation — we only know whether one is set (hasStoredToken). When the
// operator generates a fresh token, the action returns it once for copy-out; after that it lives
// only in the SQLite app_config row.
export function McpTokenSection({ hasStoredToken, envManaged }: Props) {
    const [revealed, setRevealed] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [pending, startTransition] = useTransition()

    function onGenerate() {
        startTransition(async function gen() {
            const result = await generateMcpTokenAction()
            setRevealed(result.token)
            setCopied(false)
        })
    }

    function onClear() {
        startTransition(async function clr() {
            await clearMcpTokenAction()
            setRevealed(null)
            setCopied(false)
        })
    }

    function onCopy() {
        if (!revealed) return
        navigator.clipboard.writeText(revealed)
        setCopied(true)
    }

    return (
        <section className="space-y-4 rounded-(--radius-card) border bg-card p-6">
            <header className="flex items-start gap-3">
                <KeyRound className="mt-1 h-5 w-5 text-muted-foreground" />
                <div>
                    <h2 className="text-base font-semibold">MCP API token</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Bearer token required to connect Claude Desktop, Cursor, or any other MCP
                        client to Sentinello at <code className="font-mono text-xs">/api/mcp</code>.
                        Generate one, copy it once, then paste it into your client&rsquo;s server
                        config.
                    </p>
                </div>
            </header>

            {envManaged ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                    Token is managed by the <code className="font-mono text-xs">SENTINELLO_MCP_API_TOKEN</code> environment variable.
                    Unset that env var to manage the token from this UI instead.
                </div>
            ) : (
                <div className="space-y-3">
                    <div className="text-sm">
                        Status:{' '}
                        <span className={hasStoredToken ? 'font-medium text-emerald-500' : 'font-medium text-amber-500'}>
                            {hasStoredToken ? 'configured' : 'not configured — MCP requests will return 401'}
                        </span>
                    </div>
                    {revealed ? (
                        <div className="space-y-2">
                            <div className="text-xs text-muted-foreground">
                                Copy this now — it will not be shown again.
                            </div>
                            <div className="flex gap-2">
                                <Input readOnly value={revealed} className="font-mono text-xs" />
                                <Button type="button" variant="outline" onClick={onCopy}>
                                    <Copy className="h-4 w-4" />
                                    {copied ? 'Copied' : 'Copy'}
                                </Button>
                            </div>
                        </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                        <Button type="button" onClick={onGenerate} disabled={pending}>
                            <RefreshCw className="h-4 w-4" />
                            {hasStoredToken ? 'Rotate token' : 'Generate token'}
                        </Button>
                        {hasStoredToken ? (
                            <Button type="button" variant="destructive" onClick={onClear} disabled={pending}>
                                <Trash2 className="h-4 w-4" />
                                Clear token
                            </Button>
                        ) : null}
                    </div>
                </div>
            )}
        </section>
    )
}
