import { setRequestLocale } from 'next-intl/server'
import { Hero } from '@/components/sections/hero'
import { Why } from '@/components/sections/why'
import { HowItWorks } from '@/components/sections/how-it-works'
import { Features } from '@/components/sections/features'
import { Notifications } from '@/components/sections/notifications'
import { Screenshots } from '@/components/sections/screenshots'
import { SelfHost } from '@/components/sections/self-host'
import { Comparison } from '@/components/sections/comparison'
import { ReleaseNotes } from '@/components/sections/release-notes'
import { Roadmap } from '@/components/sections/roadmap'
import { WhoItsFor } from '@/components/sections/who-its-for'

type PageProps = {
    params: Promise<{ locale: string }>
}

export default async function HomePage({ params }: PageProps) {
    const { locale } = await params
    setRequestLocale(locale)
    return (
        <>
            <Hero />
            <HowItWorks />
            <Features />
            <Notifications />
            <Screenshots />
            <SelfHost />
            <Why />
            <Comparison />
            <ReleaseNotes />
            <Roadmap />
            <WhoItsFor />
        </>
    )
}
