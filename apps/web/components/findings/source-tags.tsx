import { Badge } from '@/components/ui/badge'

type Props = {
    scanners: string[]
}

// One source badge per scanner that reported a finding. npm audit and OSV get distinct colors so a
// multi-source row reads at a glance; unknown scanners fall back to a neutral chip.
export function SourceTags({ scanners }: Props) {
    return (
        <>
            {scanners.map(function tag(scanner) {
                if (scanner === 'osv') return <Badge key={scanner} variant="osv">OSV</Badge>
                if (scanner === 'npm-audit') return <Badge key={scanner} variant="npm">npm</Badge>
                return <Badge key={scanner} variant="muted">{scanner}</Badge>
            })}
        </>
    )
}
