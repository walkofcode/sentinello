import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { Section } from './section'

const STEPS = ['step1', 'step2', 'step3']
const POINTS = ['point1', 'point2', 'point3']

// The narrative block, parked right under the hero: why it exists, how it works, and who it's for —
// merged into one section so it reads as a single argument rather than three repeating headers.
export function Story() {
    const tWhy = useTranslations('Why')
    const tHow = useTranslations('How')
    const tWho = useTranslations('WhoFor')
    return (
        <Section id="why">
            <div className="max-w-3xl">
                <h2 className="text-3xl font-bold tracking-tight">{tWhy('title')}</h2>
                <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{tWhy('lead')}</p>
                <p className="mt-5 leading-relaxed text-muted-foreground">{tWhy('body1')}</p>
                <p className="mt-6 border-l-2 border-primary/40 pl-4 text-lg font-medium leading-relaxed text-foreground">{tWhy('callout')}</p>
                <p className="mt-6 leading-relaxed text-muted-foreground">{tWhy('body2')}</p>
            </div>

            <div className="mt-16">
                <h3 className="text-2xl font-bold tracking-tight">{tHow('title')}</h3>
                <p className="mt-3 max-w-2xl text-muted-foreground">{tHow('subtitle')}</p>
                <div className="mt-8 grid gap-6 sm:grid-cols-3">
                    {STEPS.map(function step(key) {
                        return (
                            <div key={key} className="rounded-card border bg-card p-6">
                                <h4 className="font-semibold">{tHow(key + 'Title')}</h4>
                                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{tHow(key + 'Body')}</p>
                            </div>
                        )
                    })}
                </div>
            </div>

            <div className="mt-16 max-w-3xl">
                <h3 className="text-2xl font-bold tracking-tight">{tWho('title')}</h3>
                <p className="mt-3 leading-relaxed text-muted-foreground">{tWho('lead')}</p>
                <ul className="mt-6 space-y-3">
                    {POINTS.map(function point(key) {
                        return (
                            <li key={key} className="flex gap-3">
                                <Check className="mt-1 h-4 w-4 shrink-0 text-success" />
                                <span className="leading-relaxed text-foreground/90">{tWho(key)}</span>
                            </li>
                        )
                    })}
                </ul>
                <p className="mt-6 leading-relaxed text-muted-foreground">{tWho('honest')}</p>
            </div>
        </Section>
    )
}
