// The worker/host timezone, where cron runs when the schedule names none: what the settings pages show so a time
// of day means something out of the box.
export function hostTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
        return 'UTC'
    }
}
