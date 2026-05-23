import { ImageResponse } from 'next/og'
import { getTranslations } from 'next-intl/server'

export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

// Dynamic, per-locale social card. Uses the built-in next/og renderer (no extra dependency).
export default async function OpengraphImage({ params }: { params: Promise<{ locale: string }> }) {
    const { locale } = await params
    const t = await getTranslations({ locale, namespace: 'Meta' })
    return new ImageResponse(
        (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    padding: '80px',
                    background: 'linear-gradient(135deg, #0b1220 0%, #111a2e 100%)',
                    color: '#e6edf6'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '20px', fontSize: 44, fontWeight: 700 }}>
                    <div
                        style={{
                            width: 56,
                            height: 56,
                            borderRadius: 14,
                            background: '#3b82f6',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#0b1220',
                            fontSize: 34,
                            fontWeight: 800
                        }}
                    >
                        S
                    </div>
                    Sentinello
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    <div style={{ fontSize: 60, fontWeight: 800, lineHeight: 1.05, maxWidth: 1000 }}>{t('tagline')}</div>
                    <div style={{ fontSize: 30, color: '#9fb0c7', maxWidth: 1000 }}>{t('description')}</div>
                </div>
            </div>
        ),
        size
    )
}
