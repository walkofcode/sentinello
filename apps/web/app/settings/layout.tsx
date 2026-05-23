import { type ReactNode } from 'react'
import { SettingsTabs } from '@/components/settings/settings-tabs'

export default function SettingsLayout({ children }: { children: ReactNode }) {
    return (
        <div>
            <div className="mb-6 md:hidden">
                <SettingsTabs />
            </div>
            {children}
        </div>
    )
}
