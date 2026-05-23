import { getTranslations } from 'next-intl/server'
import type { MuteLift } from '@sentinello/db'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'

type Props = {
    lifts: MuteLift[]
    now: number
}

export async function MuteLiftsTable({ lifts, now }: Props) {
    const t = await getTranslations('Triage')
    const tt = await getTranslations('Time')
    return (
        <>
            <div className="space-y-2 md:hidden">
                {lifts.map(function card(lift) {
                    const identity = lift.scope === 'finding'
                        ? (lift.packageName || '?') + ' · ' + (lift.advisoryId || '?') + ' · ' + (lift.scanner || '?')
                        : '—'
                    return (
                        <Card key={lift.id} className="p-4">
                            <div className="flex items-center gap-2">
                                <Badge variant="outline">{lift.scope}</Badge>
                                <span className="ml-auto font-mono text-xs text-muted-foreground" title={formatAbsoluteTime(lift.liftedAt)}>
                                    {formatRelativeTime(lift.liftedAt, tt, now)}
                                </span>
                            </div>
                            <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 text-xs">
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('lifts.identity')}</dt>
                                <dd className="min-w-0 break-words font-mono text-muted-foreground">{identity}</dd>
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('lifts.reason')}</dt>
                                <dd className="min-w-0 break-words">{lift.reason}</dd>
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('lifts.author')}</dt>
                                <dd className="text-muted-foreground">{lift.author}</dd>
                            </dl>
                        </Card>
                    )
                })}
            </div>
            <div className="hidden md:block">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t('lifts.lifted')}</TableHead>
                            <TableHead>{t('lifts.scope')}</TableHead>
                            <TableHead>{t('lifts.identity')}</TableHead>
                            <TableHead>{t('lifts.reason')}</TableHead>
                            <TableHead>{t('lifts.author')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {lifts.map(function row(lift) {
                            return (
                                <TableRow key={lift.id}>
                                    <TableCell className="font-mono text-xs">
                                        <span title={formatAbsoluteTime(lift.liftedAt)}>
                                            {formatRelativeTime(lift.liftedAt, tt, now)}
                                        </span>
                                    </TableCell>
                                    <TableCell>
                                        <Badge variant="outline">{lift.scope}</Badge>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">
                                        {lift.scope === 'finding'
                                            ? (lift.packageName || '?') + ' · ' + (lift.advisoryId || '?') + ' · ' + (lift.scanner || '?')
                                            : '—'}
                                    </TableCell>
                                    <TableCell className="text-xs">{lift.reason}</TableCell>
                                    <TableCell className="text-xs text-muted-foreground">{lift.author}</TableCell>
                                </TableRow>
                            )
                        })}
                    </TableBody>
                </Table>
            </div>
        </>
    )
}
