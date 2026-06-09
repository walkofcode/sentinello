'use client'

import { useEffect, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Copy, KeyRound, Link2, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { clearMcpTokenAction, generateMcpTokenAction } from '@/lib/actions/mcp'

type Props = {
    hasStoredToken: boolean
    portalBaseUrl: string
}

type Snippet = {
    key: string
    label: string
    note?: string
    code: string
}

const TOKEN_PLACEHOLDER = '<your-token>'

// Builds the per-client connection snippets shown under the token. `token` is the freshly generated
// value while it's still on screen; once it's gone we fall back to a placeholder the operator pastes
// over. Codex deliberately takes an env-var NAME (bearer_token_env_var), not a literal secret, so its
// snippet wires the token through SENTINELLO_MCP_TOKEN instead of inlining it. Notes are passed in
// already-translated since this helper runs outside the component (no hooks here).
function buildSnippets(url: string, token: string, notes: { runInTerminal: string; codexNote: string }): Snippet[] {
    return [
        {
            key: 'claude-code',
            label: 'Claude Code',
            note: notes.runInTerminal,
            code: `claude mcp add --transport http sentinello ${url} \\\n  --header "Authorization: Bearer ${token}"`
        },
        {
            key: 'claude-code-json',
            label: 'Claude Code (.mcp.json)',
            code: `{\n  "mcpServers": {\n    "sentinello": {\n      "type": "http",\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${token}" }\n    }\n  }\n}`
        },
        {
            key: 'codex',
            label: 'Codex (~/.codex/config.toml)',
            note: notes.codexNote,
            code: `[mcp_servers.sentinello]\nurl = "${url}"\nbearer_token_env_var = "SENTINELLO_MCP_TOKEN"`
        },
        {
            key: 'cursor',
            label: 'Cursor (.cursor/mcp.json)',
            code: `{\n  "mcpServers": {\n    "sentinello": {\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${token}" }\n    }\n  }\n}`
        },
        {
            key: 'claude-desktop',
            label: 'Claude Desktop (claude_desktop_config.json)',
            code: `{\n  "mcpServers": {\n    "sentinello": {\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${token}" }\n    }\n  }\n}`
        }
    ]
}

// One copy-able client snippet. Owns its own "copied" state so the buttons don't share a flag.
function SnippetBlock({ label, note, code }: Omit<Snippet, 'key'>) {
    const tc = useTranslations('Common')
    const [copied, setCopied] = useState(false)

    function onCopy() {
        navigator.clipboard.writeText(code)
        setCopied(true)
    }

    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{label}</span>
                <Button type="button" variant="outline" size="sm" onClick={onCopy}>
                    <Copy className="h-3.5 w-3.5" />
                    {copied ? tc('copied') : tc('copy')}
                </Button>
            </div>
            {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">
                <code className="font-mono">{code}</code>
            </pre>
        </div>
    )
}

// Settings → MCP section. The bearer token is both the credential AND the on/off switch: generating
// one turns the /api/mcp endpoint on, clearing it turns it off (the endpoint 404s with no token). The
// token is never round-tripped from the server after creation — we only know whether one exists
// (hasStoredToken). When the operator generates a fresh token, the action returns it once for copy-out
// (and to fill the client snippets); after that it lives only in the SQLite app_config row.
export function McpTokenSection({ hasStoredToken, portalBaseUrl }: Props) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const [revealed, setRevealed] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [urlCopied, setUrlCopied] = useState(false)
    const [pending, startTransition] = useTransition()
    // Prefer the configured portal base URL (set under Settings → Advanced); fall back to the
    // origin the operator is actually browsing from. The origin is only available client-side, so
    // the initial render uses the relative path on both server and client to avoid a hydration
    // mismatch, then the effect fills in the absolute URL.
    const [mcpUrl, setMcpUrl] = useState(function initUrl() {
        if (portalBaseUrl) return portalBaseUrl.replace(/\/+$/, '') + '/api/mcp'
        return '/api/mcp'
    })

    useEffect(function resolveUrl() {
        if (portalBaseUrl) return
        setMcpUrl(window.location.origin + '/api/mcp')
    }, [portalBaseUrl])

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

    function onCopyUrl() {
        navigator.clipboard.writeText(mcpUrl)
        setUrlCopied(true)
    }

    const live = hasStoredToken || revealed !== null
    const token = revealed || TOKEN_PLACEHOLDER
    const snippets = buildSnippets(mcpUrl, token, {
        runInTerminal: t('mcp.runInTerminal'),
        codexNote: t('mcp.codexNote', { token })
    })

    return (
        <section className="space-y-4 rounded-(--radius-card) border bg-card p-6">
            <header className="flex items-start gap-3">
                <KeyRound className="mt-1 h-5 w-5 text-muted-foreground" />
                <div>
                    <h2 className="text-base font-semibold">{t('mcp.title')}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{t('mcp.description')}</p>
                </div>
            </header>

            <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Link2 className="h-4 w-4 text-muted-foreground" />
                    {t('mcp.serverUrl')}
                </div>
                <div className="flex gap-2">
                    <Input readOnly value={mcpUrl} className="font-mono text-xs" />
                    <Button type="button" variant="outline" onClick={onCopyUrl}>
                        <Copy className="h-4 w-4" />
                        {urlCopied ? tc('copied') : tc('copy')}
                    </Button>
                </div>
            </div>

            <div className="space-y-3">
                <div className="text-sm">
                    {t('mcp.status')}{' '}
                    <span className={live ? 'font-medium text-emerald-500' : 'font-medium text-amber-500'}>
                        {live ? t('mcp.statusLive') : t('mcp.statusOff')}
                    </span>
                </div>
                {revealed ? (
                    <div className="space-y-2">
                        <div className="text-xs text-muted-foreground">{t('mcp.copyOnce')}</div>
                        <div className="flex gap-2">
                            <Input readOnly value={revealed} className="font-mono text-xs" />
                            <Button type="button" variant="outline" onClick={onCopy}>
                                <Copy className="h-4 w-4" />
                                {copied ? tc('copied') : tc('copy')}
                            </Button>
                        </div>
                    </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={onGenerate} disabled={pending}>
                        <RefreshCw className="h-4 w-4" />
                        {hasStoredToken ? t('mcp.rotate') : t('mcp.generate')}
                    </Button>
                    {hasStoredToken ? (
                        <Button type="button" variant="destructive" onClick={onClear} disabled={pending}>
                            <Trash2 className="h-4 w-4" />
                            {t('mcp.clear')}
                        </Button>
                    ) : null}
                </div>
            </div>

            <div className="space-y-3 border-t pt-4">
                <div>
                    <h3 className="text-sm font-medium">{t('mcp.connectTitle')}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {revealed
                            ? t('mcp.connectHintRevealed')
                            : t('mcp.connectHintPlaceholder', { placeholder: TOKEN_PLACEHOLDER })}
                    </p>
                </div>
                {snippets.map(function renderSnippet(s) {
                    return <SnippetBlock key={s.key} label={s.label} note={s.note} code={s.code} />
                })}
            </div>
        </section>
    )
}
