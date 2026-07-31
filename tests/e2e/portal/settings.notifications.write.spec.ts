import type { Locator, Page } from '@playwright/test'
import { expect, fillStable, test, visible, visibleRole } from './test-fixtures'
import { SEEDED } from './paths'

// Settings → Notifications.
//
// One control on this page is deliberately never touched: the live-test button, which is the only
// notification action that makes a REAL outbound HTTP request and is not gated by the dryRunNotify
// flag that contains the worker's automatic dispatch. Clicking it from a spec would POST to whatever
// host a fixture target names, from a laptop or from CI.
//
// apps/web/lib/e2e-spec-safety.test.ts enforces this by failing if that control's accessible name
// appears anywhere in a spec file — including, as this comment discovered, inside a comment explaining
// why it is not used. So the gap below is deliberate and the guard is why it stays that way.
//
// Everything else — create, edit, enable, duplicate, remove, backfill — is exercised.

const SLACK_URL = 'https://hooks.slack.example.invalid/services/T00/B00/e2e'
const WEBHOOK_URL = 'https://webhook.example.invalid/hook'

async function openAddTarget(page: Page): Promise<Locator> {
    await visibleRole(page, 'button', 'Add target').click()
    const dialog = page.getByRole('dialog', { name: 'Add notification target' })
    await expect(dialog.getByRole('button', { name: 'Kind' })).toBeVisible()
    return dialog
}

async function chooseKind(dialog: Locator, kind: string): Promise<void> {
    await dialog.getByRole('button', { name: 'Kind' }).click()
    await dialog.page().getByRole('option', { name: kind }).click()
}

// Creates the simplest valid Slack target, which most tests only need as a subject to act on.
async function addSlackTarget(page: Page): Promise<void> {
    const dialog = await openAddTarget(page)
    await fillStable(dialog.getByLabel('Slack incoming webhook URL'), SLACK_URL)
    await dialog.getByRole('button', { name: 'Add target' }).click()
    await expect(dialog).toBeHidden()
}

test.describe('the empty state', function () {
    test('explains what a target is and offers to add one', async function ({ page }) {
        await page.goto('/settings/notifications')

        await expect(page.getByText('No notification targets')).toBeVisible()
        await expect(page.getByText('Add a Slack webhook, Telegram bot, or generic webhook.')).toBeVisible()
        await expect(visibleRole(page, 'button', 'Add target')).toBeVisible()
    })
})

test.describe('creating a target', function () {
    test('adds a Slack target and masks its credential in the table', async function ({ page }) {
        await page.goto('/settings/notifications')

        await addSlackTarget(page)

        await expect(visible(page, /slack\(/)).toBeVisible()
        // The masked identity is the contract: the webhook URL is a bearer credential and the table
        // must never show enough of it to replay.
        await expect(page.getByText(SLACK_URL)).toHaveCount(0)
    })

    test('adds a Telegram target from its own pair of fields', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)

        await chooseKind(dialog, 'Telegram')
        await fillStable(dialog.getByLabel('Bot token'), '123456:AAFqB-e2e-fixture-token')
        await fillStable(dialog.getByLabel('Chat ID'), '-1001234567890')
        await dialog.getByRole('button', { name: 'Add target' }).click()

        await expect(dialog).toBeHidden()
        await expect(visible(page, /telegram\(/)).toBeVisible()
    })

    test('adds a generic webhook and remembers its payload format', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)

        await chooseKind(dialog, 'Generic webhook')
        await fillStable(dialog.getByLabel('Webhook URL'), WEBHOOK_URL)
        await dialog.getByRole('button', { name: 'Payload format' }).click()
        await page.getByRole('option', { name: 'Plain-text advisory' }).click()
        await dialog.getByRole('button', { name: 'Add target' }).click()

        await expect(dialog).toBeHidden()
        await expect(visible(page, /webhook\(/)).toBeVisible()
    })

    test('will not submit without the credential its kind requires', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)

        await dialog.getByRole('button', { name: 'Add target' }).click()

        // Native `required` blocks it before any handler runs, so the dialog simply stays open.
        await expect(dialog).toBeVisible()
        await expect(dialog.getByLabel('Slack incoming webhook URL')).toHaveJSProperty('validity.valid', false)
    })

    test('closes on Cancel without creating anything', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)

        await dialog.getByRole('button', { name: 'Cancel' }).click()

        await expect(dialog).toBeHidden()
        await expect(page.getByText('No notification targets')).toBeVisible()
    })
})

test.describe('the severity filter', function () {
    test('defaults to critical and high, and each pill toggles', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)

        // SeverityPill renders the severity word, so these buttons have both aria-pressed and a name.
        await expect(dialog.getByRole('button', { name: 'critical' })).toHaveAttribute('aria-pressed', 'true')
        await expect(dialog.getByRole('button', { name: 'high' })).toHaveAttribute('aria-pressed', 'true')
        await expect(dialog.getByRole('button', { name: 'low' })).toHaveAttribute('aria-pressed', 'false')

        await dialog.getByRole('button', { name: 'low' }).click()
        await expect(dialog.getByRole('button', { name: 'low' })).toHaveAttribute('aria-pressed', 'true')
    })

    test('a chosen set survives into the table', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)

        await fillStable(dialog.getByLabel('Slack incoming webhook URL'), SLACK_URL)
        await dialog.getByRole('button', { name: 'high' }).click()
        await expect(dialog.getByRole('button', { name: 'high' })).toHaveAttribute('aria-pressed', 'false')
        await dialog.getByRole('button', { name: 'Add target' }).click()
        await expect(dialog).toBeHidden()

        await page.reload()
        await expect(visible(page, 'critical')).toBeVisible()
    })
})

test.describe('the environment filter', function () {
    // A radiogroup since the ARIA fix; before that "selected" was a border colour and nothing more.
    test('exposes three mutually exclusive options with Both chosen by default', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)

        const group = dialog.getByRole('radiogroup', { name: 'Environment' })
        await expect(group.getByRole('radio')).toHaveCount(3)
        await expect(group.getByRole('radio', { name: /Both/ })).toHaveAttribute('aria-checked', 'true')

        await group.getByRole('radio', { name: /Production only/ }).click()
        await expect(group.getByRole('radio', { name: /Production only/ })).toHaveAttribute('aria-checked', 'true')
        await expect(group.getByRole('radio', { name: /Both/ })).toHaveAttribute('aria-checked', 'false')
    })
})

test.describe('scoping a target', function () {
    test('defaults to every root', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)

        await expect(dialog.getByRole('radio', { name: 'All roots' })).toBeChecked()
    })

    test('refuses an empty explicit selection rather than silently meaning all', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)
        await fillStable(dialog.getByLabel('Slack incoming webhook URL'), SLACK_URL)

        await dialog.getByRole('radio', { name: 'Specific roots or projects' }).check()

        // The distinction matters: "selected, nothing ticked" would otherwise be indistinguishable from
        // "all", and an operator would believe they had narrowed a target that still fires for
        // everything.
        await expect(dialog.getByText('Pick at least one root or project, or switch to All.')).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Add target' })).toBeDisabled()
    })

    test('accepts a root once one is ticked and shows the count', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)
        await fillStable(dialog.getByLabel('Slack incoming webhook URL'), SLACK_URL)

        await dialog.getByRole('radio', { name: 'Specific roots or projects' }).check()
        await dialog.getByRole('checkbox', { name: SEEDED.rootLabel }).check()
        await expect(dialog.getByRole('button', { name: 'Add target' })).toBeEnabled()
        await dialog.getByRole('button', { name: 'Add target' }).click()

        await expect(dialog).toBeHidden()
        await expect(visible(page, '1 selected')).toBeVisible()
    })

    test('refuses an empty source selection for the same reason', async function ({ page }) {
        await page.goto('/settings/notifications')
        const dialog = await openAddTarget(page)
        await fillStable(dialog.getByLabel('Slack incoming webhook URL'), SLACK_URL)

        await dialog.getByRole('radio', { name: 'Selected sources' }).check()

        await expect(dialog.getByText('Pick at least one cell, or choose “All sources”.')).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Add target' })).toBeDisabled()
    })
})

test.describe('an existing target', function () {
    test('can be disabled and re-enabled from the row', async function ({ page }) {
        await page.goto('/settings/notifications')
        await addSlackTarget(page)

        const toggle = visibleRole(page, 'button', 'On')
        await expect(toggle).toHaveAttribute('aria-pressed', 'true')
        await toggle.click()

        await expect(visibleRole(page, 'button', 'Off')).toHaveAttribute('aria-pressed', 'false')
        await page.reload()
        await expect(visibleRole(page, 'button', 'Off')).toHaveAttribute('aria-pressed', 'false')
    })

    test('can be edited without re-entering its credential', async function ({ page }) {
        await page.goto('/settings/notifications')
        await addSlackTarget(page)

        await visibleRole(page, 'button', 'Edit target').click()

        // Credentials are immutable on edit by design — an operator adjusting a severity filter should
        // not have to paste a webhook URL back in, and the form must not offer to overwrite it blank.
        await expect(page.getByLabel('Slack incoming webhook URL')).toHaveCount(0)
        await expect(visibleRole(page, 'button', 'Save changes')).toBeVisible()
    })

    test('can be duplicated, carrying its credential across', async function ({ page }) {
        await page.goto('/settings/notifications')
        await addSlackTarget(page)
        await expect(page.getByRole('button', { name: 'Duplicate target' })).toHaveCount(1)

        await visibleRole(page, 'button', 'Duplicate target').click()

        await expect(page.getByRole('button', { name: 'Duplicate target' })).toHaveCount(2)
        await page.reload()
        // Both rows carry the same masked identity, which is the point of the control: the copy exists
        // so an operator can vary filters or scope WITHOUT pasting the webhook URL again.
        await expect(page.getByRole('button', { name: 'Duplicate target' })).toHaveCount(2)
        // Visible-filtered: the page renders a card list and a table with the same content, so the raw
        // count is two per row rather than one.
        await expect(page.getByText(/slack\(/).filter({ visible: true })).toHaveCount(2)
    })

    test('queues its backfill and says how much', async function ({ page }) {
        await page.goto('/settings/notifications')
        await addSlackTarget(page)

        await visibleRole(page, 'button', 'Send historical events to this target').click()

        // Honest about being asynchronous: the button queues rows, the worker dispatches them later.
        await expect(page.getByText(/Queued .* for backfill\. The worker will dispatch on its next tick\./))
            .toBeVisible()
    })
})

test.describe('removing a target', function () {
    test('asks first and names what will stop being sent', async function ({ page }) {
        await page.goto('/settings/notifications')
        await addSlackTarget(page)

        await visibleRole(page, 'button', 'Remove target').click()

        const confirm = page.getByRole('dialog', { name: 'Remove notification target?' })
        await expect(confirm).toBeVisible()
        await expect(confirm).toContainText('no further events will be sent to this target')
    })

    test('cancelling keeps it', async function ({ page }) {
        await page.goto('/settings/notifications')
        await addSlackTarget(page)

        await visibleRole(page, 'button', 'Remove target').click()
        await page.getByRole('dialog', { name: 'Remove notification target?' })
            .getByRole('button', { name: 'Cancel' })
            .click()

        await page.reload()
        await expect(visible(page, /slack\(/)).toBeVisible()
    })

    test('confirming returns the page to its empty state', async function ({ page }) {
        await page.goto('/settings/notifications')
        await addSlackTarget(page)

        await visibleRole(page, 'button', 'Remove target').click()
        await page.getByRole('dialog', { name: 'Remove notification target?' })
            .getByRole('button', { name: 'Remove target' })
            .click()

        await expect(page.getByText('No notification targets')).toBeVisible()
    })
})
