import { NextResponse } from 'next/server'
import { getVersionInfo } from '@/lib/version'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
    const info = await getVersionInfo()
    return NextResponse.json(info, {
        headers: {
            'Cache-Control': 'no-store'
        }
    })
}
