import { setRequestLocale } from 'next-intl/server'
import { Hero } from '@/components/sections/hero'
import { Story } from '@/components/sections/story'
import { Features } from '@/components/sections/features'
import { Screenshots } from '@/components/sections/screenshots'
import { Comparison } from '@/components/sections/comparison'
import { ReleaseNotes } from '@/components/sections/release-notes'
import { Roadmap } from '@/components/sections/roadmap'

type PageProps = {
    params: Promise<{ locale: string }>
}

export default async function HomePage({ params }: PageProps) {
    const { locale } = await params
    setRequestLocale(locale)
    return (
        <>
            <Hero />
            <Features />
            <Screenshots />
            <Comparison />
            <Story />
            <ReleaseNotes />
            <Roadmap />
        </>
    )
}
