'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { Alternative, AlternativeOption, ChainVerdict, Remediation, RemediationChain, RemediationHealth } from '@sentinello/core'
import { Badge } from '@/components/ui/badge'

// The "Way out" disclosure under a finding whose package has no fixed version released: the package's
// health, one verdict per dependency path, whether only dev tooling reaches it, and the curated
// alternatives. Everything here was computed and proven at scan time; this only renders it.
export function WayOut({ remediation }: { remediation: Remediation }) {
    const t = useTranslations('Findings.wayOut')
    return (
        <details className="mt-1 text-xs">
            <summary className="cursor-pointer font-medium text-foreground">{t('title')}</summary>
            <div className="mt-1 flex flex-col gap-1.5 border-l-2 border-muted pl-2">
                <HealthLine health={remediation.health} />
                <ul className="flex flex-col gap-1">
                    {remediation.chains.map(function chainItem(chain) {
                        return <ChainLine key={(chain.importer ?? '') + '|' + chain.path.join('>')} chain={chain} target={remediation.package} />
                    })}
                    {remediation.moreChains > 0 ? <li className="text-muted-foreground">{t(remediation.moreChainsAtLeast ? 'morePathsAtLeast' : 'morePaths', { count: remediation.moreChains })}</li> : null}
                </ul>
                <p className="text-muted-foreground">{devOnlyText(t, remediation.devOnly)}</p>
                {remediation.alternatives.map(function altItem(a) {
                    return <AlternativeLine key={a.replaces} alternative={a} />
                })}
                {remediation.partial ? <p className="text-muted-foreground">{t('partial')}</p> : null}
            </div>
        </details>
    )
}

type T = ReturnType<typeof useTranslations<'Findings.wayOut'>>

function devOnlyText(t: T, devOnly: boolean | null): string {
    if (devOnly === true) return t('devOnlyAll')
    if (devOnly === false) return t('devOnlyNo')
    return t('devOnlyUnknown')
}

function useSignals(): (s: { lastPublishAt: number | null; maintainers: number; weeklyDownloads: number | null }) => string {
    const t = useTranslations('Findings.wayOut')
    const format = useFormatter()
    return function signals(s) {
        const published = s.lastPublishAt === null ? t('lastPublishUnknown') : t('lastPublish', { date: format.dateTime(new Date(s.lastPublishAt), { dateStyle: 'medium' }) })
        const downloads = s.weeklyDownloads === null ? t('downloadsUnknown') : t('downloads', { count: s.weeklyDownloads })
        return [published, t('maintainers', { count: s.maintainers }), downloads].join(' · ')
    }
}

function HealthLine({ health }: { health: RemediationHealth }) {
    const t = useTranslations('Findings.wayOut')
    const signals = useSignals()
    let verdict = <span className="text-muted-foreground">{t('maintained')}</span>
    if (health.deprecated !== null) verdict = <span className="font-medium text-destructive">{t('deprecated', { message: health.deprecated })}</span>
    else if (health.unmaintained) verdict = <span className="font-medium text-destructive">{t('unmaintained')}</span>
    return (
        <p>
            <code className="font-mono">{health.name}</code> <span className="text-muted-foreground">{signals(health)}</span> — {verdict}
        </p>
    )
}

function ChainLine({ chain, target }: { chain: RemediationChain; target: string }) {
    const t = useTranslations('Findings.wayOut')
    return (
        <li className="flex flex-col gap-0.5">
            {chain.path.length > 0 ? (
                <span className="flex flex-wrap items-center gap-1">
                    <code className="break-all font-mono text-[0.625rem] text-muted-foreground">{chain.path.join(' › ')}</code>
                    {chain.importer !== null && chain.importer !== '.' ? <span className="text-[0.625rem] text-muted-foreground">{t('inWorkspace', { workspace: chain.importer })}</span> : null}
                    {chain.rootKind === 'dev' ? <Badge variant="dev">{t('devToolingOnly')}</Badge> : null}
                </span>
            ) : null}
            <span>{verdictText(t, chain.verdict, target)}</span>
        </li>
    )
}

function verdictText(t: T, v: ChainVerdict, target: string): string {
    if (v.kind === 'upgrade') return t('verdictUpgrade', { package: v.package, version: v.toAtLeast, target, size: v.proof.closureSize })
    if (v.kind === 'blocked') {
        return t('verdictBlocked', { escape: v.escapePackage, version: v.escapeVersion, target, blockedBy: v.blockedBy, latest: v.blockedByLatest ?? '—', range: v.blockedRange })
    }
    if (v.kind === 'noEscape') return t('verdictNoEscape', { packages: v.packages.join(', '), target })
    if (v.kind === 'unknown') return t('verdictUnknown', { at: v.at })
    return t('verdictDirect', { target })
}

function AlternativeLine({ alternative }: { alternative: Alternative }) {
    const t = useTranslations('Findings.wayOut')
    const signals = useSignals()
    const own = alternative.signals ? ' (' + signals(alternative.signals) + ')' : ''
    if (alternative.options.length === 0) {
        return <p>{t('noCurated', { name: alternative.replaces })}<span className="text-muted-foreground">{own}</span></p>
    }
    return (
        <div>
            <p>{t('alternativesFor', { name: alternative.replaces })}<span className="text-muted-foreground">{own}</span></p>
            <ul className="ml-3 list-disc">
                {alternative.options.map(function optionItem(o) {
                    return <li key={optionKey(o)}><OptionText option={o} /></li>
                })}
            </ul>
        </div>
    )
}

function optionKey(o: AlternativeOption): string {
    if (o.kind === 'module') return 'module:' + o.name
    if (o.kind === 'removal') return 'removal:' + o.description
    return o.kind + ':' + o.id
}

function OptionText({ option }: { option: AlternativeOption }) {
    const t = useTranslations('Findings.wayOut')
    const signals = useSignals()
    if (option.kind === 'module') {
        return (
            <span>
                <code className="font-mono">{option.name}{option.version ? '@' + option.version : ''}</code>{' '}
                <span className="text-muted-foreground">
                    {option.verified && option.proof ? t('verified', { size: option.proof.closureSize }) : t('notVerified')}
                    {option.signals ? ' · ' + signals(option.signals) : ''}
                </span>
            </span>
        )
    }
    const label = option.kind === 'native' ? t('builtIn', { id: option.id }) : option.kind === 'snippet' ? t('snippet') : t('removal')
    const detail = option.description
    return (
        <span>
            {option.url ? <a className="underline hover:opacity-80" href={option.url} target="_blank" rel="noreferrer">{label}</a> : label}
            {detail ? <span className="text-muted-foreground">: {detail}</span> : null}
        </span>
    )
}
