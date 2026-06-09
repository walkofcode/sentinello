import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getConfigValue } from '@sentinello/db'
import { McpTokenSection } from '@/components/settings/mcp-token-section'
import { getDb } from '@/lib/db'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('mcp.metaTitle') }
}

export default async function McpSettingsPage() {
    const db = getDb()
    const portalBaseUrl = getConfigValue<string>(db, 'portalBaseUrl') || ''
    const storedMcpToken = getConfigValue<string>(db, 'mcp_api_token')
    const hasStoredToken = Boolean(storedMcpToken && storedMcpToken.trim().length > 0)
    return (
        <div className="space-y-6">
            <McpTokenSection hasStoredToken={hasStoredToken} portalBaseUrl={portalBaseUrl} />
        </div>
    )
}
