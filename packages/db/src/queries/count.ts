// A `COUNT(*)` with no GROUP BY always returns exactly one row — a filtered aggregate over zero matches
// still returns one, carrying 0. Drizzle's `.get()` is nevertheless typed `T | undefined` for every query
// alike, so the `?? 0` that four separate count helpers used to write was a branch no database state
// could reach, and no test could cover without faking the driver.
//
// Summing `.all()` produces the identical number with no branch at all: one row sums to that row's count,
// and the empty case sums to 0 by the seed rather than by a fallback.
export function sumCount(rows: { count: number }[]): number {
    return rows.reduce(function add(total, row) {
        return total + row.count
    }, 0)
}
