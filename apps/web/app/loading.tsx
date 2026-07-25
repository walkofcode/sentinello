// Route-level loading boundary for the projects dashboard.
//
// Two jobs, both about perceived speed on navigation back from a project detail page:
// 1. It gives the App Router something to show immediately, so the browser stops sitting on the
//    previous page with no feedback while the server renders — which is what made the delay read as
//    far longer than it was.
// 2. For a dynamic route (this page reads searchParams), <Link> prefetch only fills up to the
//    nearest loading boundary; with no boundary there was nothing useful to prefetch at all.
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
                                <div className="h-5 w-24 animate-pulse rounded bg-muted" />
                                <div className="h-5 w-32 animate-pulse rounded bg-muted" />
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7]
