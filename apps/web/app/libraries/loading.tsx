// Route-level loading boundary for the libraries list. Same rationale as app/loading.tsx: immediate
// feedback on navigation, and a prefetch target for this dynamic route.
export default function Loading() {
    return (
        <div className="space-y-6" aria-busy="true" aria-live="polite">
            <div className="flex items-center justify-between gap-4">
                <div className="h-7 w-40 animate-pulse rounded-md bg-muted" />
                <div className="h-9 w-56 animate-pulse rounded-md bg-muted" />
            </div>
            <div className="rounded-lg border">
                <div className="border-b p-4">
                    <div className="h-5 w-32 animate-pulse rounded bg-muted" />
                </div>
                <div className="divide-y">
                    {SKELETON_ROWS.map(function row(key) {
                        return (
                            <div key={key} className="flex items-center gap-4 p-4">
                                <div className="h-5 flex-1 animate-pulse rounded bg-muted" />
                                <div className="h-5 w-20 animate-pulse rounded bg-muted" />
                                <div className="h-5 w-28 animate-pulse rounded bg-muted" />
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7]
