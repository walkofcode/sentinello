import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Sentinello SQLite schema. Two-process architecture (apps/web + apps/worker) coordinates exclusively
// through this DB in WAL mode; this file is the literal contract between both apps.

export const roots = sqliteTable('roots', {
    id: text('id').primaryKey(),
    path: text('path').notNull().unique(),
    label: text('label'),
    createdAt: integer('created_at').notNull()
})

export const projects = sqliteTable(
    'projects',
    {
        id: text('id').primaryKey(),
        rootId: text('root_id')
            .notNull()
            .references(function ref() {
                return roots.id
            }),
        relPath: text('rel_path').notNull(),
        name: text('name').notNull(),
        // User-supplied display label that overrides `name` in the UI. Never set by the worker —
        // `upsertProject`'s onConflictDoUpdate excludes this column so re-discovery preserves the
        // value across sweeps.
        alias: text('alias'),
        // npm-specific package-manager detail (kept for the JS/npm-audit path). A project spans
        // ecosystems, so the set of detected ecosystems is recorded separately in ecosystemsJson.
        packageManager: text('package_manager', { enum: ['npm', 'yarn', 'pnpm', 'unknown'] }).notNull(),
        nvmrcVersion: text('nvmrc_version'),
        muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
        tagsJson: text('tags_json').notNull().default('[]'),
        // JSON array of EcosystemId values detected in this project's directory (one project, many
        // ecosystems). Empty until a polyglot-aware discovery sweep populates it; the npm path doesn't
        // depend on it, so existing rows default to '[]'.
        ecosystemsJson: text('ecosystems_json').notNull().default('[]'),
        createdAt: integer('created_at').notNull(),
        updatedAt: integer('updated_at').notNull()
    },
    function projectsIndexes(table) {
        return {
            rootIdIdx: index('projects_root_id_idx').on(table.rootId)
        }
    }
)

export const scans = sqliteTable(
    'scans',
    {
        id: text('id').primaryKey(),
        projectId: text('project_id')
            .notNull()
            .references(function ref() {
                return projects.id
            }),
        startedAt: integer('started_at').notNull(),
        finishedAt: integer('finished_at').notNull(),
        // `scanner` = scanner plugin name (merge scoping). `source` = persisted source identity (SourceId;
        // === scanner for today's sources, nullable only for pre-migration rows, backfilled = scanner).
        // `ecosystem` = the EcosystemId this scan ran against; existing rows default to 'npm'.
        scanner: text('scanner').notNull(),
        source: text('source'),
        ecosystem: text('ecosystem').notNull().default('npm'),
        status: text('status', { enum: ['ok', 'unauditable', 'error', 'timeout'] }).notNull(),
        // Structured failure category, nullable for historical rows (before this column existed).
        // New scans always set this — see packages/core/src/types.ts ReasonCode.
        reasonCode: text('reason_code', {
            enum: [
                'ok',
                'no_lockfile',
                'unknown_pm',
                'yarn_v1_unsupported',
                'pm_missing',
                'nvm_missing',
                'node_below_min',
                'npm_below_min',
                'pnpm_below_min',
                'audit_spawn_error',
                'audit_parse_error',
                'audit_schema_mismatch',
                'audit_empty_output',
                'audit_no_advisories',
                'legacy_npm6_format',
                'nvm_node_missing',
                'nvm_install_failed',
                'bash_missing',
                'audit_unknown_failure',
                'osv_db_not_seeded',
                'osv_db_unavailable',
                'gemnasium_db_not_seeded',
                'gemnasium_db_unavailable',
                'partial_dependency_graph',
                'ambiguous_dependency_spec',
                'unsupported_lockfile',
                'ecosystem_source_disabled',
                'timeout'
            ]
        }),
        durationMs: integer('duration_ms').notNull(),
        errorText: text('error_text'),
        rawJson: text('raw_json').notNull()
    },
    function scansIndexes(table) {
        return {
            projectIdIdx: index('scans_project_id_idx').on(table.projectId),
            finishedAtIdx: index('scans_finished_at_idx').on(table.finishedAt)
        }
    }
)

// Lifecycle model: each row is an *episode* of exposure for an (project, scanner, advisoryId,
// packageName) tuple. A successful scan inserts a new episode on first detection, refreshes
// last_seen_at on continuing episodes, and closes an episode by setting resolved_at when the
// finding disappears. If a fixed advisory reappears later, a NEW episode row is inserted so the
// history of fixes is preserved (regression as a fresh episode). scan_id keeps its original
// meaning: the scan that first detected this episode.
export const findings = sqliteTable(
    'findings',
    {
        id: text('id').primaryKey(),
        // First scan that detected this episode. Never overwritten on continuing scans.
        scanId: text('scan_id')
            .notNull()
            .references(function ref() {
                return scans.id
            }),
        projectId: text('project_id')
            .notNull()
            .references(function ref() {
                return projects.id
            }),
        // `scanner` = scanner plugin name (used for per-scanner merge scoping + provenance display).
        // `source` = persisted source identity (SourceId; === scanner for today's sources, nullable only
        // for pre-migration rows, backfilled = scanner). `ecosystem` = the package's EcosystemId; the
        // identity tuple is (projectId, source, ecosystem, advisoryId, packageName). Existing rows default
        // ecosystem to 'npm'.
        scanner: text('scanner').notNull(),
        source: text('source'),
        ecosystem: text('ecosystem').notNull().default('npm'),
        advisoryId: text('advisory_id').notNull(),
        advisoryTitle: text('advisory_title'),
        advisoryUrl: text('advisory_url'),
        packageName: text('package_name').notNull(),
        installedVersion: text('installed_version').notNull(),
        vulnerableRange: text('vulnerable_range').notNull(),
        severity: text('severity', {
            enum: ['critical', 'high', 'moderate', 'low', 'info']
        }).notNull(),
        fixAvailable: integer('fix_available', { mode: 'boolean' }).notNull().default(false),
        fixVersion: text('fix_version'),
        depPathJson: text('dep_path_json').notNull().default('[]'),
        // Dependency-graph classification: a transitive can be reachable from both a prod and a
        // dev direct dep, so we store both flags independently. Defaults keep pre-migration rows
        // visible under the production-only default view until the next scan refreshes them.
        isProd: integer('is_prod', { mode: 'boolean' }).notNull().default(true),
        isDev: integer('is_dev', { mode: 'boolean' }).notNull().default(false),
        // Epoch ms when this episode was first observed. Nullable in DB to allow migration
        // backfill (populated from the originating scan's finished_at on first boot post-migration);
        // populated for every new row by the worker, so treat as required in code.
        firstDetectedAt: integer('first_detected_at'),
        // Epoch ms of the most recent 'ok' scan that still reported this finding. Same backfill /
        // not-null-by-invariant rule as first_detected_at.
        lastSeenAt: integer('last_seen_at'),
        // Epoch ms of the 'ok' scan that first observed this finding gone. NULL means still open.
        resolvedAt: integer('resolved_at'),
        // FK to scans.id for the resolving scan. NULL while resolved_at is NULL.
        resolvedScanId: text('resolved_scan_id').references(function ref() {
            return scans.id
        })
    },
    function findingsIndexes(table) {
        return {
            scanIdIdx: index('findings_scan_id_idx').on(table.scanId),
            projectIdIdx: index('findings_project_id_idx').on(table.projectId),
            packageNameIdx: index('findings_package_name_idx').on(table.packageName),
            // Identity index aligns with the persisted finding-identity tuple
            // (projectId, source, ecosystem, advisoryId, packageName). It indexes `source` — the
            // persisted source identity — NOT `scanner` (the plugin/provenance name). `source` is
            // nullable only in the brief pre-backfill window; the boot backfill sets source = scanner
            // for legacy rows and the worker always stamps it on new rows.
            identityIdx: index('findings_identity_idx').on(
                table.projectId,
                table.source,
                table.ecosystem,
                table.advisoryId,
                table.packageName
            ),
            resolvedAtIdx: index('findings_resolved_at_idx').on(table.resolvedAt)
            // No DB-level "one open episode per identity" uniqueness: the pre-lifecycle snapshot
            // model allowed multiple rows for the same identity (one per dep path), and we don't
            // want the migration to fail on existing duplicates. mergeFindingsForScan enforces the
            // "single open episode" invariant in code; the per-project lock + single-instance
            // worker lockfile make concurrent writes impossible.
        }
    }
)

export const mutes = sqliteTable(
    'mutes',
    {
        id: text('id').primaryKey(),
        scope: text('scope', { enum: ['project', 'finding'] }).notNull(),
        // nullable for "global finding mute" (scope=finding, project_id=null)
        projectId: text('project_id').references(function ref() {
            return projects.id
        }),
        // required for scope=finding (matches identity tuple); null for scope=project (applies across all scanners)
        scanner: text('scanner'),
        // EcosystemId for scope=finding (part of the identity tuple so an npm mute never silences a
        // PyPI package of the same name); null for scope=project. Existing finding-scope rows default 'npm'.
        ecosystem: text('ecosystem'),
        advisoryId: text('advisory_id'),
        packageName: text('package_name'),
        reason: text('reason').notNull(),
        author: text('author').notNull(),
        createdAt: integer('created_at').notNull(),
        expiresAt: integer('expires_at')
    },
    function mutesIndexes(table) {
        return {
            scopeIdx: index('mutes_scope_idx').on(table.scope),
            projectIdIdx: index('mutes_project_id_idx').on(table.projectId),
            identityIdx: index('mutes_identity_idx').on(
                table.projectId,
                table.scanner,
                table.ecosystem,
                table.advisoryId,
                table.packageName
            ),
            expiresAtIdx: index('mutes_expires_at_idx').on(table.expiresAt)
        }
    }
)

export const notificationTargets = sqliteTable(
    'notification_targets',
    {
        id: text('id').primaryKey(),
        kind: text('kind', { enum: ['slack', 'telegram', 'webhook'] }).notNull(),
        configJson: text('config_json').notNull(),
        severityFilterJson: text('severity_filter_json').notNull().default('[]'),
        // Environment scope: 'all' fires for every finding; 'prod' fires only for findings on a prod
        // dependency; 'dev' fires only for findings reachable solely from devDependencies. Mirrors the
        // DepTypeFilter union from @sentinello/core. Constrained at the app layer (SQLite has no enum).
        envFilter: text('env_filter').notNull().default('all'),
        // Per-target (source, ecosystem) cell scope, JSON-encoded NotificationSourceScope. Default
        // '{"mode":"all","cells":[]}' = fire for every cell (the behavior every pre-Phase-5 target had).
        // mode 'selected' restricts dispatch to the listed cells. Parsed/validated at the query layer.
        sourceScopeJson: text('source_scope_json').notNull().default('{"mode":"all","cells":[]}'),
        enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
        createdAt: integer('created_at').notNull()
    },
    function notificationTargetsIndexes(table) {
        return {
            enabledIdx: index('notification_targets_enabled_idx').on(table.enabled)
        }
    }
)

// Per-target root scope. Zero rows for a target = "all roots" (the default for legacy targets and
// for newly created targets that don't narrow scope). One or more rows = explicit allow-list:
// dispatch only fires the target for events whose project belongs to one of the listed roots.
// Membership is wiped when either the target or the root is deleted. With foreign_keys = ON the
// default FK action (NO ACTION) would BLOCK the parent delete; we want CASCADE semantics here
// because scope rows have no meaning without their parent. We do that at the query layer
// (deleteNotificationTarget child-first) rather than via ON DELETE CASCADE so the cascade is
// visible in code and easy to grep — different from notification_deliveries below, which uses
// ON DELETE SET NULL so audit rows survive a target delete.
export const notificationTargetRoots = sqliteTable(
    'notification_target_roots',
    {
        targetId: text('target_id')
            .notNull()
            .references(function ref() {
                return notificationTargets.id
            }),
        rootId: text('root_id')
            .notNull()
            .references(function ref() {
                return roots.id
            })
    },
    function notificationTargetRootsIndexes(table) {
        return {
            pairIdx: uniqueIndex('notification_target_roots_pair_uidx').on(table.targetId, table.rootId),
            targetIdx: index('notification_target_roots_target_id_idx').on(table.targetId),
            rootIdx: index('notification_target_roots_root_id_idx').on(table.rootId)
        }
    }
)

// Per-target project scope, parallel to notification_target_roots. Zero rows in BOTH this table and
// notification_target_roots = "everything" (the default). When either table has rows, the target is
// scoped to an additive allow-list: dispatch fires for an event whose project belongs to a listed
// root OR whose project id is listed here. Same query-layer child-first cascade as the roots table.
export const notificationTargetProjects = sqliteTable(
    'notification_target_projects',
    {
        targetId: text('target_id')
            .notNull()
            .references(function ref() {
                return notificationTargets.id
            }),
        projectId: text('project_id')
            .notNull()
            .references(function ref() {
                return projects.id
            })
    },
    function notificationTargetProjectsIndexes(table) {
        return {
            pairIdx: uniqueIndex('notification_target_projects_pair_uidx').on(table.targetId, table.projectId),
            targetIdx: index('notification_target_projects_target_id_idx').on(table.targetId),
            projectIdx: index('notification_target_projects_project_id_idx').on(table.projectId)
        }
    }
)

export const scanRequests = sqliteTable(
    'scan_requests',
    {
        id: text('id').primaryKey(),
        // projectId + rootId are mutually exclusive: if projectId is set, scan that one project;
        // if rootId is set, walk just that root and scan its projects; if both are null, full sweep.
        projectId: text('project_id').references(function ref() {
            return projects.id
        }),
        rootId: text('root_id').references(function ref() {
            return roots.id
        }),
        requestedAt: integer('requested_at').notNull(),
        pickedUpAt: integer('picked_up_at'),
        finishedAt: integer('finished_at'),
        // Liveness signal: the worker pings this every ~5s while a request is in 'running'.
        // A stale heartbeat (older than SCAN_HEARTBEAT_STALE_MS) means the worker crashed mid-scan;
        // the web side treats those rows as not-in-flight, and the worker resets them on startup.
        heartbeatAt: integer('heartbeat_at'),
        status: text('status', { enum: ['pending', 'running', 'done', 'failed'] }).notNull()
    },
    function scanRequestsIndexes(table) {
        return {
            statusRequestedAtIdx: index('scan_requests_status_requested_at_idx').on(
                table.status,
                table.requestedAt
            )
        }
    }
)

export const appConfig = sqliteTable('app_config', {
    key: text('key').primaryKey(),
    valueJson: text('value_json').notNull()
})

// Portal → worker control-plane mailbox, sibling to scan_requests. The web app inserts a row when
// it changes a setting that the worker only reads at boot (today: schedule; tomorrow: watcher flags).
// The scan-request poller drains pending rows on every tick and dispatches by `kind`; reload
// handlers are idempotent, so multiple enqueues collapse harmlessly. Kept deliberately tiny — no
// heartbeat, no payload — because dispatch reads the authoritative state (app_config) itself rather
// than trusting anything inline on the signal.
export const workerSignals = sqliteTable(
    'worker_signals',
    {
        id: text('id').primaryKey(),
        kind: text('kind').notNull(),
        enqueuedAt: integer('enqueued_at').notNull(),
        claimedAt: integer('claimed_at')
    },
    function workerSignalsIndexes(table) {
        return {
            claimedAtIdx: index('worker_signals_claimed_at_idx').on(table.claimedAt)
        }
    }
)

// The discovery / notification ledger. Source of truth for "have we already told the user about this?"
export const notificationEvents = sqliteTable(
    'notification_events',
    {
        id: text('id').primaryKey(),
        eventType: text('event_type', { enum: ['finding', 'scan_failure'] }).notNull(),
        identityKey: text('identity_key').notNull(),
        projectId: text('project_id')
            .notNull()
            .references(function ref() {
                return projects.id
            }),
        scanner: text('scanner').notNull(),
        // EcosystemId for finding events (part of the dedupe identity); null for scan_failure events.
        // Existing finding rows default 'npm'. The hashed identity_key is recomputed for legacy finding
        // rows by a boot backfill so it includes ecosystem (the hash changed shape when ecosystem joined
        // the tuple — a column backfill alone would diverge the stored key from freshly-computed ones).
        ecosystem: text('ecosystem'),
        advisoryId: text('advisory_id'),
        packageName: text('package_name'),
        // Denormalized for finding events so selectDispatchablePairs() can filter by target.severity_filter
        // in SQL without joining back to historical findings rows. Null for scan_failure events.
        severity: text('severity', { enum: ['critical', 'high', 'moderate', 'low', 'info'] }),
        failureSignature: text('failure_signature'),
        firstScanId: text('first_scan_id')
            .notNull()
            .references(function ref() {
                return scans.id
            }),
        firstSeenAt: integer('first_seen_at').notNull(),
        // Denormalized UI/legacy convenience: timestamp of first successful delivery to ANY target.
        // Dispatch logic NEVER reads this — it reads notification_deliveries.
        firstNotifiedAt: integer('first_notified_at'),
        lastSeenAt: integer('last_seen_at').notNull()
    },
    function notificationEventsIndexes(table) {
        return {
            identityKeyIdx: uniqueIndex('notification_events_identity_key_uidx').on(table.identityKey),
            projectEventTypeIdx: index('notification_events_project_event_type_idx').on(
                table.projectId,
                table.eventType
            )
        }
    }
)

// Journal of mutes that were auto-lifted by the mute-expiry sweep. Pure audit trail —
// the UI surfaces "this mute was auto-lifted" on project detail; dispatch never reads this.
export const muteLifts = sqliteTable(
    'mute_lifts',
    {
        id: text('id').primaryKey(),
        muteId: text('mute_id').notNull(),
        liftedAt: integer('lifted_at').notNull(),
        scope: text('scope', { enum: ['project', 'finding'] }).notNull(),
        projectId: text('project_id'),
        scanner: text('scanner'),
        // EcosystemId mirror of the lifted mute's identity (null for project-scope). Backfilled 'npm' for
        // existing finding-scope audit rows so their identity aligns with the re-keyed findings.
        ecosystem: text('ecosystem'),
        advisoryId: text('advisory_id'),
        packageName: text('package_name'),
        reason: text('reason').notNull(),
        author: text('author').notNull()
    },
    function muteLiftsIndexes(table) {
        return {
            projectIdx: index('mute_lifts_project_id_idx').on(table.projectId),
            liftedAtIdx: index('mute_lifts_lifted_at_idx').on(table.liftedAt)
        }
    }
)

// Per-(event, target) dispatch state. One row per pair. Makes "Slack succeeded, Telegram failed" tractable.
//
// target_id is nullable + ON DELETE SET NULL: when an operator deletes a notification target we keep
// the delivery row as a long-lived audit trail ("this event was sent at T to a target that has since
// been removed") and merely null out the link to the now-gone parent. Every reader filters with
// `WHERE target_id = '<concrete-id>'`, which SQL-naturally drops the orphan NULL rows, so dispatch
// / backfill / lookups are unaffected. The pair_uidx UNIQUE (event_id, target_id) still holds —
// SQLite treats NULLs as distinct in unique indexes, so multiple events with target_id = NULL coexist.
export const notificationDeliveries = sqliteTable(
    'notification_deliveries',
    {
        id: text('id').primaryKey(),
        eventId: text('event_id')
            .notNull()
            .references(function ref() {
                return notificationEvents.id
            }),
        targetId: text('target_id')
            .references(function ref() {
                return notificationTargets.id
            }, { onDelete: 'set null' }),
        firstAttemptedAt: integer('first_attempted_at'),
        // Canonical "delivered to this target" timestamp. Never cleared after set.
        firstSucceededAt: integer('first_succeeded_at'),
        lastAttemptedAt: integer('last_attempted_at'),
        // Redacted via packages/notifications/src/redact.ts before storage. Cleared on next success.
        lastErrorText: text('last_error_text')
    },
    function notificationDeliveriesIndexes(table) {
        return {
            pairIdx: uniqueIndex('notification_deliveries_pair_uidx').on(table.eventId, table.targetId),
            eventIdx: index('notification_deliveries_event_id_idx').on(table.eventId),
            targetIdx: index('notification_deliveries_target_id_idx').on(table.targetId)
        }
    }
)
