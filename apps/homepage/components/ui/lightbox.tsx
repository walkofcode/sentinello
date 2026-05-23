'use client'

import { useCallback, useEffect } from 'react'
import Image from 'next/image'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

export type Shot = {
    src: string
    alt: string
    width: number
    height: number
}

type Props = {
    shots: Shot[]
    index: number
    onClose: () => void
    onNavigate: (next: number) => void
}

// Full-screen image viewer. Closes on ESC or backdrop click; arrow keys / on-screen chevrons page
// through the gallery. Body scroll is locked while open.
export function Lightbox({ shots, index, onClose, onNavigate }: Props) {
    const t = useTranslations('Screenshots')
    const count = shots.length
    const go = useCallback(
        function go(delta: number) {
            onNavigate((index + delta + count) % count)
        },
        [index, count, onNavigate]
    )
    useEffect(function bindKeys() {
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowRight') go(1)
            if (e.key === 'ArrowLeft') go(-1)
        }
        document.addEventListener('keydown', onKey)
        const prevOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return function cleanup() {
            document.removeEventListener('keydown', onKey)
            document.body.style.overflow = prevOverflow
        }
    }, [go, onClose])
    const shot = shots[index]
    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={shot.alt}
            onClick={onClose}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm sm:p-8"
        >
            <button
                onClick={onClose}
                aria-label={t('close')}
                className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            >
                <X className="h-5 w-5" />
            </button>
            {count > 1 && (
                <button
                    onClick={function prev(e) { e.stopPropagation(); go(-1) }}
                    aria-label={t('prev')}
                    className="absolute left-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                >
                    <ChevronLeft className="h-6 w-6" />
                </button>
            )}
            <figure onClick={function stop(e) { e.stopPropagation() }} className="flex max-h-full max-w-6xl flex-col items-center gap-4">
                <Image
                    src={shot.src}
                    alt={shot.alt}
                    width={shot.width}
                    height={shot.height}
                    className="max-h-[80vh] w-auto rounded-lg border border-white/10 shadow-2xl"
                />
                <figcaption className="text-center text-sm text-white/80">{shot.alt}</figcaption>
            </figure>
            {count > 1 && (
                <button
                    onClick={function next(e) { e.stopPropagation(); go(1) }}
                    aria-label={t('next')}
                    className="absolute right-4 inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                >
                    <ChevronRight className="h-6 w-6" />
                </button>
            )}
        </div>
    )
}
