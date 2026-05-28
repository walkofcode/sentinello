import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getConfigValue, listRoots } from '@sentinello/db'
import { AdvancedForm } from '@/components/settings/advanced-form'
import { McpTokenSection } from '@/components/settings/mcp-token-section'
import { getDb } from '@/lib/db'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('advanced.metaTitle') }
}

const DEFAULT_GLOBAL_IGNORE = ['node_modules', '.git', '.next', '.turbo', 'dist', 'build', 'out', 'coverage']

export default async function AdvancedSettingsPage() {
    const db = getDb()
    const parallelism = getConfigValue<number>(db, 'parallelism') || 4
    const watcherEnabled = getConfigValue<boolean>(db, 'watcherEnabled') || false
    const watcherRoots = getConfigValue<string[]>(db, 'watcherRoots') || []
    const globalIgnore = getConfigValue<string[]>(db, 'globalIgnore') || DEFAULT_GLOBAL_IGNORE
    const dryRunNotify = getConfigValue<boolean>(db, 'dryRunNotify') || false
    const portalBaseUrl = getConfigValue<string>(db, 'portalBaseUrl') || ''
    const notificationLocale = getConfigValue<string>(db, 'notificationLocale') || 'en'
    const roots = listRoots(db).map(function toOption(r) {
        return { id: r.id, path: r.path, label: r.label }
    })
    const storedMcpToken = getConfigValue<string>(db, 'mcp_api_token')
    const hasStoredToken = Boolean(storedMcpToken && storedMcpToken.trim().length > 0)
    const envManaged = Boolean((process.env.SENTINELLO_MCP_API_TOKEN || '').trim().length > 0)
    return (
        <div className="space-y-6">
            <AdvancedForm
                roots={roots}
                initial={{
                    parallelism,
                    watcherEnabled,
                    watcherRoots,
                    globalIgnore,
                    dryRunNotify,
                    portalBaseUrl,
                    notificationLocale
                }}
            />
            <McpTokenSection hasStoredToken={hasStoredToken} envManaged={envManaged} />
        </div>
    )
}
