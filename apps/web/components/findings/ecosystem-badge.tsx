import { getEcosystem } from '@sentinello/core'
import { Badge, type BadgeProps } from '@/components/ui/badge'

// One badge per ecosystem/language. The label is the registry `displayName` (JavaScript / Python / Go /
// Rust) so Settings, filters, the library list, and detail headers never drift on ecosystem identity; an
// unknown id falls back to a neutral chip showing the raw value.
function ecosystemVariant(ecosystem: string): BadgeProps['variant'] {
    if (ecosystem === 'npm') return 'ecoJs'
    if (ecosystem === 'PyPI') return 'ecoPy'
    if (ecosystem === 'Go') return 'ecoGo'
    if (ecosystem === 'crates.io') return 'ecoRust'
    return 'muted'
}

export function ecosystemLabel(ecosystem: string): string {
    const def = getEcosystem(ecosystem)
    return def ? def.displayName : ecosystem
}

type Props = {
    ecosystem: string
    className?: string
}

export function EcosystemBadge({ ecosystem, className }: Props) {
    return (
        <Badge variant={ecosystemVariant(ecosystem)} className={className}>
            {ecosystemLabel(ecosystem)}
        </Badge>
    )
}
