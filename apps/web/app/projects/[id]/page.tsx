import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'
import {
    countResolvedFindingsForProject,
    countScansForProject,
    getLatestScanForProject,
    getProjectById,
    getRootById,
    isScanInFlightForProject,
    listActiveMutes,
    listCurrentFindingsForProject,
    listFindingsForScan,
    listFindingsResolvedInScan,
    listMuteLiftsForProject,
    listResolvedFindingsForProject,
    listScansForProject
} from '@sentinello/db'
import { reasonCodeLabel, scanStatusLabel, type Locale } from '@sentinello/core'
import { Badge } from '@/components/ui/badge'
import { ScrollToTop } from '@/components/layout/scroll-to-top'
import { AliasEditor } from '@/components/triage/alias-editor'
import { MuteDialog } from '@/components/triage/mute-dialog'
import { MuteLiftsTable } from '@/components/triage/mute-lifts-table'
import { ScanAutoRefresh } from '@/components/scan-auto-refresh'
import { ExportAdvisoryButton } from '@/components/triage/export-advisory-button'
import { ScanNowButton } from '@/components/triage/scan-now-button'
import { TagEditor } from '@/components/triage/tag-editor'
import { FindingsSection } from '@/components/findings/findings-section'
import { ResolvedFindingsTable } from '@/components/findings/resolved-findings-table'
import { ScanHistory, type ScanFindingVM, type ScanHistoryRowVM } from '@/components/findings/scan-history'
import { DepTypeFilter } from '@/components/findings/dep-type-filter'
import { UrlPagination } from '@/components/ui/url-pagination'
import { getDb } from '@/lib/db'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { getFilterDefaults, parseDepTypeParam } from '@/lib/filter-defaults'

type PageProps = {
    params: Promise<{ id: string }>
    searchParams: Promise<{ dep?: string; scanPage?: string; resolvedPage?: string }>
}

const RESOLVED_PAGE_SIZE = 25
const SCAN_PAGE_SIZE = 20

function parsePageParam(raw: string | undefined): number {
    const n = parseInt(raw || '1', 10)
    if (!Number.isFinite(n) || n < 1) return 1
    return n
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const resolvedParams = await params
    const t = await getTranslations('Detail')
    const db = getDb()
    const project = getProjectById(db, resolvedParams.id)
    return { title: project && (project.alias || project.name) || t('project.metaFallback') }
}

export default async function ProjectDetailPage({ params, searchParams }: PageProps) {
    const resolvedParams = await params
    const resolvedSearchParams = await searchParams
    const t = await getTranslations('Detail')
    const tTime = await getTranslations('Time')
    const tTriage = await getTranslations('Triage')
    const locale = (await getLocale()) as Locale
    const db = getDb()
    const now = Date.now()
    const project = getProjectById(db, resolvedParams.id)
    if (!project) {
        notFound()
    }
    const defaults = getFilterDefaults(db)
    const depType = parseDepTypeParam(resolvedSearchParams.dep) || defaults.depType
    const root = getRootById(db, project.rootId)
    const findings = listCurrentFindingsForProject(db, project.id, now, depType)

    const resolvedTotal = countResolvedFindingsForProject(db, project.id)
    const resolvedTotalPages = Math.max(1, Math.ceil(resolvedTotal / RESOLVED_PAGE_SIZE))
    const resolvedPage = Math.min(parsePageParam(resolvedSearchParams.resolvedPage), resolvedTotalPages)
    const resolvedFindings = listResolvedFindingsForProject(
        db,
        project.id,
        RESOLVED_PAGE_SIZE,
        (resolvedPage - 1) * RESOLVED_PAGE_SIZE
    )

    const scanTotal = countScansForProject(db, project.id)
    const scanTotalPages = Math.max(1, Math.ceil(scanTotal / SCAN_PAGE_SIZE))
    const scanPage = Math.min(parsePageParam(resolvedSearchParams.scanPage), scanTotalPages)
    const scanHistory = listScansForProject(db, project.id, SCAN_PAGE_SIZE, (scanPage - 1) * SCAN_PAGE_SIZE)
    function toScanFindingVM(f: ReturnType<typeof listFindingsForScan>[number]): ScanFindingVM {
        return {
            id: f.id,
            severity: f.severity,
            packageName: f.packageName,
            installedVersion: f.installedVersion,
            advisoryId: f.advisoryId
        }
    }
    const scanHistoryVM: ScanHistoryRowVM[] = scanHistory.map(function toVM(scan) {
        return {
            id: scan.id,
            finishedRelative: formatRelativeTime(scan.finishedAt, tTime, now),
            finishedAbsolute: formatAbsoluteTime(scan.finishedAt),
            statusLabel: scanStatusLabel(scan.status, locale),
            statusOk: scan.status === 'ok',
            reasonLabel: scan.reasonCode && scan.reasonCode !== 'ok' ? reasonCodeLabel(scan.reasonCode, locale) : null,
            errorText: scan.errorText,
            discovered: listFindingsForScan(db, scan.id).map(toScanFindingVM),
            resolved: listFindingsResolvedInScan(db, scan.id).map(toScanFindingVM)
        }
    })
    const muteLifts = listMuteLiftsForProject(db, project.id, 20)
    const activeMutes = listActiveMutes(db, now).filter(function forProject(m): boolean {
        return m.projectId === project.id || (m.projectId === null && m.scope === 'finding')
    })
    const projectScopeMute = activeMutes.find(function isProjScope(m): boolean {
        return m.scope === 'project' && m.projectId === project.id
    })

    const displayName = project.alias || project.name
    const rootLabel = root?.label || root?.path || t('project.unknownRoot')
    const fullPath = project.relPath === '.' ? rootLabel : rootLabel + '/' + project.relPath
    const latestScan = getLatestScanForProject(db, project.id)
    const lastScanAt = latestScan ? latestScan.finishedAt : null
    const scanning = isScanInFlightForProject(db, project.id, project.rootId, now)
    return (
        <div className="space-y-8">
            <ScrollToTop />
            <ScanAutoRefresh active={scanning} />
            <header className="space-y-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                        <h1 className="text-3xl font-semibold tracking-tight">{displayName}</h1>
                        <p className="mt-2 text-sm text-muted-foreground">
                            {fullPath} · {project.packageManager} · Node {project.nvmrcVersion || 'ambient'} ·{' '}
                            {lastScanAt ? t('project.scannedRelative', { time: formatRelativeTime(lastScanAt, tTime, now) }) : t('project.neverScanned')}
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <ScanNowButton projectId={project.id} scanning={scanning} />
                        {findings.length > 0 ? (
                            <ExportAdvisoryButton scope="project" projectId={project.id} depType={depType} />
                        ) : null}
                        {projectScopeMute ? (
                            <MuteDialog projectId={project.id} muteId={projectScopeMute.id} label={tTriage('mute.unmuteProject')} />
                        ) : (
                            <MuteDialog projectId={project.id} />
                        )}
                        <AliasEditor
                            projectId={project.id}
                            folderName={project.name}
                            currentAlias={project.alias}
                        />
                        <TagEditor projectId={project.id} initialTags={project.tags} />
                    </div>
                </div>
                {projectScopeMute || project.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                        {projectScopeMute ? <Badge variant="muted">{t('project.projectMuted')}</Badge> : null}
                        {project.tags.map(function chip(tag) {
                            return (
                                <Badge key={tag} variant="outline" className="normal-case tracking-normal">
                                    {tag}
                                </Badge>
                            )
                        })}
                    </div>
                ) : null}
            </header>

            <section className="space-y-3">
                {findings.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-(--radius-card) border border-dashed border-emerald-500/30 bg-emerald-500/5 px-6 py-16 text-center">
                        <ShieldCheck className="h-10 w-10 text-emerald-500" aria-hidden="true" />
                        <p className="mt-3 text-base font-medium">{t('project.allClearTitle')}</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t('project.allClearBody')}
                        </p>
                    </div>
                ) : (
                    <>
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <h2 className="text-lg font-semibold">{t('project.currentFindings', { count: findings.length })}</h2>
                            <DepTypeFilter value={depType} defaultValue={defaults.depType} />
                        </div>
                        <FindingsSection findings={findings} projectId={project.id} mutes={activeMutes} now={now} />
                    </>
                )}
            </section>

            {resolvedTotal > 0 ? (
                <section className="space-y-3">
                    <div className="flex items-baseline justify-between">
                        <h2 className="text-lg font-semibold">{t('project.resolvedFindings', { count: resolvedTotal })}</h2>
                    </div>
                    <ResolvedFindingsTable findings={resolvedFindings} now={now} />
                    <UrlPagination
                        page={resolvedPage}
                        totalPages={resolvedTotalPages}
                        totalItems={resolvedTotal}
                        pageSize={RESOLVED_PAGE_SIZE}
                        itemLabel="finding"
                        paramName="resolvedPage"
                    />
                </section>
            ) : null}

            {muteLifts.length > 0 ? (
                <section className="space-y-3">
                    <div className="flex items-baseline justify-between">
                        <h2 className="text-lg font-semibold">{t('liftedMutes')}</h2>
                        <span className="text-xs text-muted-foreground">
                            {t('recentCount', { count: muteLifts.length })}
                        </span>
                    </div>
                    <MuteLiftsTable lifts={muteLifts} now={now} />
                </section>
            ) : null}

            <section className="space-y-3">
                <h2 className="text-lg font-semibold">{t('project.scanHistory', { count: scanTotal })}</h2>
                <ScanHistory scans={scanHistoryVM} />
                <UrlPagination
                    page={scanPage}
                    totalPages={scanTotalPages}
                    totalItems={scanTotal}
                    pageSize={SCAN_PAGE_SIZE}
                    itemLabel="scan"
                    paramName="scanPage"
                />
            </section>
        </div>
    )
}

