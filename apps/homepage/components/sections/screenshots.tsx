'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { useTheme } from 'next-themes'
import { Section } from './section'
import { Lightbox, type Shot } from '@/components/ui/lightbox'

// Captured from the live portal scanning the bundled demo-projects (see scripts/shoot-homepage.mjs).
// Each shot has a light and a dark capture; we swap the set with the active theme. Files live at
// /screenshots/<key>-light.png and /screenshots/<key>-dark.png.
const SHOT_KEYS = ['dashboard', 'project', 'library', 'export'] as const
const SHOT_SIZE = { width: 1440, height: 900 }

export function Screenshots() {
    const t = useTranslations('Screenshots')
    const { resolvedTheme } = useTheme()
    const [mounted, setMounted] = useState<boolean>(false)
    useEffect(function markMounted() {
        setMounted(true)
    }, [])
    const [open, setOpen] = useState<number | null>(null)
    // Default to the light set until mounted to avoid an SSR/client hydration mismatch.
    const variant = mounted && resolvedTheme === 'dark' ? 'dark' : 'light'
    const shots: Shot[] = SHOT_KEYS.map(function toShot(key) {
        return { src: '/screenshots/' + key + '-' + variant + '.png', alt: t(key + 'Caption'), ...SHOT_SIZE }
    })
    return (
        <Section id="screenshots">
            <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
            <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{t('subtitle')}</p>
            <div className="mt-10 grid gap-5 sm:grid-cols-2">
                {shots.map(function thumb(shot, i) {
                    return (
                        <figure key={shot.src} className="overflow-hidden rounded-card border bg-card">
                            <button
                                onClick={function expand() { setOpen(i) }}
                                aria-label={shot.alt}
                                className="group block w-full text-left"
                            >
                                <span className="block overflow-hidden border-b bg-muted/30">
                                    <Image
                                        src={shot.src}
                                        alt={shot.alt}
                                        width={shot.width}
                                        height={shot.height}
                                        className="aspect-[16/10] w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.02]"
                                    />
                                </span>
                                <figcaption className="px-4 py-3 text-sm text-muted-foreground">{shot.alt}</figcaption>
                            </button>
                        </figure>
                    )
                })}
            </div>
            {open !== null && (
                <Lightbox shots={shots} index={open} onClose={function close() { setOpen(null) }} onNavigate={setOpen} />
            )}
        </Section>
    )
}
