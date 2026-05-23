type Props = {
    points: number[]
    width?: number
    height?: number
}

// Inline-SVG sparkline. No dependency, no client-side state. Scales the input series to fit.
export function Sparkline({ points, width = 200, height = 40 }: Props) {
    if (points.length === 0) {
        return <span className="text-xs text-muted-foreground">no scan history</span>
    }
    const max = Math.max(1, ...points)
    const min = Math.min(0, ...points)
    const range = max - min || 1
    const step = points.length > 1 ? width / (points.length - 1) : width
    const coords = points.map(function toCoord(value, index) {
        const x = index * step
        const y = height - ((value - min) / range) * height
        return x.toFixed(2) + ',' + y.toFixed(2)
    })
    const path = 'M' + coords.join(' L ')
    return (
        <svg width={width} height={height} viewBox={'0 0 ' + width + ' ' + height} className="text-primary">
            <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
            {points.map(function dot(value, index) {
                const x = index * step
                const y = height - ((value - min) / range) * height
                return <circle key={index} cx={x} cy={y} r={2} fill="currentColor" />
            })}
        </svg>
    )
}
