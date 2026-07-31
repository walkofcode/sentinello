import { ZodError } from 'zod'

// The shape a Server Action uses when the user can cause the failure and needs to read it.
//
// This is not a style preference. A Server Action that THROWS has its message redacted in production
// builds — the client receives, verbatim:
//
//   "An error occurred in the Server Components render. The specific message is omitted in production
//    builds to avoid leaking sensitive details. A digest property is included on this error instance
//    which may provide additional details about the nature of the error."
//
// So a form that catches a thrown action and renders `err.message` shows that paragraph instead of
// the sentence someone wrote for the operator. Sentinello had exactly that bug on Settings → Sources:
// the "at least one source must stay enabled" invariant is the only thing standing between an
// operator and a scanner that reports every project clean forever, and its explanation never arrived.
//
// A message meant for a human therefore has to travel as a RETURN VALUE. testSendNotificationTarget
// Action has always used this shape; these actions now agree with it.
export type ActionResult = { ok: true } | { ok: false; errorText: string }

// A rejection written for the operator to read, as opposed to a bug. Thrown inside an action body and
// converted to { ok: false } by run(); anything else keeps throwing.
export class UserFacingError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'UserFacingError'
    }
}

// zod issues carry the field path, which is what makes "parallelism: Too big" readable when a form
// has eight inputs and one of them is wrong.
function formatZodError(err: ZodError): string {
    return err.issues
        .map(function one(issue) {
            const path = issue.path.join('.')
            return path ? path + ': ' + issue.message : issue.message
        })
        .join('; ')
}

// Runs an action body and converts the two user-caused failure kinds into a value.
//
// Everything else is rethrown on purpose. An unknown ecosystem id or a missing root id cannot be
// produced by the UI — reaching one means a bug, and a bug belongs in the server log with a digest
// rather than rendered to the operator as though they had mistyped something.
export async function run(body: () => void | Promise<void>): Promise<ActionResult> {
    try {
        await body()
        return { ok: true }
    } catch (err) {
        if (err instanceof UserFacingError) return { ok: false, errorText: err.message }
        if (err instanceof ZodError) return { ok: false, errorText: formatZodError(err) }
        throw err
    }
}
