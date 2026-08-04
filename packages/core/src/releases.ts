import { type Locale } from './types'

export type ReleaseEntry = {
    version: string
    date: string
}

export type ReleaseCopy = {
    title: string
    items: string[]
}

function stripVPrefix(value: string): string {
    return (value.startsWith('v') && value.slice(1)) || value
}

// Newest first. The locale-independent version index. Adding a release = one entry here plus a
// RELEASE_COPY entry in every locale below. See CLAUDE.md for the release-please version-sync flow.
export const RELEASES: ReleaseEntry[] = [
    { version: '3.0.0', date: '2026-08-03' },
    { version: '2.6.0', date: '2026-07-29' },
    { version: '2.5.0', date: '2026-07-28' },
    { version: '2.4.3', date: '2026-07-26' },
    { version: '2.4.2', date: '2026-07-25' },
    { version: '2.4.1', date: '2026-07-25' },
    { version: '2.4.0', date: '2026-07-25' },
    { version: '2.3.0', date: '2026-06-09' },
    { version: '2.2.0', date: '2026-06-09' },
    { version: '2.1.0', date: '2026-06-06' },
    { version: '2.0.1', date: '2026-06-04' },
    { version: '2.0.0', date: '2026-06-04' },
    { version: '1.4.0', date: '2026-05-29' },
    { version: '1.3.1', date: '2026-05-28' },
    { version: '1.3.0', date: '2026-05-28' },
    { version: '1.2.0', date: '2026-05-24' },
    { version: '1.1.2', date: '2026-05-24' },
    { version: '1.1.0', date: '2026-05-23' },
    { version: '1.0.1', date: '2026-05-23' },
    { version: '1.0.0', date: '2026-05-23' }
]

// Localized highlights, keyed by locale then version. Dots in the version keys are fine here —
// this is plain TS data, not a next-intl message key (next-intl forbids '.' in keys).
export const RELEASE_COPY: Record<Locale, Record<string, ReleaseCopy>> = {
    en: {
        '3.0.0': {
            title: 'Sentinello now runs without a portal at all',
            items: [
                'The scanners ship as a CLI on npm. `npx sentinello` walks a folder, finds every project underneath, checks them against npm audit, OSV and GitLab gemnasium, and writes a markdown advisory with a remediation prompt attached — no install, no account, no database, and nothing about your code leaves the machine',
                'Piped, the advisory is the only thing on stdout, so `npx sentinello | claude -p "$(cat -)"` hands an agent a complete work list without anything corrupting the document',
                'A first run no longer loses the gemnasium source to a refused download. GitLab declines its archive for a minute or two at a time, and the old retry gave up after thirteen seconds; the CLI now waits it out, says why it is waiting, and takes `--feed-wait` if the default of three minutes is wrong for you',
                'Both download estimates were measured rather than guessed: the OSV npm export is quoted at 204 MB rather than 196, and the gemnasium archive at 52 MB rather than 80. The consent prompt marks an estimate with a tilde so it is never mistaken for a size the server reported',
                'A value that looks like a flag is now rejected instead of taken literally — `--out --` used to write an advisory to a file named `--` inside your project and report success',
                'The What’s new panel no longer runs off the bottom of the window when a release has a lot to say'
            ]
        },
        '2.6.0': {
            title: 'The advisory document actually arrives — and counts what you mean',
            items: [
                'get_project_advisory now returns the advisory document itself. Connected clients previously received only its metadata — a filename and a count — and never the document, despite the tool describing it as a complete work list',
                'The advisory export now holds one entry per distinct advisory with its sources merged, instead of one per scanner row: a vulnerability that npm audit and OSV both report is a single work item carrying both advisory IDs, not two near-identical ones. This applies to the portal’s Download .md as well, and the count now matches the dashboard',
                'A project too large to fit in one MCP response is now paginated — the document states that it is incomplete and gives the exact follow-up call to fetch the rest, instead of being silently cut off where an agent would read the remainder as clean',
                'Every input on every MCP tool now carries a description, and a new list_mutes tool exposes the mute IDs that unmute needs — previously obtainable only by creating the mute in the same session',
                'Fixed a gap in the severity counts: a finding whose severity was not one of the five known values was counted as a finding but placed in no severity bucket, so a project whose only finding had one appeared completely clean'
            ]
        },
        '2.5.0': {
            title: 'The advisory export, straight over MCP',
            items: [
                'Connected MCP clients can pull a project’s full Markdown advisory with the new get_project_advisory tool — the same document as the portal’s Download .md, without copying it out of the browser',
                'Muted findings are now excluded from the project advisory export, so an agent is never handed work whose risk you have already accepted',
                'Note: because the advisory contains your export prompt, an MCP client can now read whatever you have written in Settings → Export'
            ]
        },
        '2.4.3': {
            title: 'Unclipped popups, stricter export prompt',
            items: [
                'Dropdowns, the dependency-path popover, and the advisory export menu no longer get clipped by the table or dialog they sit in — they render above the page and flip above the trigger when there is no room below',
                'The default advisory-export prompt now asks the agent to plan before editing anything, group findings that share a single fix, and spell out the code impact of each version bump — and it targets zero findings while ruling out the shortcuts to a fake zero: muting, widening ranges, or narrowing the scan, with anything genuinely unfixable listed in a dated residual table'
            ]
        },
        '2.4.2': {
            title: 'Branch in its own column',
            items: [
                'The git branch a project was scanned on now has a column of its own in the project list — plain text, no icon — instead of sitting under the project name'
            ]
        },
        '2.4.1': {
            title: 'Clean shutdowns',
            items: [
                'Restarting the container no longer kills a scan that is midway through writing, and the worker now starts immediately instead of retrying for ~30 seconds first',
                'Set stop_grace_period: 60s (or --stop-timeout 60) in your compose file to give it room — the README and Docker docs now cover this'
            ]
        },
        '2.4.0': {
            title: 'Polyglot scanning — Python, Go, and Rust join npm',
            items: [
                'Sentinello now scans Python, Go, and Rust projects alongside npm — lockfiles are resolved entirely offline, and every project reports its scan coverage (full, partial, or unauditable) so gaps are visible instead of silent',
                'GitLab’s gemnasium database joins npm audit and OSV as an offline advisory source, deduplicated against the others by CVE/GHSA alias; Settings → Sources is now a Languages × Sources matrix with per-cell notification scope, and npm audit itself can be turned off as long as one source stays active',
                'Findings now record the git branch they came from, shown in the project list, the project header, and every notification',
                'Project rows carry their own actions — scan now, copy or download the advisory, mute or unmute, and edit tags — so a triage pass no longer needs a trip into each project',
                'The projects dashboard went from ~3.3s to ~0.03s, and navigation now shows loading states instead of appearing frozen',
                'Security: 25 dependency advisories cleared, including libvips CVEs that were live in the portal’s image optimizer and nine Next.js advisories affecting the shipped portal',
                'The default advisory-export prompt now covers minimum release age, lockfile verification, and stale overrides'
            ]
        },
        '2.3.0': {
            title: 'Simpler MCP setup — no environment variables',
            items: [
                'Set up MCP entirely in Settings → MCP: generate a token to turn the /api/mcp endpoint on, clear it to turn it off — the SENTINELLO_MCP_ENABLED and SENTINELLO_MCP_API_TOKEN environment variables are gone (an existing env token is imported once on upgrade)',
                'Ready-to-paste connection snippets for Claude Code, Codex, Cursor, and Claude Desktop, pre-filled with your token',
                'When SENTINELLO_PORTAL_BASE_URL is set in the environment it’s shown read-only in Settings → Advanced, since it stays authoritative and is re-applied on every boot'
            ]
        },
        '2.2.0': {
            title: 'Fewer false alarms and self-cleaning findings',
            items: [
                'Malware advisories now match the exact compromised version — a clean or already-remediated version of a once-compromised package is no longer flagged',
                'Duplicate findings now resolve themselves on the next scan, so old or stranded entries clear out automatically',
                'Production and development labels are now computed one consistent way across every source (npm and OSV)'
            ]
        },
        '2.1.0': {
            title: 'A cleaner project header and consistent filters',
            items: [
                'Streamlined the project header — rename inline beside the title, with mute and tags as one-tap icons',
                'Filter findings by source (npm / OSV) from a new dropdown beside the dependency-type filter',
                'Unified, consistent dropdowns across the app, with type-to-search on long lists like time zones'
            ]
        },
        '2.0.1': {
            title: 'Clearer upgrade guidance',
            items: [
                'Expanded upgrade steps for the 2.0 breaking changes',
                'README notes the localhost-only port binding'
            ]
        },
        '2.0.0': {
            title: 'Multi-source scanning and a hardened, secure-by-default install',
            items: [
                'OSV as an opt-in second source (Settings → Sources, off by default) with malicious-package detection, matched against the public OSV database in a local cache',
                'Findings now merge across sources — one row per vulnerability, every source tagged, the best available fix, and the union of dependency paths, with a source filter and a dependency-path popover',
                'Security hardening: the MCP endpoint is off by default and requires a token, webhook delivery is guarded against SSRF, an optional portal login gate, and the container runs as an unprivileged user',
                'Settings is now a top-level section with a sidebar and a Profile page'
            ]
        },
        '1.4.0': {
            title: 'MCP integration & what’s-new',
            items: [
                'MCP server at /api/mcp for Claude Desktop, Cursor, and other clients',
                'New Settings → MCP section with server URL and token management',
                'What’s-new pill plus a Release notes history'
            ]
        },
        '1.3.1': { title: 'Footer version fix', items: ['The running version renders cleanly in the footer'] },
        '1.3.0': {
            title: 'Notification improvements',
            items: [
                'Filter notifications by environment',
                'Simpler notification-target edit form',
                'Duplicate an existing notification target'
            ]
        },
        '1.2.0': {
            title: 'Projects and Libraries pages',
            items: ['The home view is split into dedicated Projects and Libraries pages']
        },
        '1.1.2': {
            title: 'Live schedule reload',
            items: ['The worker reloads the scan schedule the moment you save changes in the portal']
        },
        '1.1.0': {
            title: 'Safer deletes & a clearer update banner',
            items: [
                'Confirmation prompts before deleting roots and notification targets',
                'Update notice moved to a dismissible top banner',
                'Worker prunes stale roots when a host mount disappears'
            ]
        },
        '1.0.1': {
            title: 'Scanner accuracy fixes',
            items: [
                'Drop audit findings whose installed version isn’t actually in the vulnerable range',
                'Allow deleting a notification target that has delivery history'
            ]
        },
        '1.0.0': { title: 'Initial open-source release', items: ['The first public release of Sentinello'] }
    },
    es: {
        '3.0.0': {
            title: 'Sentinello ya funciona sin portal alguno',
            items: [
                'Los escáneres se distribuyen como CLI en npm. `npx sentinello` recorre una carpeta, encuentra todos los proyectos que contiene, los contrasta con npm audit, OSV y GitLab gemnasium, y escribe un informe markdown con un prompt de remediación adjunto: sin instalación, sin cuenta, sin base de datos y sin que nada de tu código salga de la máquina',
                'Canalizado, el informe es lo único que sale por stdout, así que `npx sentinello | claude -p "$(cat -)"` entrega a un agente una lista de trabajo completa sin que nada corrompa el documento',
                'Una primera ejecución ya no pierde la fuente gemnasium por una descarga rechazada. GitLab rechaza su archivo durante uno o dos minutos seguidos, y el reintento anterior se rendía a los trece segundos; ahora la CLI espera a que pase, explica por qué espera y acepta `--feed-wait` si los tres minutos por defecto no te sirven',
                'Ambas estimaciones de descarga se midieron en lugar de suponerse: la exportación npm de OSV se indica como 204 MB en vez de 196, y el archivo de gemnasium como 52 MB en vez de 80. El aviso de consentimiento marca las estimaciones con una tilde para que nunca se confundan con un tamaño informado por el servidor',
                'Un valor con aspecto de opción ahora se rechaza en lugar de tomarse literalmente: `--out --` escribía un informe en un archivo llamado `--` dentro de tu proyecto e informaba de éxito',
                'El panel de Novedades ya no se sale por la parte inferior de la ventana cuando una versión tiene mucho que contar'
            ]
        },
        '2.6.0': {
            title: 'El documento de vulnerabilidades por fin llega — y cuenta lo que debe',
            items: [
                'get_project_advisory ahora devuelve el documento en sí. Hasta ahora los clientes conectados solo recibían sus metadatos —un nombre de archivo y un recuento— y nunca el documento, pese a que la herramienta lo describía como una lista de trabajo completa',
                'El informe de vulnerabilidades incluye ahora una entrada por cada aviso distinto, con sus fuentes combinadas, en lugar de una por fila de escáner: una vulnerabilidad que reportan npm audit y OSV es un único elemento de trabajo con ambos identificadores, no dos casi idénticos. Esto vale también para el botón Descargar .md del portal, y el recuento ya coincide con el del panel',
                'Un proyecto demasiado grande para caber en una sola respuesta MCP ahora se pagina: el documento indica que está incompleto y da la llamada exacta para obtener el resto, en vez de cortarse en silencio donde un agente leería lo que falta como limpio',
                'Cada parámetro de cada herramienta MCP tiene ahora una descripción, y la nueva herramienta list_mutes expone los identificadores de silenciamiento que necesita unmute — antes solo se conseguían creando el silenciamiento en la misma sesión',
                'Corregido un fallo en los recuentos de severidad: un hallazgo cuya severidad no era uno de los cinco valores conocidos se contaba como hallazgo pero no entraba en ninguna categoría, así que un proyecto cuyo único hallazgo fuera ese aparecía como completamente limpio'
            ]
        },
        '2.5.0': {
            title: 'El informe de vulnerabilidades, directo por MCP',
            items: [
                'Los clientes MCP conectados pueden obtener el informe Markdown completo de un proyecto con la nueva herramienta get_project_advisory: el mismo documento que el botón Descargar .md del portal, sin copiarlo desde el navegador',
                'Los hallazgos silenciados ya no se incluyen en el informe del proyecto, así que a un agente nunca se le encarga trabajo cuyo riesgo ya has aceptado',
                'Nota: como el informe contiene tu prompt de exportación, un cliente MCP ahora puede leer lo que hayas escrito en Ajustes → Exportar'
            ]
        },
        '2.4.3': {
            title: 'Ventanas emergentes sin recortes y un prompt de exportación más estricto',
            items: [
                'Los desplegables, el popover de ruta de dependencias y el menú de exportación de avisos ya no quedan recortados por la tabla o el diálogo que los contiene: se dibujan por encima de la página y se abren hacia arriba cuando no hay espacio debajo',
                'El prompt de exportación de avisos por defecto ahora pide al agente que planifique antes de editar nada, que agrupe los hallazgos que comparten una misma corrección y que detalle el impacto en el código de cada cambio de versión; además fija como objetivo cero hallazgos y descarta los atajos hacia un cero falso —silenciar, ampliar rangos o reducir el alcance del análisis—, dejando lo realmente irresoluble en una tabla de residuos fechada'
            ]
        },
        '2.4.2': {
            title: 'La rama en su propia columna',
            items: [
                'La rama de git en la que se analizó cada proyecto ahora tiene su propia columna en la lista de proyectos —texto simple, sin icono— en lugar de aparecer debajo del nombre del proyecto'
            ]
        },
        '2.4.1': {
            title: 'Apagados limpios',
            items: [
                'Reiniciar el contenedor ya no interrumpe un análisis a mitad de escritura, y el worker arranca de inmediato en lugar de reintentar durante ~30 segundos',
                'Define stop_grace_period: 60s (o --stop-timeout 60) en tu archivo compose para darle margen: el README y la documentación de Docker ya lo explican'
            ]
        },
        '2.4.0': {
            title: 'Análisis políglota: Python, Go y Rust se suman a npm',
            items: [
                'Sentinello ahora analiza proyectos de Python, Go y Rust además de npm: los archivos de bloqueo se resuelven totalmente sin conexión y cada proyecto informa su cobertura de análisis (completa, parcial o no auditable), de modo que las lagunas quedan visibles en lugar de silenciosas',
                'La base de datos gemnasium de GitLab se suma a npm audit y OSV como fuente de avisos sin conexión, deduplicada frente a las demás por alias CVE/GHSA; Configuración → Fuentes es ahora una matriz de Lenguajes × Fuentes con alcance de notificaciones por celda, y npm audit ya se puede desactivar siempre que quede una fuente activa',
                'Los hallazgos ahora registran la rama de git de la que provienen, visible en la lista de proyectos, el encabezado del proyecto y todas las notificaciones',
                'Las filas de proyecto incluyen sus propias acciones: analizar ahora, copiar o descargar el aviso, silenciar o reactivar y editar etiquetas, así una ronda de triaje ya no exige entrar en cada proyecto',
                'El panel de proyectos pasó de ~3,3 s a ~0,03 s, y la navegación ahora muestra estados de carga en lugar de parecer congelada',
                'Seguridad: 25 avisos de dependencias resueltos, incluidos CVE de libvips que estaban activos en el optimizador de imágenes del portal y nueve avisos de Next.js que afectaban al portal distribuido',
                'El prompt de exportación de avisos por defecto ahora cubre la antigüedad mínima de publicación, la verificación del archivo de bloqueo y los overrides obsoletos'
            ]
        },
        '2.3.0': {
            title: 'Configuración de MCP más simple, sin variables de entorno',
            items: [
                'Configura MCP por completo en Configuración → MCP: genera un token para activar el endpoint /api/mcp y bórralo para desactivarlo — las variables de entorno SENTINELLO_MCP_ENABLED y SENTINELLO_MCP_API_TOKEN ya no existen (un token de entorno existente se importa una vez al actualizar)',
                'Fragmentos de conexión listos para pegar para Claude Code, Codex, Cursor y Claude Desktop, con tu token ya incluido',
                'Cuando SENTINELLO_PORTAL_BASE_URL se define en el entorno, se muestra de solo lectura en Configuración → Avanzado, ya que sigue siendo autoritativa y se reaplica en cada arranque'
            ]
        },
        '2.2.0': {
            title: 'Menos falsas alarmas y hallazgos que se limpian solos',
            items: [
                'Los avisos de malware ahora coinciden con la versión comprometida exacta: una versión limpia o ya corregida de un paquete que estuvo comprometido deja de marcarse',
                'Los hallazgos duplicados ahora se resuelven solos en el siguiente análisis, de modo que las entradas antiguas o huérfanas se eliminan automáticamente',
                'Las etiquetas de producción y desarrollo ahora se calculan de una sola forma coherente en todas las fuentes (npm y OSV)'
            ]
        },
        '2.1.0': {
            title: 'Un encabezado de proyecto más limpio y filtros coherentes',
            items: [
                'Encabezado de proyecto simplificado: renombra junto al título, con silenciar y etiquetas como iconos',
                'Filtra los hallazgos por fuente (npm / OSV) desde un nuevo desplegable junto al filtro de tipo de dependencia',
                'Desplegables unificados y coherentes en toda la app, con búsqueda al escribir en listas largas como las zonas horarias'
            ]
        },
        '2.0.1': {
            title: 'Guía de actualización más clara',
            items: [
                'Pasos de actualización ampliados para los cambios incompatibles de 2.0',
                'El README indica el enlace de puerto solo en localhost'
            ]
        },
        '2.0.0': {
            title: 'Análisis multi-fuente y una instalación reforzada y segura por defecto',
            items: [
                'OSV como segunda fuente opcional (Configuración → Fuentes, desactivada por defecto) con detección de paquetes maliciosos, cotejada con la base de datos pública de OSV en una caché local',
                'Los hallazgos ahora se combinan entre fuentes: una fila por vulnerabilidad, con cada fuente etiquetada, la mejor corrección disponible y la unión de las rutas de dependencia, con filtro por fuente y un popover de ruta de dependencia',
                'Refuerzo de seguridad: el endpoint MCP está desactivado por defecto y requiere un token, la entrega de webhooks está protegida contra SSRF, una puerta de inicio de sesión opcional del portal, y el contenedor se ejecuta como usuario sin privilegios',
                'Configuración ahora es una sección de nivel superior con barra lateral y una página de Perfil'
            ]
        },
        '1.4.0': {
            title: 'Integración MCP y novedades',
            items: [
                'Servidor MCP en /api/mcp para Claude Desktop, Cursor y otros clientes',
                'Nueva sección Configuración → MCP con URL del servidor y gestión de tokens',
                'Píldora de novedades e historial de notas de versión'
            ]
        },
        '1.3.1': {
            title: 'Corrección de la versión en el pie',
            items: ['La versión en ejecución se muestra correctamente en el pie de página']
        },
        '1.3.0': {
            title: 'Mejoras en las notificaciones',
            items: [
                'Filtrar notificaciones por entorno',
                'Formulario de edición de destinos más simple',
                'Duplicar un destino de notificación existente'
            ]
        },
        '1.2.0': {
            title: 'Páginas de Proyectos y Bibliotecas',
            items: ['La vista de inicio se divide en páginas dedicadas de Proyectos y Bibliotecas']
        },
        '1.1.2': {
            title: 'Recarga de la programación en vivo',
            items: ['El worker recarga la programación de escaneo en cuanto guardas cambios en el portal']
        },
        '1.1.0': {
            title: 'Borrados más seguros y un aviso de actualización más claro',
            items: [
                'Confirmación antes de eliminar raíces y destinos de notificación',
                'El aviso de actualización pasa a un banner superior descartable',
                'El worker elimina raíces obsoletas cuando desaparece su montaje'
            ]
        },
        '1.0.1': {
            title: 'Correcciones de precisión del escáner',
            items: [
                'Descarta hallazgos cuya versión instalada no está realmente en el rango vulnerable',
                'Permite eliminar un destino de notificación con historial de envíos'
            ]
        },
        '1.0.0': { title: 'Primera versión de código abierto', items: ['El primer lanzamiento público de Sentinello'] }
    },
    fr: {
        '3.0.0': {
            title: 'Sentinello fonctionne désormais sans portail du tout',
            items: [
                'Les scanners sont publiés en CLI sur npm. `npx sentinello` parcourt un dossier, trouve tous les projets qu’il contient, les confronte à npm audit, OSV et GitLab gemnasium, et écrit un avis markdown accompagné d’un prompt de remédiation — sans installation, sans compte, sans base de données, et rien de votre code ne quitte la machine',
                'En pipe, l’avis est la seule chose sur stdout : `npx sentinello | claude -p "$(cat -)"` remet à un agent une liste de travail complète sans que rien ne corrompe le document',
                'Une première exécution ne perd plus la source gemnasium à cause d’un téléchargement refusé. GitLab refuse son archive une à deux minutes d’affilée, et l’ancienne logique abandonnait au bout de treize secondes ; la CLI patiente désormais, explique pourquoi, et accepte `--feed-wait` si les trois minutes par défaut ne conviennent pas',
                'Les deux estimations de téléchargement ont été mesurées plutôt que devinées : l’export npm d’OSV est annoncé à 204 Mo au lieu de 196, et l’archive gemnasium à 52 Mo au lieu de 80. L’invite de consentement marque une estimation d’un tilde pour qu’elle ne soit jamais prise pour une taille annoncée par le serveur',
                'Une valeur ressemblant à une option est désormais rejetée plutôt que prise au pied de la lettre — `--out --` écrivait un avis dans un fichier nommé `--` au sein de votre projet, en signalant une réussite',
                'Le panneau Nouveautés ne déborde plus du bas de la fenêtre quand une version a beaucoup à dire'
            ]
        },
        '2.6.0': {
            title: 'Le document d’avis arrive enfin — et compte ce qu’il faut',
            items: [
                'get_project_advisory renvoie désormais le document lui-même. Les clients connectés ne recevaient jusqu’ici que ses métadonnées — un nom de fichier et un décompte — et jamais le document, alors que l’outil le présentait comme une liste de travail complète',
                'L’export d’avis contient désormais une entrée par avis distinct, sources fusionnées, au lieu d’une par ligne de scanner : une vulnérabilité signalée à la fois par npm audit et OSV devient un seul élément de travail portant les deux identifiants, et non deux quasi identiques. Cela vaut aussi pour le bouton Télécharger .md du portail, et le décompte correspond maintenant à celui du tableau de bord',
                'Un projet trop volumineux pour tenir dans une seule réponse MCP est désormais paginé : le document indique qu’il est incomplet et donne l’appel exact pour récupérer la suite, au lieu d’être tronqué en silence là où un agent lirait le reste comme sain',
                'Chaque paramètre de chaque outil MCP est désormais décrit, et le nouvel outil list_mutes expose les identifiants de mise en sourdine dont unmute a besoin — auparavant accessibles uniquement en créant la mise en sourdine dans la même session',
                'Correction d’une faille dans les décomptes de gravité : un signalement dont la gravité ne faisait pas partie des cinq valeurs connues était compté comme signalement mais rangé dans aucune catégorie, si bien qu’un projet dont c’était le seul signalement paraissait parfaitement sain'
            ]
        },
        '2.5.0': {
            title: 'L’export d’avis, directement via MCP',
            items: [
                'Les clients MCP connectés peuvent récupérer l’avis Markdown complet d’un projet avec le nouvel outil get_project_advisory — le même document que le bouton Télécharger .md du portail, sans le copier depuis le navigateur',
                'Les découvertes masquées sont désormais exclues de l’export d’avis du projet : un agent ne se voit donc jamais confier un travail dont vous avez déjà accepté le risque',
                'Remarque : comme l’avis contient votre prompt d’export, un client MCP peut désormais lire ce que vous avez écrit dans Paramètres → Export'
            ]
        },
        '2.4.3': {
            title: 'Des popups qui ne sont plus rognés et un prompt d’export plus strict',
            items: [
                'Les menus déroulants, le popover de chemin de dépendance et le menu d’export d’avis ne sont plus rognés par le tableau ou la boîte de dialogue qui les contient : ils s’affichent au-dessus de la page et basculent vers le haut lorsqu’il n’y a pas de place en dessous',
                'Le prompt d’export d’avis par défaut demande désormais à l’agent de planifier avant toute modification, de regrouper les résultats qui partagent un même correctif et de détailler l’impact sur le code de chaque montée de version ; il vise zéro résultat tout en écartant les raccourcis vers un faux zéro — mise en sourdine, élargissement des plages ou réduction du périmètre d’analyse — et fait figurer ce qui reste réellement bloqué dans un tableau de résidus daté'
            ]
        },
        '2.4.2': {
            title: 'La branche dans sa propre colonne',
            items: [
                'La branche git sur laquelle un projet a été analysé occupe désormais sa propre colonne dans la liste des projets — texte brut, sans icône — au lieu d’être placée sous le nom du projet'
            ]
        },
        '2.4.1': {
            title: 'Arrêts propres',
            items: [
                'Redémarrer le conteneur n’interrompt plus une analyse en cours d’écriture, et le worker démarre immédiatement au lieu de réessayer pendant environ 30 secondes',
                'Définissez stop_grace_period : 60s (ou --stop-timeout 60) dans votre fichier compose pour lui laisser la place — le README et la documentation Docker l’expliquent désormais'
            ]
        },
        '2.4.0': {
            title: 'Analyse polyglotte — Python, Go et Rust rejoignent npm',
            items: [
                'Sentinello analyse désormais les projets Python, Go et Rust en plus de npm — les fichiers de verrouillage sont résolus entièrement hors ligne, et chaque projet indique sa couverture d’analyse (complète, partielle ou non auditable) afin que les lacunes soient visibles plutôt que silencieuses',
                'La base gemnasium de GitLab rejoint npm audit et OSV comme source d’avis hors ligne, dédupliquée par rapport aux autres via les alias CVE/GHSA ; Paramètres → Sources devient une matrice Langages × Sources avec une portée de notification par cellule, et npm audit peut désormais être désactivé tant qu’une source reste active',
                'Les résultats enregistrent désormais la branche git dont ils proviennent, affichée dans la liste des projets, l’en-tête du projet et chaque notification',
                'Les lignes de projet portent leurs propres actions — analyser maintenant, copier ou télécharger l’avis, mettre en sourdine ou réactiver, et modifier les tags — si bien qu’une passe de triage n’oblige plus à ouvrir chaque projet',
                'Le tableau de bord des projets est passé d’environ 3,3 s à 0,03 s, et la navigation affiche désormais des états de chargement au lieu de paraître figée',
                'Sécurité : 25 avis de dépendances corrigés, dont des CVE libvips actives dans l’optimiseur d’images du portail et neuf avis Next.js affectant le portail livré',
                'Le prompt d’export d’avis par défaut couvre désormais l’âge minimal de publication, la vérification du fichier de verrouillage et les overrides obsolètes'
            ]
        },
        '2.3.0': {
            title: 'Configuration MCP simplifiée, sans variables d’environnement',
            items: [
                'Configurez MCP entièrement dans Paramètres → MCP : générez un jeton pour activer le point de terminaison /api/mcp, effacez-le pour le désactiver — les variables d’environnement SENTINELLO_MCP_ENABLED et SENTINELLO_MCP_API_TOKEN ont disparu (un jeton d’environnement existant est importé une fois lors de la mise à niveau)',
                'Extraits de connexion prêts à coller pour Claude Code, Codex, Cursor et Claude Desktop, pré-remplis avec votre jeton',
                'Lorsque SENTINELLO_PORTAL_BASE_URL est définie dans l’environnement, elle s’affiche en lecture seule dans Paramètres → Avancé, car elle reste prioritaire et est réappliquée à chaque démarrage'
            ]
        },
        '2.2.0': {
            title: 'Moins de fausses alertes et des résultats qui se nettoient seuls',
            items: [
                'Les avis de malware correspondent désormais à la version compromise exacte — une version saine ou déjà corrigée d’un paquet autrefois compromis n’est plus signalée',
                'Les résultats en double se résolvent désormais d’eux-mêmes au prochain scan, si bien que les entrées anciennes ou orphelines disparaissent automatiquement',
                'Les étiquettes production et développement sont désormais calculées d’une seule façon cohérente pour toutes les sources (npm et OSV)'
            ]
        },
        '2.1.0': {
            title: 'Un en-tête de projet plus épuré et des filtres cohérents',
            items: [
                'En-tête de projet simplifié — renommez à côté du titre, avec la mise en sourdine et les tags en icônes',
                'Filtrez les résultats par source (npm / OSV) depuis un nouveau menu déroulant à côté du filtre de type de dépendance',
                'Menus déroulants unifiés et cohérents dans toute l’application, avec recherche instantanée sur les longues listes comme les fuseaux horaires'
            ]
        },
        '2.0.1': {
            title: 'Conseils de mise à niveau plus clairs',
            items: [
                'Étapes de mise à niveau détaillées pour les changements incompatibles de la 2.0',
                'Le README indique la liaison du port en localhost uniquement'
            ]
        },
        '2.0.0': {
            title: 'Analyse multi-source et une installation renforcée, sécurisée par défaut',
            items: [
                'OSV comme deuxième source optionnelle (Paramètres → Sources, désactivée par défaut) avec détection des paquets malveillants, comparée à la base de données publique OSV dans un cache local',
                'Les résultats sont désormais fusionnés entre sources — une ligne par vulnérabilité, chaque source étiquetée, le meilleur correctif disponible et l’union des chemins de dépendances, avec un filtre par source et une infobulle de chemin de dépendance',
                'Renforcement de la sécurité : le point de terminaison MCP est désactivé par défaut et requiert un jeton, la livraison des webhooks est protégée contre le SSRF, une page de connexion optionnelle au portail, et le conteneur s’exécute en utilisateur non privilégié',
                'Les Paramètres forment désormais une section de premier niveau avec une barre latérale et une page Profil'
            ]
        },
        '1.4.0': {
            title: 'Intégration MCP et nouveautés',
            items: [
                'Serveur MCP sur /api/mcp pour Claude Desktop, Cursor et d’autres clients',
                'Nouvelle section Paramètres → MCP avec URL du serveur et gestion des jetons',
                'Pastille de nouveautés et historique des notes de version'
            ]
        },
        '1.3.1': {
            title: 'Correction de la version dans le pied de page',
            items: ['La version en cours s’affiche correctement dans le pied de page']
        },
        '1.3.0': {
            title: 'Améliorations des notifications',
            items: [
                'Filtrer les notifications par environnement',
                'Formulaire d’édition des cibles simplifié',
                'Dupliquer une cible de notification existante'
            ]
        },
        '1.2.0': {
            title: 'Pages Projets et Bibliothèques',
            items: ['La vue d’accueil est divisée en pages Projets et Bibliothèques dédiées']
        },
        '1.1.2': {
            title: 'Rechargement du planning en direct',
            items: [
                'Le worker recharge le planning d’analyse dès que vous enregistrez des modifications dans le portail'
            ]
        },
        '1.1.0': {
            title: 'Suppressions plus sûres et bannière de mise à jour plus claire',
            items: [
                'Confirmation avant la suppression de racines et de cibles de notification',
                'L’avis de mise à jour devient une bannière supérieure que l’on peut fermer',
                'Le worker supprime les racines obsolètes quand leur montage disparaît'
            ]
        },
        '1.0.1': {
            title: 'Corrections de précision du scanner',
            items: [
                'Écarte les résultats dont la version installée n’est pas réellement dans la plage vulnérable',
                'Permet de supprimer une cible de notification ayant un historique d’envois'
            ]
        },
        '1.0.0': { title: 'Première version open source', items: ['La première version publique de Sentinello'] }
    },
    de: {
        '3.0.0': {
            title: 'Sentinello läuft jetzt ganz ohne Portal',
            items: [
                'Die Scanner erscheinen als CLI auf npm. `npx sentinello` durchläuft einen Ordner, findet jedes Projekt darunter, prüft sie gegen npm audit, OSV und GitLab gemnasium und schreibt ein Markdown-Advisory mit angehängtem Remediation-Prompt — ohne Installation, ohne Konto, ohne Datenbank, und nichts von deinem Code verlässt die Maschine',
                'In einer Pipe ist das Advisory das Einzige auf stdout, sodass `npx sentinello | claude -p "$(cat -)"` einem Agenten eine vollständige Arbeitsliste übergibt, ohne dass irgendetwas das Dokument beschädigt',
                'Ein erster Lauf verliert die Quelle gemnasium nicht mehr an einen abgelehnten Download. GitLab verweigert sein Archiv ein bis zwei Minuten am Stück, und der alte Retry gab nach dreizehn Sekunden auf; die CLI wartet es nun aus, sagt warum sie wartet, und nimmt `--feed-wait`, falls die drei Minuten Standard für dich falsch sind',
                'Beide Download-Schätzungen wurden gemessen statt geraten: der npm-Export von OSV wird mit 204 MB statt 196 angegeben, das gemnasium-Archiv mit 52 MB statt 80. Die Zustimmungsabfrage kennzeichnet eine Schätzung mit einer Tilde, damit sie nie mit einer vom Server gemeldeten Größe verwechselt wird',
                'Ein Wert, der wie eine Option aussieht, wird jetzt abgelehnt statt wörtlich genommen — `--out --` schrieb ein Advisory in eine Datei namens `--` in deinem Projekt und meldete Erfolg',
                'Das Neuigkeiten-Panel läuft nicht mehr unten aus dem Fenster, wenn ein Release viel zu erzählen hat'
            ]
        },
        '2.6.0': {
            title: 'Das Advisory-Dokument kommt jetzt wirklich an — und zählt richtig',
            items: [
                'get_project_advisory liefert jetzt das Dokument selbst. Verbundene Clients erhielten bisher nur dessen Metadaten — einen Dateinamen und eine Anzahl — und nie das Dokument, obwohl das Werkzeug es als vollständige Arbeitsliste beschrieb',
                'Der Advisory-Export enthält jetzt einen Eintrag je eindeutigem Advisory mit zusammengeführten Quellen statt einen je Scanner-Zeile: Eine Schwachstelle, die npm audit und OSV beide melden, ist ein einziger Arbeitspunkt mit beiden Advisory-IDs statt zwei fast identischen. Das gilt auch für „.md herunterladen“ im Portal, und die Anzahl stimmt nun mit dem Dashboard überein',
                'Ein Projekt, das nicht in eine einzelne MCP-Antwort passt, wird jetzt paginiert: Das Dokument weist darauf hin, dass es unvollständig ist, und nennt den genauen Folgeaufruf für den Rest — statt still abgeschnitten zu werden, wo ein Agent den Rest für sauber hielte',
                'Jeder Parameter jedes MCP-Werkzeugs ist jetzt beschrieben, und das neue Werkzeug list_mutes liefert die Stummschaltungs-IDs, die unmute benötigt — bisher nur erhältlich, wenn man die Stummschaltung in derselben Sitzung angelegt hatte',
                'Eine Lücke in den Schweregrad-Zählungen behoben: Ein Fund, dessen Schweregrad keiner der fünf bekannten Werte war, wurde als Fund gezählt, aber keiner Kategorie zugeordnet — ein Projekt mit genau diesem einen Fund wirkte dadurch völlig sauber'
            ]
        },
        '2.5.0': {
            title: 'Der Advisory-Export, direkt über MCP',
            items: [
                'Verbundene MCP-Clients können das vollständige Markdown-Advisory eines Projekts über das neue Tool get_project_advisory abrufen — dasselbe Dokument wie der Portal-Button „.md herunterladen“, ohne es aus dem Browser zu kopieren',
                'Stummgeschaltete Funde werden nicht mehr in den Advisory-Export des Projekts aufgenommen, sodass ein Agent nie Arbeit erhält, deren Risiko Sie bereits akzeptiert haben',
                'Hinweis: Da das Advisory Ihren Export-Prompt enthält, kann ein MCP-Client jetzt lesen, was Sie unter Einstellungen → Export hinterlegt haben'
            ]
        },
        '2.4.3': {
            title: 'Popups ohne Abschneiden und ein strengerer Export-Prompt',
            items: [
                'Dropdowns, das Abhängigkeitspfad-Popover und das Advisory-Export-Menü werden nicht mehr von der Tabelle oder dem Dialog abgeschnitten, in dem sie sitzen — sie werden über der Seite gerendert und klappen nach oben, wenn darunter kein Platz ist',
                'Der Standard-Prompt für den Advisory-Export verlangt jetzt, dass der Agent plant, bevor er etwas ändert, Funde mit gemeinsamem Fix gruppiert und die Code-Auswirkung jedes Versionssprungs benennt; er zielt auf null Funde und schließt dabei die Abkürzungen zu einer geschönten Null aus — Stummschalten, Ranges aufweiten oder den Scan-Umfang verkleinern —, während wirklich Offenes in einer datierten Restposten-Tabelle landet'
            ]
        },
        '2.4.2': {
            title: 'Der Branch in eigener Spalte',
            items: [
                'Der git-Branch, auf dem ein Projekt gescannt wurde, hat jetzt eine eigene Spalte in der Projektliste — reiner Text, kein Icon — statt unter dem Projektnamen zu stehen'
            ]
        },
        '2.4.1': {
            title: 'Sauberes Herunterfahren',
            items: [
                'Ein Neustart des Containers bricht keinen Scan mehr mitten im Schreibvorgang ab, und der Worker startet sofort, statt es zuerst ~30 Sekunden lang erneut zu versuchen',
                'Setze stop_grace_period: 60s (oder --stop-timeout 60) in deiner Compose-Datei, damit er den nötigen Spielraum hat — README und Docker-Doku beschreiben das jetzt'
            ]
        },
        '2.4.0': {
            title: 'Polyglotte Analyse — Python, Go und Rust kommen zu npm dazu',
            items: [
                'Sentinello analysiert jetzt neben npm auch Python-, Go- und Rust-Projekte — Lockfiles werden vollständig offline aufgelöst, und jedes Projekt meldet seine Analyseabdeckung (vollständig, teilweise oder nicht prüfbar), sodass Lücken sichtbar statt stillschweigend sind',
                'GitLabs gemnasium-Datenbank ergänzt npm audit und OSV als Offline-Advisory-Quelle, dedupliziert über CVE-/GHSA-Aliase; Einstellungen → Quellen ist jetzt eine Sprachen-×-Quellen-Matrix mit Benachrichtigungsbereich pro Zelle, und npm audit selbst lässt sich abschalten, solange eine Quelle aktiv bleibt',
                'Funde halten jetzt den git-Branch fest, aus dem sie stammen — sichtbar in der Projektliste, im Projektkopf und in jeder Benachrichtigung',
                'Projektzeilen haben eigene Aktionen — jetzt scannen, Advisory kopieren oder herunterladen, stummschalten oder reaktivieren und Tags bearbeiten — ein Triage-Durchgang erfordert also keinen Abstecher in jedes Projekt mehr',
                'Das Projekt-Dashboard ging von ~3,3 s auf ~0,03 s zurück, und die Navigation zeigt jetzt Ladezustände, statt eingefroren zu wirken',
                'Sicherheit: 25 Abhängigkeits-Advisories behoben, darunter libvips-CVEs, die im Bildoptimierer des Portals aktiv waren, und neun Next.js-Advisories, die das ausgelieferte Portal betrafen',
                'Der Standard-Prompt für den Advisory-Export deckt jetzt Mindestveröffentlichungsalter, Lockfile-Prüfung und veraltete Overrides ab'
            ]
        },
        '2.3.0': {
            title: 'Einfachere MCP-Einrichtung — ohne Umgebungsvariablen',
            items: [
                'MCP wird jetzt vollständig unter Einstellungen → MCP eingerichtet: Token generieren, um den Endpunkt /api/mcp einzuschalten, löschen, um ihn auszuschalten — die Umgebungsvariablen SENTINELLO_MCP_ENABLED und SENTINELLO_MCP_API_TOKEN entfallen (ein vorhandenes Umgebungs-Token wird beim Upgrade einmalig importiert)',
                'Fertige Verbindungs-Snippets zum Einfügen für Claude Code, Codex, Cursor und Claude Desktop, bereits mit deinem Token ausgefüllt',
                'Wenn SENTINELLO_PORTAL_BASE_URL in der Umgebung gesetzt ist, wird sie unter Einstellungen → Erweitert schreibgeschützt angezeigt, da sie maßgeblich bleibt und bei jedem Start erneut angewendet wird'
            ]
        },
        '2.2.0': {
            title: 'Weniger Fehlalarme und selbstbereinigende Funde',
            items: [
                'Malware-Hinweise stimmen jetzt mit der genau betroffenen Version überein — eine saubere oder bereits behobene Version eines einst kompromittierten Pakets wird nicht mehr markiert',
                'Doppelte Funde lösen sich jetzt beim nächsten Scan von selbst auf, sodass alte oder verwaiste Einträge automatisch verschwinden',
                'Produktions- und Entwicklungs-Kennzeichnungen werden jetzt über alle Quellen (npm und OSV) auf eine einheitliche Weise berechnet'
            ]
        },
        '2.1.0': {
            title: 'Ein aufgeräumter Projekt-Header und einheitliche Filter',
            items: [
                'Verschlankter Projekt-Header — Umbenennen direkt neben dem Titel, Stummschalten und Tags als Icon-Buttons',
                'Funde nach Quelle filtern (npm / OSV) über ein neues Dropdown neben dem Abhängigkeitstyp-Filter',
                'Einheitliche Dropdowns in der gesamten App, mit Tippsuche für lange Listen wie Zeitzonen'
            ]
        },
        '2.0.1': {
            title: 'Klarere Upgrade-Hinweise',
            items: [
                'Erweiterte Upgrade-Schritte für die Breaking Changes von 2.0',
                'Die README weist auf die nur-localhost-Portbindung hin'
            ]
        },
        '2.0.0': {
            title: 'Multi-Quellen-Scan und eine gehärtete, standardmäßig sichere Installation',
            items: [
                'OSV als optionale zweite Quelle (Einstellungen → Quellen, standardmäßig aus) mit Erkennung schädlicher Pakete, abgeglichen mit der öffentlichen OSV-Datenbank in einem lokalen Cache',
                'Funde werden jetzt quellenübergreifend zusammengeführt — eine Zeile pro Schwachstelle, jede Quelle markiert, der beste verfügbare Fix und die Vereinigung der Abhängigkeitspfade, mit Quellenfilter und einem Abhängigkeitspfad-Popover',
                'Sicherheitshärtung: der MCP-Endpunkt ist standardmäßig aus und erfordert ein Token, die Webhook-Zustellung ist gegen SSRF abgesichert, ein optionales Portal-Login, und der Container läuft als unprivilegierter Benutzer',
                'Einstellungen sind jetzt ein Bereich der obersten Ebene mit Seitenleiste und einer Profilseite'
            ]
        },
        '1.4.0': {
            title: 'MCP-Integration & Neuigkeiten',
            items: [
                'MCP-Server unter /api/mcp für Claude Desktop, Cursor und andere Clients',
                'Neuer Bereich Einstellungen → MCP mit Server-URL und Token-Verwaltung',
                'Neuigkeiten-Symbol und ein Verlauf der Versionshinweise'
            ]
        },
        '1.3.1': {
            title: 'Korrektur der Version in der Fußzeile',
            items: ['Die laufende Version wird in der Fußzeile sauber dargestellt']
        },
        '1.3.0': {
            title: 'Verbesserungen bei Benachrichtigungen',
            items: [
                'Benachrichtigungen nach Umgebung filtern',
                'Einfacheres Formular zum Bearbeiten von Zielen',
                'Ein vorhandenes Benachrichtigungsziel duplizieren'
            ]
        },
        '1.2.0': {
            title: 'Seiten für Projekte und Bibliotheken',
            items: ['Die Startansicht ist in eigene Seiten für Projekte und Bibliotheken aufgeteilt']
        },
        '1.1.2': {
            title: 'Live-Neuladen des Zeitplans',
            items: ['Der Worker lädt den Scan-Zeitplan neu, sobald du Änderungen im Portal speicherst']
        },
        '1.1.0': {
            title: 'Sichereres Löschen & ein klareres Update-Banner',
            items: [
                'Bestätigung vor dem Löschen von Roots und Benachrichtigungszielen',
                'Update-Hinweis als schließbares Banner oben',
                'Der Worker entfernt veraltete Roots, wenn ihr Host-Mount verschwindet'
            ]
        },
        '1.0.1': {
            title: 'Korrekturen der Scanner-Genauigkeit',
            items: [
                'Verwirft Funde, deren installierte Version nicht wirklich im verwundbaren Bereich liegt',
                'Ermöglicht das Löschen eines Benachrichtigungsziels mit Versandverlauf'
            ]
        },
        '1.0.0': {
            title: 'Erste Open-Source-Version',
            items: ['Die erste öffentliche Veröffentlichung von Sentinello']
        }
    },
    'pt-BR': {
        '3.0.0': {
            title: 'O Sentinello agora roda sem portal nenhum',
            items: [
                'Os scanners saem como CLI no npm. `npx sentinello` percorre uma pasta, encontra todos os projetos abaixo, confere contra npm audit, OSV e GitLab gemnasium, e escreve um parecer em markdown com um prompt de remediação anexado — sem instalação, sem conta, sem banco de dados, e nada do seu código sai da máquina',
                'Em pipe, o parecer é a única coisa no stdout, então `npx sentinello | claude -p "$(cat -)"` entrega a um agente uma lista de trabalho completa sem nada corromper o documento',
                'A primeira execução não perde mais a fonte gemnasium por um download recusado. O GitLab recusa seu arquivo por um ou dois minutos seguidos, e a repetição antiga desistia em treze segundos; agora a CLI espera passar, diz por que está esperando, e aceita `--feed-wait` se os três minutos padrão não servirem',
                'As duas estimativas de download foram medidas, não chutadas: o export npm do OSV é informado como 204 MB em vez de 196, e o arquivo do gemnasium como 52 MB em vez de 80. O aviso de consentimento marca uma estimativa com um til para que nunca seja confundida com um tamanho informado pelo servidor',
                'Um valor com cara de flag agora é recusado em vez de aceito ao pé da letra — `--out --` escrevia um parecer em um arquivo chamado `--` dentro do seu projeto e relatava sucesso',
                'O painel de Novidades não escapa mais pela parte de baixo da janela quando uma versão tem muito a dizer'
            ]
        },
        '2.6.0': {
            title: 'O documento de parecer realmente chega — e conta o que você quer dizer',
            items: [
                'get_project_advisory agora retorna o próprio documento de parecer. Antes, os clientes conectados recebiam só os metadados — um nome de arquivo e uma contagem — e nunca o documento, embora a ferramenta o descrevesse como uma lista de trabalho completa',
                'A exportação de pareceres agora tem uma entrada por parecer distinto, com suas fontes mescladas, em vez de uma por linha de scanner: uma vulnerabilidade que npm audit e OSV relatam é um único item de trabalho carregando os dois IDs, não dois quase idênticos. Isso vale também para o Download .md do portal, e a contagem agora bate com o painel',
                'Um projeto grande demais para caber em uma resposta MCP agora é paginado — o documento informa que está incompleto e dá a chamada exata para buscar o resto, em vez de ser cortado em silêncio onde um agente leria o restante como limpo',
                'Toda entrada de toda ferramenta MCP agora tem uma descrição, e uma nova ferramenta list_mutes expõe os IDs de silenciamento de que unmute precisa — antes só obteníveis criando o silenciamento na mesma sessão',
                'Corrigida uma falha nas contagens de severidade: um achado cuja severidade não fosse um dos cinco valores conhecidos era contado como achado mas não entrava em nenhum balde de severidade, então um projeto cujo único achado tivesse isso parecia completamente limpo'
            ]
        },
        '2.5.0': {
            title: 'O relatório de vulnerabilidades, direto pelo MCP',
            items: [
                'Clientes MCP conectados podem obter o relatório Markdown completo de um projeto com a nova ferramenta get_project_advisory — o mesmo documento do botão Baixar .md do portal, sem copiá-lo do navegador',
                'Descobertas silenciadas não entram mais no relatório do projeto, então um agente nunca recebe um trabalho cujo risco você já aceitou',
                'Observação: como o relatório contém o seu prompt de exportação, um cliente MCP agora consegue ler o que você escreveu em Configurações → Exportação'
            ]
        },
        '2.4.3': {
            title: 'Popups sem corte e um prompt de exportação mais rigoroso',
            items: [
                'Os menus suspensos, o popover de caminho de dependência e o menu de exportação de avisos não são mais cortados pela tabela ou pelo diálogo em que ficam — eles são renderizados acima da página e abrem para cima quando não há espaço embaixo',
                'O prompt padrão de exportação de avisos agora pede que o agente planeje antes de editar qualquer coisa, agrupe os achados que compartilham uma mesma correção e detalhe o impacto no código de cada mudança de versão; ele mira zero achados e descarta os atalhos para um zero falso — silenciar, ampliar intervalos ou reduzir o escopo da análise —, deixando o que é realmente irredutível em uma tabela de resíduos datada'
            ]
        },
        '2.4.2': {
            title: 'O branch em sua própria coluna',
            items: [
                'O branch do git em que o projeto foi analisado agora tem uma coluna própria na lista de projetos — texto simples, sem ícone — em vez de ficar embaixo do nome do projeto'
            ]
        },
        '2.4.1': {
            title: 'Desligamentos limpos',
            items: [
                'Reiniciar o contêiner não interrompe mais uma análise no meio da gravação, e o worker inicia imediatamente em vez de tentar de novo por ~30 segundos',
                'Defina stop_grace_period: 60s (ou --stop-timeout 60) no seu arquivo compose para dar espaço a ele — o README e a documentação do Docker agora explicam isso'
            ]
        },
        '2.4.0': {
            title: 'Análise poliglota — Python, Go e Rust se juntam ao npm',
            items: [
                'O Sentinello agora analisa projetos Python, Go e Rust além de npm — os arquivos de bloqueio são resolvidos totalmente offline e cada projeto informa sua cobertura de análise (completa, parcial ou não auditável), de modo que as lacunas fiquem visíveis em vez de silenciosas',
                'O banco gemnasium do GitLab se junta ao npm audit e ao OSV como fonte de avisos offline, deduplicada em relação às demais por alias CVE/GHSA; Configurações → Fontes agora é uma matriz Linguagens × Fontes com escopo de notificação por célula, e o próprio npm audit pode ser desativado desde que uma fonte permaneça ativa',
                'Os achados agora registram o branch do git de onde vieram, exibido na lista de projetos, no cabeçalho do projeto e em todas as notificações',
                'As linhas de projeto trazem suas próprias ações — analisar agora, copiar ou baixar o aviso, silenciar ou reativar e editar tags — assim uma rodada de triagem não exige mais entrar em cada projeto',
                'O painel de projetos passou de ~3,3 s para ~0,03 s, e a navegação agora mostra estados de carregamento em vez de parecer travada',
                'Segurança: 25 avisos de dependências resolvidos, incluindo CVEs do libvips que estavam ativos no otimizador de imagens do portal e nove avisos do Next.js que afetavam o portal distribuído',
                'O prompt padrão de exportação de avisos agora cobre idade mínima de publicação, verificação do arquivo de bloqueio e overrides obsoletos'
            ]
        },
        '2.3.0': {
            title: 'Configuração de MCP mais simples, sem variáveis de ambiente',
            items: [
                'Configure o MCP inteiramente em Configurações → MCP: gere um token para ativar o endpoint /api/mcp e limpe-o para desativá-lo — as variáveis de ambiente SENTINELLO_MCP_ENABLED e SENTINELLO_MCP_API_TOKEN foram removidas (um token de ambiente existente é importado uma vez na atualização)',
                'Trechos de conexão prontos para colar para Claude Code, Codex, Cursor e Claude Desktop, já preenchidos com o seu token',
                'Quando SENTINELLO_PORTAL_BASE_URL é definida no ambiente, ela aparece como somente leitura em Configurações → Avançado, pois continua sendo autoritativa e é reaplicada a cada inicialização'
            ]
        },
        '2.2.0': {
            title: 'Menos alarmes falsos e achados que se limpam sozinhos',
            items: [
                'Os avisos de malware agora correspondem à versão comprometida exata — uma versão limpa ou já corrigida de um pacote que esteve comprometido deixa de ser sinalizada',
                'Achados duplicados agora se resolvem sozinhos na próxima varredura, de modo que entradas antigas ou órfãs são removidas automaticamente',
                'Os rótulos de produção e desenvolvimento agora são calculados de uma única forma consistente em todas as fontes (npm e OSV)'
            ]
        },
        '2.1.0': {
            title: 'Um cabeçalho de projeto mais limpo e filtros consistentes',
            items: [
                'Cabeçalho de projeto simplificado — renomeie ao lado do título, com silenciar e tags como ícones',
                'Filtre as ocorrências por fonte (npm / OSV) em um novo menu suspenso ao lado do filtro de tipo de dependência',
                'Menus suspensos unificados e consistentes em todo o app, com busca ao digitar em listas longas como fusos horários'
            ]
        },
        '2.0.1': {
            title: 'Orientações de atualização mais claras',
            items: [
                'Passos de atualização ampliados para as alterações incompatíveis da 2.0',
                'O README indica a vinculação de porta somente em localhost'
            ]
        },
        '2.0.0': {
            title: 'Varredura multi-fonte e uma instalação reforçada e segura por padrão',
            items: [
                'OSV como segunda fonte opcional (Configurações → Fontes, desativada por padrão) com detecção de pacotes maliciosos, comparada com o banco de dados público do OSV em um cache local',
                'Os achados agora são mesclados entre fontes — uma linha por vulnerabilidade, cada fonte marcada, a melhor correção disponível e a união dos caminhos de dependência, com filtro por fonte e um popover de caminho de dependência',
                'Reforço de segurança: o endpoint MCP está desativado por padrão e exige um token, a entrega de webhooks é protegida contra SSRF, uma porta de login opcional do portal, e o contêiner é executado como usuário sem privilégios',
                'Configurações agora é uma seção de nível superior com barra lateral e uma página de Perfil'
            ]
        },
        '1.4.0': {
            title: 'Integração MCP e novidades',
            items: [
                'Servidor MCP em /api/mcp para Claude Desktop, Cursor e outros clientes',
                'Nova seção Configurações → MCP com URL do servidor e gerenciamento de tokens',
                'Etiqueta de novidades e um histórico de notas de versão'
            ]
        },
        '1.3.1': {
            title: 'Correção da versão no rodapé',
            items: ['A versão em execução é exibida corretamente no rodapé']
        },
        '1.3.0': {
            title: 'Melhorias nas notificações',
            items: [
                'Filtrar notificações por ambiente',
                'Formulário de edição de destinos mais simples',
                'Duplicar um destino de notificação existente'
            ]
        },
        '1.2.0': {
            title: 'Páginas de Projetos e Bibliotecas',
            items: ['A tela inicial é dividida em páginas dedicadas de Projetos e Bibliotecas']
        },
        '1.1.2': {
            title: 'Recarregamento da agenda em tempo real',
            items: ['O worker recarrega a agenda de varredura assim que você salva alterações no portal']
        },
        '1.1.0': {
            title: 'Exclusões mais seguras e um aviso de atualização mais claro',
            items: [
                'Confirmação antes de excluir raízes e destinos de notificação',
                'Aviso de atualização movido para um banner superior dispensável',
                'O worker remove raízes obsoletas quando o ponto de montagem desaparece'
            ]
        },
        '1.0.1': {
            title: 'Correções de precisão do scanner',
            items: [
                'Descarta achados cuja versão instalada não está realmente na faixa vulnerável',
                'Permite excluir um destino de notificação com histórico de envios'
            ]
        },
        '1.0.0': { title: 'Primeira versão de código aberto', items: ['O primeiro lançamento público do Sentinello'] }
    },
    it: {
        '3.0.0': {
            title: 'Sentinello ora funziona anche senza portale',
            items: [
                'Gli scanner arrivano come CLI su npm. `npx sentinello` attraversa una cartella, trova ogni progetto al suo interno, li confronta con npm audit, OSV e GitLab gemnasium, e scrive un advisory markdown con un prompt di remediation allegato — nessuna installazione, nessun account, nessun database, e nulla del tuo codice lascia la macchina',
                'In pipe, l’advisory è l’unica cosa su stdout, così `npx sentinello | claude -p "$(cat -)"` consegna a un agente un elenco di lavoro completo senza che nulla corrompa il documento',
                'Una prima esecuzione non perde più la fonte gemnasium per un download rifiutato. GitLab rifiuta il suo archivio per uno o due minuti alla volta, e il vecchio retry si arrendeva dopo tredici secondi; ora la CLI aspetta che passi, spiega perché sta aspettando, e accetta `--feed-wait` se i tre minuti predefiniti non vanno bene',
                'Entrambe le stime di download sono state misurate anziché ipotizzate: l’export npm di OSV è indicato a 204 MB invece di 196, e l’archivio gemnasium a 52 MB invece di 80. Il prompt di consenso segna una stima con una tilde perché non venga mai scambiata per una dimensione dichiarata dal server',
                'Un valore che sembra un’opzione ora viene rifiutato invece di essere preso alla lettera — `--out --` scriveva un advisory in un file chiamato `--` dentro il tuo progetto e riportava successo',
                'Il pannello Novità non esce più dal fondo della finestra quando una release ha molto da dire'
            ]
        },
        '2.6.0': {
            title: 'Il documento degli avvisi arriva davvero — e conta ciò che serve',
            items: [
                'get_project_advisory ora restituisce il documento vero e proprio. Finora i client collegati ricevevano solo i suoi metadati — un nome file e un conteggio — e mai il documento, benché lo strumento lo descrivesse come un elenco di lavoro completo',
                'L’export degli avvisi contiene ora una voce per ogni avviso distinto, con le fonti unite, invece di una per riga dello scanner: una vulnerabilità segnalata sia da npm audit sia da OSV è un unico elemento di lavoro con entrambi gli identificativi, non due quasi identici. Vale anche per il pulsante Scarica .md del portale, e il conteggio ora coincide con quello della dashboard',
                'Un progetto troppo grande per stare in una sola risposta MCP viene ora paginato: il documento dichiara di essere incompleto e indica la chiamata esatta per ottenere il resto, invece di essere troncato in silenzio dove un agente leggerebbe il resto come pulito',
                'Ogni parametro di ogni strumento MCP ha ora una descrizione, e il nuovo strumento list_mutes espone gli identificativi di silenziamento richiesti da unmute — prima ottenibili solo creando il silenziamento nella stessa sessione',
                'Corretta una falla nei conteggi di gravità: un rilevamento la cui gravità non era uno dei cinque valori noti veniva contato ma non finiva in alcuna categoria, così un progetto con quel solo rilevamento appariva completamente pulito'
            ]
        },
        '2.5.0': {
            title: 'L’export degli avvisi, direttamente via MCP',
            items: [
                'I client MCP collegati possono scaricare l’avviso Markdown completo di un progetto con il nuovo strumento get_project_advisory — lo stesso documento del pulsante Scarica .md del portale, senza copiarlo dal browser',
                'I risultati silenziati non sono più inclusi nell’export degli avvisi del progetto, quindi a un agente non viene mai affidato un lavoro il cui rischio hai già accettato',
                'Nota: poiché l’avviso contiene il tuo prompt di export, un client MCP può ora leggere ciò che hai scritto in Impostazioni → Export'
            ]
        },
        '2.4.3': {
            title: 'Popup non più tagliati e un prompt di esportazione più severo',
            items: [
                'I menu a discesa, il popover del percorso delle dipendenze e il menu di esportazione degli avvisi non vengono più tagliati dalla tabella o dalla finestra di dialogo che li contiene: sono disegnati sopra la pagina e si aprono verso l’alto quando sotto non c’è spazio',
                'Il prompt predefinito di esportazione degli avvisi ora chiede all’agente di pianificare prima di modificare qualsiasi cosa, di raggruppare i risultati che condividono la stessa correzione e di descrivere l’impatto sul codice di ogni cambio di versione; punta a zero risultati escludendo le scorciatoie verso uno zero fittizio — silenziare, allargare gli intervalli o restringere l’ambito dell’analisi — e lascia ciò che è davvero irrisolvibile in una tabella dei residui con data'
            ]
        },
        '2.4.2': {
            title: 'Il branch in una colonna dedicata',
            items: [
                'Il branch git su cui è stato analizzato un progetto ha ora una colonna dedicata nell’elenco dei progetti — testo semplice, senza icona — invece di comparire sotto il nome del progetto'
            ]
        },
        '2.4.1': {
            title: 'Arresti puliti',
            items: [
                'Riavviare il container non interrompe più un’analisi a metà scrittura e il worker parte subito invece di riprovare per ~30 secondi',
                'Imposta stop_grace_period: 60s (o --stop-timeout 60) nel tuo file compose per dargli spazio: il README e la documentazione Docker ora lo spiegano'
            ]
        },
        '2.4.0': {
            title: 'Analisi poliglotta — Python, Go e Rust si aggiungono a npm',
            items: [
                'Sentinello ora analizza progetti Python, Go e Rust oltre a npm — i lockfile sono risolti interamente offline e ogni progetto dichiara la propria copertura di analisi (completa, parziale o non verificabile), così le lacune sono visibili invece che silenziose',
                'Il database gemnasium di GitLab si affianca a npm audit e OSV come sorgente di avvisi offline, deduplicata rispetto alle altre tramite alias CVE/GHSA; Impostazioni → Sorgenti è ora una matrice Linguaggi × Sorgenti con ambito di notifica per cella, e npm audit stesso può essere disattivato purché resti attiva una sorgente',
                'I risultati registrano ora il branch git da cui provengono, mostrato nell’elenco dei progetti, nell’intestazione del progetto e in ogni notifica',
                'Le righe dei progetti hanno azioni proprie — analizza ora, copia o scarica l’avviso, silenzia o riattiva e modifica i tag — così un giro di triage non richiede più di entrare in ogni progetto',
                'La dashboard dei progetti è passata da ~3,3 s a ~0,03 s e la navigazione mostra ora stati di caricamento invece di sembrare bloccata',
                'Sicurezza: risolti 25 avvisi sulle dipendenze, inclusi CVE di libvips attivi nell’ottimizzatore di immagini del portale e nove avvisi Next.js che riguardavano il portale distribuito',
                'Il prompt predefinito di esportazione degli avvisi copre ora l’età minima di pubblicazione, la verifica del lockfile e gli override obsoleti'
            ]
        },
        '2.3.0': {
            title: 'Configurazione MCP più semplice, senza variabili d’ambiente',
            items: [
                'Configura MCP interamente in Impostazioni → MCP: genera un token per attivare l’endpoint /api/mcp, cancellalo per disattivarlo — le variabili d’ambiente SENTINELLO_MCP_ENABLED e SENTINELLO_MCP_API_TOKEN non esistono più (un token d’ambiente esistente viene importato una volta durante l’aggiornamento)',
                'Frammenti di connessione pronti da incollare per Claude Code, Codex, Cursor e Claude Desktop, già compilati con il tuo token',
                'Quando SENTINELLO_PORTAL_BASE_URL è impostata nell’ambiente, viene mostrata in sola lettura in Impostazioni → Avanzate, poiché resta autoritativa e viene riapplicata a ogni avvio'
            ]
        },
        '2.2.0': {
            title: 'Meno falsi allarmi e risultati che si ripuliscono da soli',
            items: [
                'Gli avvisi di malware ora corrispondono alla versione compromessa esatta — una versione pulita o già corretta di un pacchetto un tempo compromesso non viene più segnalata',
                'I risultati duplicati ora si risolvono da soli alla scansione successiva, così le voci vecchie o orfane vengono eliminate automaticamente',
                'Le etichette di produzione e sviluppo ora vengono calcolate in un unico modo coerente su tutte le sorgenti (npm e OSV)'
            ]
        },
        '2.1.0': {
            title: 'Un’intestazione di progetto più pulita e filtri coerenti',
            items: [
                'Intestazione di progetto semplificata — rinomina accanto al titolo, con silenzia e tag come icone',
                'Filtra i risultati per fonte (npm / OSV) da un nuovo menu a discesa accanto al filtro per tipo di dipendenza',
                'Menu a discesa unificati e coerenti in tutta l’app, con ricerca durante la digitazione per elenchi lunghi come i fusi orari'
            ]
        },
        '2.0.1': {
            title: 'Indicazioni di aggiornamento più chiare',
            items: [
                'Passaggi di aggiornamento ampliati per le modifiche incompatibili della 2.0',
                'Il README segnala il binding della porta solo su localhost'
            ]
        },
        '2.0.0': {
            title: 'Scansione multi-sorgente e un’installazione rafforzata e sicura per impostazione predefinita',
            items: [
                'OSV come seconda sorgente opzionale (Impostazioni → Fonti, disattivata per impostazione predefinita) con rilevamento di pacchetti dannosi, confrontata con il database pubblico OSV in una cache locale',
                'I risultati ora vengono uniti tra le sorgenti — una riga per vulnerabilità, ogni sorgente etichettata, la migliore correzione disponibile e l’unione dei percorsi di dipendenza, con un filtro per sorgente e un popover del percorso di dipendenza',
                'Rafforzamento della sicurezza: l’endpoint MCP è disattivato per impostazione predefinita e richiede un token, la consegna dei webhook è protetta da SSRF, un gate di accesso opzionale al portale, e il contenitore viene eseguito come utente senza privilegi',
                'Impostazioni è ora una sezione di primo livello con barra laterale e una pagina Profilo'
            ]
        },
        '1.4.0': {
            title: 'Integrazione MCP e novità',
            items: [
                'Server MCP su /api/mcp per Claude Desktop, Cursor e altri client',
                'Nuova sezione Impostazioni → MCP con URL del server e gestione dei token',
                'Badge delle novità e una cronologia delle note di rilascio'
            ]
        },
        '1.3.1': {
            title: 'Correzione della versione nel piè di pagina',
            items: ['La versione in esecuzione viene mostrata correttamente nel piè di pagina']
        },
        '1.3.0': {
            title: 'Miglioramenti alle notifiche',
            items: [
                'Filtra le notifiche per ambiente',
                'Modulo di modifica delle destinazioni più semplice',
                'Duplica una destinazione di notifica esistente'
            ]
        },
        '1.2.0': {
            title: 'Pagine Progetti e Librerie',
            items: ['La schermata iniziale è divisa in pagine dedicate Progetti e Librerie']
        },
        '1.1.2': {
            title: 'Ricaricamento della pianificazione in tempo reale',
            items: ['Il worker ricarica la pianificazione della scansione non appena salvi le modifiche nel portale']
        },
        '1.1.0': {
            title: 'Eliminazioni più sicure e un avviso di aggiornamento più chiaro',
            items: [
                'Conferma prima di eliminare radici e destinazioni di notifica',
                'L’avviso di aggiornamento diventa un banner superiore richiudibile',
                'Il worker rimuove le radici obsolete quando il loro mount scompare'
            ]
        },
        '1.0.1': {
            title: 'Correzioni di precisione dello scanner',
            items: [
                'Scarta i risultati la cui versione installata non è realmente nell’intervallo vulnerabile',
                'Consente di eliminare una destinazione di notifica con cronologia di invio'
            ]
        },
        '1.0.0': { title: 'Prima versione open source', items: ['La prima versione pubblica di Sentinello'] }
    },
    ja: {
        '3.0.0': {
            title: 'Sentinello はポータルなしでも動くようになりました',
            items: [
                'スキャナーが npm 上の CLI として提供されます。`npx sentinello` はフォルダーを走査して配下のすべてのプロジェクトを見つけ、npm audit・OSV・GitLab gemnasium と照合し、修正プロンプトを添えた markdown のアドバイザリを書き出します。インストール不要、アカウント不要、データベース不要で、コードがマシンの外に出ることもありません',
                'パイプで渡すと stdout にはアドバイザリだけが流れるため、`npx sentinello | claude -p "$(cat -)"` は文書を壊すことなく完全な作業リストをエージェントに渡せます',
                '初回実行でダウンロードを拒否されて gemnasium ソースを失うことがなくなりました。GitLab はアーカイブを 1〜2 分ほどまとめて拒否しますが、以前の再試行は 13 秒で諸めていました。CLI は待機して待ち、待っている理由を表示し、既定の 3 分が合わない場合は `--feed-wait` を受け付けます',
                'ダウンロード見積もりはどちらも推測ではなく実測しました。OSV の npm エクスポートは 196 MB ではなく 204 MB、gemnasium のアーカイブは 80 MB ではなく 52 MB と表示します。確認プロンプトは見積もりにチルダを付け、サーバーが報告したサイズと取り違えられないようにしています',
                'オプションのように見える値は、そのまま解釈せず拒否するようになりました。`--out --` は以前、プロジェクト内に `--` という名前のファイルへアドバイザリを書き出し、成功と報告していました',
                'リリースの内容が多いときに「新着情報」パネルがウィンドウ下部からはみ出さなくなりました'
            ]
        },
        '2.6.0': {
            title: 'アドバイザリ文書が実際に届くように — 集計も正確に',
            items: [
                'get_project_advisory が文書そのものを返すようになりました。これまで接続クライアントにはファイル名と件数などのメタデータだけが渡され、完全な作業リストと説明されていたにもかかわらず文書本体は届いていませんでした',
                'アドバイザリの書き出しが、スキャナーの行ごとではなくアドバイザリごとに 1 件へ統合されました。npm audit と OSV の両方が報告する脆弱性は、両方の ID を持つ 1 件の作業項目になります。ポータルの「.md をダウンロード」にも同じ変更が適用され、件数がダッシュボードと一致するようになりました',
                'MCP の 1 回の応答に収まらない大きなプロジェクトはページ分割されます。文書が未完であることを明示し、残りを取得するための正確な呼び出しを示すため、エージェントが残りを「問題なし」と誤読することがありません',
                'すべての MCP ツールのすべての入力に説明が付きました。また、unmute に必要なミュート ID を取得できる list_mutes ツールを追加しました（従来は同じセッションでミュートを作成した場合しか分かりませんでした）',
                '深刻度の集計の抜けを修正しました。既知の 5 段階以外の深刻度を持つ検出は、件数には数えられるのにどの区分にも入らず、その 1 件だけを持つプロジェクトが完全にクリーンに見えていました'
            ]
        },
        '2.5.0': {
            title: 'アドバイザリの書き出しを MCP から直接',
            items: [
                '接続済みの MCP クライアントは、新しい get_project_advisory ツールでプロジェクトの Markdown アドバイザリ全文を取得できます。ポータルの「.md をダウンロード」と同じ文書を、ブラウザからコピーせずに使えます',
                'ミュートした検出結果はプロジェクトのアドバイザリ書き出しに含まれなくなりました。すでにリスクを受け入れた項目がエージェントに渡ることはありません',
                '注意: アドバイザリには書き出しプロンプトが含まれるため、MCP クライアントは設定 → 書き出し に記入した内容を読み取れるようになりました'
            ]
        },
        '2.4.3': {
            title: '切れないポップアップと、より厳格な書き出しプロンプト',
            items: [
                'ドロップダウン、依存パスのポップオーバー、アドバイザリ書き出しメニューが、置かれているテーブルやダイアログに切り取られなくなりました。ページの上に重ねて描画され、下に余裕がない場合は上向きに開きます',
                'アドバイザリ書き出しの既定プロンプトが、何かを編集する前に計画を立てること、同じ修正でまとめて解消できる検出結果をグループ化すること、バージョン変更ごとのコードへの影響を明示することを求めるようになりました。目標はゼロ件ですが、ミュート・バージョン範囲の緩和・スキャン範囲の縮小といった見せかけのゼロへの近道は禁止し、本当に解消できないものは日付入りの残存項目テーブルに残します'
            ]
        },
        '2.4.2': {
            title: 'ブランチを独立した列に',
            items: [
                'プロジェクトをスキャンした git ブランチが、プロジェクト名の下ではなくプロジェクト一覧の独立した列に表示されるようになりました（アイコンなしのテキスト）'
            ]
        },
        '2.4.1': {
            title: 'クリーンな終了',
            items: [
                'コンテナを再起動しても、書き込み途中のスキャンが強制終了されなくなりました。ワーカーは約 30 秒間リトライすることなく、すぐに起動します',
                'compose ファイルに stop_grace_period: 60s（または --stop-timeout 60）を設定して余裕を持たせてください。README と Docker ドキュメントに説明を追加しました'
            ]
        },
        '2.4.0': {
            title: 'ポリグロット解析 — npm に Python・Go・Rust が加わりました',
            items: [
                'Sentinello が npm に加えて Python・Go・Rust のプロジェクトも解析するようになりました。ロックファイルは完全にオフラインで解決され、各プロジェクトが解析カバレッジ（完全・部分的・監査不可）を報告するため、抜け漏れが見えないまま残りません',
                'GitLab の gemnasium データベースが npm audit と OSV に並ぶオフラインのアドバイザリソースとして加わり、CVE/GHSA エイリアスで他ソースと重複排除されます。「設定 → ソース」は「言語 × ソース」のマトリクスになり、セルごとに通知範囲を設定でき、ソースが 1 つ以上有効であれば npm audit 自体も無効にできます',
                '検出結果に、それが得られた git ブランチが記録され、プロジェクト一覧・プロジェクトヘッダー・すべての通知に表示されます',
                'プロジェクトの各行に操作が用意されました。今すぐスキャン、アドバイザリのコピーまたはダウンロード、ミュートと解除、タグ編集ができ、トリアージのたびに各プロジェクトを開く必要がなくなりました',
                'プロジェクトダッシュボードが約 3.3 秒から約 0.03 秒になり、画面遷移では固まったように見える代わりにローディング表示が出るようになりました',
                'セキュリティ: 依存関係のアドバイザリ 25 件を解消しました。ポータルの画像最適化で実際に有効だった libvips の CVE や、配布されるポータルに影響する Next.js の 9 件を含みます',
                'アドバイザリ書き出しの既定プロンプトが、最小公開経過日数・ロックファイルの検証・古い override を扱うようになりました'
            ]
        },
        '2.3.0': {
            title: 'よりシンプルな MCP 設定 — 環境変数は不要',
            items: [
                'MCP の設定はすべて「設定 → MCP」で完結します。トークンを生成すると /api/mcp エンドポイントがオンになり、削除するとオフになります — SENTINELLO_MCP_ENABLED と SENTINELLO_MCP_API_TOKEN の環境変数は廃止されました（既存の環境変数トークンはアップグレード時に一度だけ取り込まれます）',
                'Claude Code、Codex、Cursor、Claude Desktop 向けの貼り付けるだけの接続スニペット。トークンが入力済みです',
                'SENTINELLO_PORTAL_BASE_URL を環境変数で設定している場合、優先され起動のたびに再適用されるため、「設定 → 詳細設定」では読み取り専用で表示されます'
            ]
        },
        '2.2.0': {
            title: '誤検知の低減と、自動で整理される検出結果',
            items: [
                'マルウェアのアドバイザリが、影響を受ける正確なバージョンと照合されるようになりました。かつて侵害されたパッケージでも、クリーンな、または修正済みのバージョンはもう検出されません',
                '重複した検出結果が次回のスキャンで自動的に解決され、古い項目や取り残された項目が自動でクリアされます',
                '本番（production）と開発（development）のラベルが、すべてのソース（npm と OSV）で一貫した単一の方法で算出されるようになりました'
            ]
        },
        '2.1.0': {
            title: 'すっきりしたプロジェクトヘッダーと一貫したフィルター',
            items: [
                'プロジェクトヘッダーを簡素化 — タイトルの横で名前を変更でき、ミュートとタグはアイコンに',
                '依存タイプフィルターの横の新しいドロップダウンから、ソース（npm / OSV）で検出結果を絞り込み',
                'アプリ全体でドロップダウンを統一し、タイムゾーンなどの長いリストでは入力して検索可能に'
            ]
        },
        '2.0.1': {
            title: 'よりわかりやすいアップグレード手順',
            items: [
                '2.0 の破壊的変更に関するアップグレード手順を拡充',
                'README に localhost のみのポートバインドを明記'
            ]
        },
        '2.0.0': {
            title: '複数ソースのスキャンと、デフォルトで安全な堅牢化されたインストール',
            items: [
                '任意の第2ソースとしての OSV（設定 → ソース、デフォルトはオフ）。悪意あるパッケージ検出を備え、ローカルキャッシュ内の公開 OSV データベースと照合します',
                '検出結果がソース間で統合されるようになりました。脆弱性ごとに1行で、各ソースをタグ付けし、利用可能な最良の修正と依存パスの和集合を示し、ソースフィルターと依存パスのポップオーバーを備えます',
                'セキュリティ強化: MCP エンドポイントはデフォルトでオフかつトークンが必要、Webhook 配信は SSRF から保護、任意のポータルログインゲート、コンテナは非特権ユーザーとして実行されます',
                '設定が、サイドバーとプロフィールページを備えたトップレベルのセクションになりました'
            ]
        },
        '1.4.0': {
            title: 'MCP 連携と新着情報',
            items: [
                'Claude Desktop、Cursor などのクライアント向けの /api/mcp の MCP サーバー',
                'サーバー URL とトークン管理を備えた新しい「設定 → MCP」セクション',
                '新着情報バッジとリリースノートの履歴'
            ]
        },
        '1.3.1': {
            title: 'フッターのバージョン表示の修正',
            items: ['実行中のバージョンがフッターに正しく表示されます']
        },
        '1.3.0': {
            title: '通知の改善',
            items: ['環境ごとに通知をフィルタリング', '通知先の編集フォームを簡素化', '既存の通知先を複製']
        },
        '1.2.0': {
            title: 'プロジェクトとライブラリのページ',
            items: ['ホーム画面が専用のプロジェクトページとライブラリページに分割されました']
        },
        '1.1.2': {
            title: 'スケジュールのライブ再読み込み',
            items: ['ポータルで変更を保存すると、ワーカーがスキャンスケジュールをすぐに再読み込みします']
        },
        '1.1.0': {
            title: 'より安全な削除と分かりやすい更新バナー',
            items: [
                'ルートと通知先を削除する前に確認',
                '更新のお知らせが画面上部の閉じられるバナーに変更',
                'ホストのマウントが消えると、ワーカーが古いルートを整理します'
            ]
        },
        '1.0.1': {
            title: 'スキャナーの精度修正',
            items: [
                'インストール済みバージョンが実際には脆弱な範囲にない検出結果を除外',
                '送信履歴のある通知先を削除できるように'
            ]
        },
        '1.0.0': { title: '初のオープンソースリリース', items: ['Sentinello の最初の一般公開リリース'] }
    },
    'zh-CN': {
        '3.0.0': {
            title: 'Sentinello 现在完全不用门户也能运行',
            items: [
                '扫描器以 CLI 形式发布到 npm。`npx sentinello` 会遍历一个文件夹，找出其下的每个项目，对照 npm audit、OSV 与 GitLab gemnasium 进行核查，并写出一份附带修复提示的 markdown 公告——无需安装、无需账号、无需数据库，你的代码也不会离开本机',
                '通过管道传递时，stdout 上只有公告，因此 `npx sentinello | claude -p "$(cat -)"` 能把一份完整的工作清单交给代理，而不会有任何东西破坏该文档',
                '首次运行不会再因下载被拒而丢掉 gemnasium 来源。GitLab 会一次拒绝其归档一到两分钟，而旧的重试十三秒就放弃了；现在 CLI 会等它过去、说明自己为何在等待，并在默认的三分钟不合适时接受 `--feed-wait`',
                '两个下载大小都是实测而非估猜：OSV 的 npm 导出标为 204 MB 而不是 196，gemnasium 归档标为 52 MB 而不是 80。确认提示会给估算值加上波浪号，以免被误认为服务器报告的大小',
                '看起来像选项的值现在会被拒绝，而不是照单全收——`--out --` 过去会在你的项目里写出一个名为 `--` 的文件并报告成功',
                '当某个版本内容较多时，“新变化”面板不会再溢出到窗口底部之外'
            ]
        },
        '2.6.0': {
            title: '公告文档真的送达了——而且计数与你的理解一致',
            items: [
                'get_project_advisory 现在返回公告文档本身。此前已连接的客户端只能拿到它的元数据——一个文件名和一个计数——始终拿不到文档，尽管该工具把它描述为一份完整的工作清单',
                '公告导出现在按不同公告各占一条、并合并其来源，而不再按扫描器行各占一条：npm audit 与 OSV 同时报告的同一个漏洞，是一个带上两个公告 ID 的工作项，而不是两条几乎相同的记录。这同样适用于门户的“下载 .md”，计数现在也与仪表盘一致',
                '大到无法放进单个 MCP 响应的项目现在会分页——文档会声明自身不完整，并给出获取其余内容的确切后续调用，而不是被静默截断、让代理把剩下的部分读成“干净”',
                '每个 MCP 工具的每个输入现在都带有描述，新增的 list_mutes 工具会公开 unmute 所需的静音 ID——此前只能通过在同一会话中创建静音才能拿到',
                '修复了严重程度计数的一个缺口：严重程度不属于五个已知取值的发现，会被计入发现总数却不落入任何严重程度分组，于是一个仅有该发现的项目看起来完全干净'
            ]
        },
        '2.5.0': {
            title: '通过 MCP 直接获取公告导出',
            items: [
                '已连接的 MCP 客户端可以用新的 get_project_advisory 工具获取项目的完整 Markdown 公告——与门户「下载 .md」按钮生成的文档相同，无需从浏览器复制',
                '被静音的问题不再包含在项目公告导出中，因此代理不会拿到你已经接受风险的工作',
                '注意：公告中包含你的导出提示词，因此 MCP 客户端现在可以读取你在「设置 → 导出」中写下的内容'
            ]
        },
        '2.4.3': {
            title: '不再被裁切的弹出层，以及更严格的导出提示词',
            items: [
                '下拉菜单、依赖路径弹出层和公告导出菜单不再被所处的表格或对话框裁切——它们绘制在页面之上，下方空间不足时会向上弹出',
                '默认的公告导出提示词现在要求代理在改动任何文件前先做计划、把可由同一处修复一并解决的发现归为一组，并说明每次版本变更对代码的具体影响；目标是零发现，同时明确排除通往虚假零值的捷径——静音、放宽版本范围或收窄扫描范围——真正无法解决的项则留在带日期的遗留事项表中'
            ]
        },
        '2.4.2': {
            title: '分支独立成列',
            items: ['扫描项目所用的 git 分支现在在项目列表中独占一列——纯文本、无图标——不再挤在项目名称下方']
        },
        '2.4.1': {
            title: '干净的关闭流程',
            items: [
                '重启容器不会再中断正在写入的扫描，worker 现在会立即启动，而不是先重试约 30 秒',
                '请在 compose 文件中设置 stop_grace_period: 60s（或 --stop-timeout 60）以留出时间——README 和 Docker 文档已补充说明'
            ]
        },
        '2.4.0': {
            title: '多语言扫描——Python、Go 和 Rust 加入 npm',
            items: [
                'Sentinello 现在除 npm 外还扫描 Python、Go 和 Rust 项目——锁文件完全离线解析，并且每个项目都会报告其扫描覆盖情况（完整、部分或无法审计），让盲区可见而不是悄然存在',
                'GitLab 的 gemnasium 数据库加入 npm audit 和 OSV，成为离线公告来源，并通过 CVE/GHSA 别名与其他来源去重；“设置 → 来源”现在是“语言 × 来源”矩阵，可按单元格设置通知范围，并且只要还有一个来源处于启用状态，npm audit 本身也可以关闭',
                '发现结果现在会记录其来源的 git 分支，并显示在项目列表、项目标题栏和每条通知中',
                '项目行自带操作——立即扫描、复制或下载公告、静音或取消静音、编辑标签——因此分诊时不必再逐个进入项目',
                '项目仪表盘从约 3.3 秒降至约 0.03 秒，页面切换现在会显示加载状态，而不是看起来卡住',
                '安全：修复 25 项依赖公告，包括门户图片优化器中真实存在的 libvips CVE，以及影响已发布门户的 9 项 Next.js 公告',
                '默认的公告导出提示词现在涵盖最短发布时长、锁文件校验和过期的 override'
            ]
        },
        '2.3.0': {
            title: '更简单的 MCP 设置——无需环境变量',
            items: [
                '现在完全在“设置 → MCP”中配置 MCP：生成令牌即可开启 /api/mcp 端点，清除令牌即可关闭——SENTINELLO_MCP_ENABLED 和 SENTINELLO_MCP_API_TOKEN 环境变量已移除（升级时会一次性导入已有的环境变量令牌）',
                '面向 Claude Code、Codex、Cursor 和 Claude Desktop 的即贴即用连接片段，已预填你的令牌',
                '当通过环境变量设置 SENTINELLO_PORTAL_BASE_URL 时，它会在“设置 → 高级”中以只读方式显示，因为它具有最高优先级并在每次启动时重新应用'
            ]
        },
        '2.2.0': {
            title: '更少的误报，以及会自我清理的检测结果',
            items: [
                '恶意软件公告现在会与确切的受影响版本进行比对——曾被入侵的包，其干净或已修复的版本不再被标记',
                '重复的检测结果现在会在下次扫描时自我解决，过期或遗留的条目会自动清除',
                '生产（production）和开发（development）标签现在在所有来源（npm 和 OSV）上以统一的单一方式计算'
            ]
        },
        '2.1.0': {
            title: '更简洁的项目页头与一致的筛选器',
            items: [
                '精简的项目页头——在标题旁直接重命名，静音和标签改为图标按钮',
                '在依赖类型筛选器旁新增下拉框，可按来源（npm / OSV）筛选发现',
                '全应用统一一致的下拉框，时区等长列表支持输入即搜索'
            ]
        },
        '2.0.1': {
            title: '更清晰的升级指引',
            items: ['扩充了 2.0 重大变更的升级步骤', 'README 说明了仅限本地（localhost）的端口绑定']
        },
        '2.0.0': {
            title: '多来源扫描，以及默认安全的加固安装',
            items: [
                '将 OSV 作为可选的第二来源（设置 → 来源，默认关闭），具备恶意软件包检测，并与本地缓存中的公开 OSV 数据库进行比对',
                '检测结果现在可跨来源合并——每个漏洞一行，标记每个来源、提供可用的最佳修复方案以及依赖路径的并集，并配有来源筛选和依赖路径弹出框',
                '安全加固：MCP 端点默认关闭并需要令牌，webhook 投递可防御 SSRF，可选的门户登录入口，容器以非特权用户身份运行',
                '“设置”现在是带侧边栏和个人资料页面的顶级板块'
            ]
        },
        '1.4.0': {
            title: 'MCP 集成与新功能',
            items: [
                '面向 Claude Desktop、Cursor 等客户端的 /api/mcp MCP 服务器',
                '全新的“设置 → MCP”板块，提供服务器 URL 和令牌管理',
                '新功能标记以及发行说明历史'
            ]
        },
        '1.3.1': { title: '页脚版本显示修复', items: ['运行中的版本在页脚正确显示'] },
        '1.3.0': { title: '通知改进', items: ['按环境筛选通知', '更简单的通知目标编辑表单', '复制现有的通知目标'] },
        '1.2.0': { title: '项目与库页面', items: ['主页拆分为独立的项目页面和库页面'] },
        '1.1.2': { title: '计划实时重载', items: ['在门户中保存更改后，worker 会立即重新加载扫描计划'] },
        '1.1.0': {
            title: '更安全的删除与更清晰的更新横幅',
            items: [
                '删除根目录和通知目标前进行确认',
                '更新提示改为可关闭的顶部横幅',
                '当主机挂载消失时，worker 会清理过期的根目录'
            ]
        },
        '1.0.1': {
            title: '扫描器准确性修复',
            items: ['丢弃已安装版本实际上不在易受攻击范围内的审计结果', '允许删除有发送历史的通知目标']
        },
        '1.0.0': { title: '首个开源版本', items: ['Sentinello 的首个公开发布版本'] }
    },
    ko: {
        '3.0.0': {
            title: '이제 포털 없이도 Sentinello를 쓸 수 있습니다',
            items: [
                '스캐너가 npm의 CLI로 제공됩니다. `npx sentinello`는 폴더를 흔어 그 아래 모든 프로젝트를 찾고 npm audit, OSV, GitLab gemnasium과 대조한 뒤 조치 프롬프트가 막부된 markdown 권고문을 작성합니다. 설치도 계정도 데이터베이스도 필요 없고, 코드가 머신 밖으로 나가지도 않습니다',
                '파이프로 넘기면 stdout에는 권고문만 흐르므로 `npx sentinello | claude -p "$(cat -)"`이 문서를 훼손하지 않고 완전한 작업 목록을 에이전트에 전달합니다',
                '첫 실행에서 다운로드가 거부되어 gemnasium 소스를 잃는 일이 없어졌습니다. GitLab은 아카이브를 한두 분씩 거부하는데 기존 재시도는 13초 만에 포기했습니다. 이제 CLI는 끝까지 기다리고, 기다리는 이유를 알려주며, 기본값 3분이 맞지 않으면 `--feed-wait`을 받습니다',
                '두 다운로드 예상치 모두 추측이 아니라 실측했습니다. OSV의 npm 익스포트는 196MB가 아닌 204MB로, gemnasium 아카이브는 80MB가 아닌 52MB로 표시됩니다. 동의 프롬프트는 추정치에 물결표를 붙여 서버가 알려준 크기와 혼동되지 않게 합니다',
                '옵션처럼 생긴 값은 이제 그대로 받아들이지 않고 거부합니다. `--out --`은 예전에 프로젝트 안에 `--`라는 이름의 파일로 권고문을 쓰고 성공했다고 알렸습니다',
                '릴리스에 담긴 내용이 많아도 새 소식 패널이 창 아래로 넘치지 않습니다'
            ]
        },
        '2.6.0': {
            title: '권고 문서가 실제로 도착합니다 — 집계도 정확하게',
            items: [
                'get_project_advisory가 이제 문서 자체를 반환합니다. 지금까지 연결된 클라이언트는 파일 이름과 건수 같은 메타데이터만 받았고, 전체 작업 목록이라고 설명된 문서 본문은 전달되지 않았습니다',
                '권고 내보내기가 스캐너 행 단위가 아니라 개별 권고 단위로 한 항목씩 묶입니다. npm audit과 OSV가 함께 보고하는 취약점은 두 개의 비슷한 항목이 아니라 두 권고 ID를 모두 담은 하나의 작업 항목이 됩니다. 포털의 .md 다운로드에도 동일하게 적용되며, 건수가 대시보드와 일치합니다',
                'MCP 응답 하나에 담기지 않는 큰 프로젝트는 이제 페이지로 나뉩니다. 문서가 불완전함을 밝히고 나머지를 가져올 정확한 호출을 알려주므로, 에이전트가 잘린 뒷부분을 깨끗한 것으로 잘못 읽지 않습니다',
                '모든 MCP 도구의 모든 입력에 설명이 붙었고, unmute에 필요한 뮤트 ID를 확인할 수 있는 list_mutes 도구가 추가되었습니다 — 이전에는 같은 세션에서 뮤트를 만든 경우에만 알 수 있었습니다',
                '심각도 집계의 허점을 고쳤습니다. 알려진 다섯 값에 없는 심각도를 가진 발견은 건수에는 포함되지만 어느 등급에도 들어가지 않아, 그 하나만 있는 프로젝트가 완전히 깨끗해 보였습니다'
            ]
        },
        '2.5.0': {
            title: 'MCP에서 바로 받는 권고 내보내기',
            items: [
                '연결된 MCP 클라이언트는 새 get_project_advisory 도구로 프로젝트의 전체 Markdown 권고 문서를 가져올 수 있습니다 — 포털의 「.md 다운로드」 버튼과 같은 문서를 브라우저에서 복사하지 않고 사용할 수 있습니다',
                '음소거한 발견 항목은 이제 프로젝트 권고 내보내기에서 제외되므로, 이미 위험을 수용한 작업이 에이전트에게 전달되지 않습니다',
                '참고: 권고 문서에는 내보내기 프롬프트가 포함되므로, 이제 MCP 클라이언트가 설정 → 내보내기에 작성한 내용을 읽을 수 있습니다'
            ]
        },
        '2.4.3': {
            title: '잘리지 않는 팝업과 더 엄격한 내보내기 프롬프트',
            items: [
                '드롭다운, 의존성 경로 팝오버, 권고 내보내기 메뉴가 자신이 놓인 표나 대화상자에 잘리지 않습니다. 페이지 위에 그려지고, 아래 공간이 부족하면 위쪽으로 펼쳐집니다',
                '기본 권고 내보내기 프롬프트가 이제 파일을 고치기 전에 먼저 계획하고, 같은 수정으로 함께 해결되는 발견 항목을 묶고, 버전 변경마다 코드에 미치는 영향을 구체적으로 밝히도록 요구합니다. 목표는 0건이지만 음소거, 버전 범위 완화, 스캔 범위 축소처럼 가짜 0건으로 가는 지름길은 금지하며, 정말로 해결할 수 없는 항목은 날짜가 적힌 잔여 항목 표에 남깁니다'
            ]
        },
        '2.4.2': {
            title: '브랜치를 별도 열로',
            items: [
                '프로젝트를 스캔한 git 브랜치가 프로젝트 이름 아래가 아니라 프로젝트 목록의 별도 열에 표시됩니다 — 아이콘 없는 일반 텍스트입니다'
            ]
        },
        '2.4.1': {
            title: '깔끔한 종료',
            items: [
                '컨테이너를 재시작해도 기록 중이던 스캔이 중단되지 않으며, 워커가 약 30초간 재시도하지 않고 곧바로 시작합니다',
                'compose 파일에 stop_grace_period: 60s(또는 --stop-timeout 60)를 설정해 여유를 주세요. README와 Docker 문서에 설명을 추가했습니다'
            ]
        },
        '2.4.0': {
            title: '다국어 스캔 — npm에 Python, Go, Rust가 합류했습니다',
            items: [
                'Sentinello가 npm과 함께 Python, Go, Rust 프로젝트도 스캔합니다. 잠금 파일은 완전히 오프라인으로 해석되며, 각 프로젝트가 스캔 커버리지(완전, 부분, 감사 불가)를 보고하므로 빈틈이 조용히 묻히지 않습니다',
                'GitLab의 gemnasium 데이터베이스가 npm audit, OSV와 함께 오프라인 권고 소스로 추가되어 CVE/GHSA 별칭으로 다른 소스와 중복이 제거됩니다. 설정 → 소스는 이제 언어 × 소스 행렬이며 셀별로 알림 범위를 지정할 수 있고, 소스가 하나라도 켜져 있으면 npm audit 자체도 끌 수 있습니다',
                '발견 항목에 어느 git 브랜치에서 나왔는지 기록되어 프로젝트 목록, 프로젝트 헤더, 모든 알림에 표시됩니다',
                '프로젝트 행에 자체 작업이 생겼습니다. 지금 스캔, 권고 복사 또는 다운로드, 음소거와 해제, 태그 편집을 바로 할 수 있어 분류 작업 때마다 프로젝트로 들어갈 필요가 없습니다',
                '프로젝트 대시보드가 약 3.3초에서 약 0.03초로 빨라졌고, 화면 전환 시 멈춘 것처럼 보이는 대신 로딩 상태가 표시됩니다',
                '보안: 의존성 권고 25건을 해결했습니다. 포털 이미지 최적화 경로에서 실제로 노출돼 있던 libvips CVE와 배포되는 포털에 영향을 주던 Next.js 권고 9건이 포함됩니다',
                '기본 권고 내보내기 프롬프트가 최소 배포 경과 기간, 잠금 파일 검증, 오래된 override를 다루도록 보강됐습니다'
            ]
        },
        '2.3.0': {
            title: '더 간단해진 MCP 설정 — 환경 변수 불필요',
            items: [
                '이제 MCP를 설정 → MCP에서 전부 구성합니다: 토큰을 생성하면 /api/mcp 엔드포인트가 켜지고, 지우면 꺼집니다 — SENTINELLO_MCP_ENABLED와 SENTINELLO_MCP_API_TOKEN 환경 변수는 제거되었습니다(기존 환경 변수 토큰은 업그레이드 시 한 번만 가져옵니다)',
                'Claude Code, Codex, Cursor, Claude Desktop용 붙여넣기만 하면 되는 연결 스니펫, 토큰이 미리 채워져 있습니다',
                '환경 변수로 SENTINELLO_PORTAL_BASE_URL을 설정하면 우선 적용되며 부팅할 때마다 다시 적용되므로 설정 → 고급에서 읽기 전용으로 표시됩니다'
            ]
        },
        '2.2.0': {
            title: '더 적은 오탐과 스스로 정리되는 발견 항목',
            items: [
                '악성코드 권고가 이제 정확히 영향받는 버전과 대조됩니다 — 한때 침해되었던 패키지라도 깨끗하거나 이미 수정된 버전은 더 이상 표시되지 않습니다',
                '중복된 발견 항목이 이제 다음 스캔에서 스스로 해결되어, 오래되었거나 남겨진 항목이 자동으로 정리됩니다',
                '프로덕션과 개발 라벨이 이제 모든 소스(npm 및 OSV)에서 일관된 단일 방식으로 계산됩니다'
            ]
        },
        '2.1.0': {
            title: '더 깔끔한 프로젝트 헤더와 일관된 필터',
            items: [
                '프로젝트 헤더 간소화 — 제목 옆에서 바로 이름 변경, 음소거와 태그는 아이콘으로',
                '의존성 유형 필터 옆의 새 드롭다운에서 소스(npm / OSV)별로 발견 항목 필터링',
                '앱 전반의 통일되고 일관된 드롭다운, 시간대 같은 긴 목록은 입력하여 검색 지원'
            ]
        },
        '2.0.1': {
            title: '더 명확한 업그레이드 안내',
            items: ['2.0 호환성 깨짐 변경에 대한 업그레이드 단계 보강', 'README에 localhost 전용 포트 바인딩 명시']
        },
        '2.0.0': {
            title: '다중 소스 스캔과 기본값으로 안전한 강화된 설치',
            items: [
                '선택적 두 번째 소스로서의 OSV(설정 → 소스, 기본값 꺼짐). 악성 패키지 탐지를 갖추고 로컬 캐시의 공개 OSV 데이터베이스와 대조합니다',
                '이제 검출 결과가 소스 간에 병합됩니다 — 취약점당 한 행으로, 각 소스를 태그하고 사용 가능한 최선의 수정과 의존성 경로의 합집합을 보여주며, 소스 필터와 의존성 경로 팝오버를 제공합니다',
                '보안 강화: MCP 엔드포인트는 기본적으로 꺼져 있고 토큰이 필요하며, 웹훅 전송은 SSRF로부터 보호되고, 선택적 포털 로그인 게이트가 있으며, 컨테이너는 비권한 사용자로 실행됩니다',
                '설정이 이제 사이드바와 프로필 페이지를 갖춘 최상위 섹션이 되었습니다'
            ]
        },
        '1.4.0': {
            title: 'MCP 연동 및 새로운 기능',
            items: [
                'Claude Desktop, Cursor 등 클라이언트를 위한 /api/mcp MCP 서버',
                '서버 URL과 토큰 관리를 갖춘 새로운 설정 → MCP 섹션',
                '새로운 기능 배지와 릴리스 노트 기록'
            ]
        },
        '1.3.1': { title: '푸터 버전 표시 수정', items: ['실행 중인 버전이 푸터에 깔끔하게 표시됩니다'] },
        '1.3.0': {
            title: '알림 개선',
            items: ['환경별로 알림 필터링', '더 간단해진 알림 대상 편집 양식', '기존 알림 대상 복제']
        },
        '1.2.0': {
            title: '프로젝트 및 라이브러리 페이지',
            items: ['홈 화면이 전용 프로젝트 페이지와 라이브러리 페이지로 분리되었습니다']
        },
        '1.1.2': {
            title: '일정 실시간 다시 로드',
            items: ['포털에서 변경 사항을 저장하면 워커가 즉시 스캔 일정을 다시 로드합니다']
        },
        '1.1.0': {
            title: '더 안전한 삭제와 더 명확한 업데이트 배너',
            items: [
                '루트와 알림 대상을 삭제하기 전에 확인',
                '업데이트 알림이 닫을 수 있는 상단 배너로 이동',
                '호스트 마운트가 사라지면 워커가 오래된 루트를 정리합니다'
            ]
        },
        '1.0.1': {
            title: '스캐너 정확도 수정',
            items: [
                '설치된 버전이 실제로 취약 범위에 없는 점검 결과 제외',
                '발송 기록이 있는 알림 대상을 삭제할 수 있도록 허용'
            ]
        },
        '1.0.0': { title: '첫 오픈 소스 릴리스', items: ['Sentinello의 첫 공개 릴리스'] }
    },
    ru: {
        '3.0.0': {
            title: 'Sentinello теперь работает вообще без портала',
            items: [
                'Сканеры выходят как CLI в npm. `npx sentinello` обходит папку, находит все проекты внутри, сверяет их с npm audit, OSV и GitLab gemnasium и пишет markdown-сводку с приложенным промптом по устранению — без установки, без аккаунта, без базы данных, и ничего из вашего кода не покидает машину',
                'В конвейере на stdout попадает только сводка, поэтому `npx sentinello | claude -p "$(cat -)"` передаёт агенту полный список работ, ничем не повредив документ',
                'Первый запуск больше не теряет источник gemnasium из-за отклонённой загрузки. GitLab отклоняет свой архив на минуту-две подряд, а прежние повторы сдавались через тринадцать секунд; теперь CLI дожидается окончания, объясняет, почему ждёт, и принимает `--feed-wait`, если три минуты по умолчанию вам не подходят',
                'Обе оценки размера загрузки измерены, а не угаданы: npm-экспорт OSV указан как 204 МБ вместо 196, а архив gemnasium — как 52 МБ вместо 80. В запросе подтверждения оценка помечается тильдой, чтобы её нельзя было принять за размер, сообщённый сервером',
                'Значение, похожее на флаг, теперь отклоняется, а не понимается буквально: `--out --` раньше писал сводку в файл с именем `--` внутри вашего проекта и рапортовал об успехе',
                'Панель «Что нового» больше не уходит за нижний край окна, когда в релизе много изменений'
            ]
        },
        '2.6.0': {
            title: 'Документ с рекомендациями действительно доходит — и считает верно',
            items: [
                'get_project_advisory теперь возвращает сам документ. Раньше подключённые клиенты получали только метаданные — имя файла и количество — но не документ, хотя инструмент описывал его как полный рабочий список',
                'Экспорт рекомендаций теперь содержит одну запись на каждую отдельную рекомендацию с объединёнными источниками, а не одну на строку сканера: уязвимость, о которой сообщают и npm audit, и OSV, становится единой рабочей задачей с обоими идентификаторами, а не двумя почти одинаковыми. Это касается и кнопки «Скачать .md» в портале, а количество теперь совпадает с панелью',
                'Проект, который не помещается в один ответ MCP, теперь разбивается на страницы: документ сообщает, что он неполный, и указывает точный следующий вызов для получения остального, вместо того чтобы молча обрываться там, где агент счёл бы остаток чистым',
                'У каждого параметра каждого инструмента MCP появилось описание, а новый инструмент list_mutes выдаёт идентификаторы отключений, нужные для unmute — раньше их можно было узнать, только создав отключение в той же сессии',
                'Исправлен пробел в подсчёте уровней риска: находка с уровнем вне пяти известных значений учитывалась как находка, но не попадала ни в одну категорию, поэтому проект с единственной такой находкой выглядел полностью чистым'
            ]
        },
        '2.5.0': {
            title: 'Экспорт рекомендаций прямо через MCP',
            items: [
                'Подключённые MCP-клиенты могут получить полный Markdown-отчёт проекта новым инструментом get_project_advisory — тот же документ, что и кнопка «Скачать .md» в портале, без копирования из браузера',
                'Заглушённые находки больше не попадают в экспорт рекомендаций проекта, поэтому агент никогда не получит работу, риск которой вы уже приняли',
                'Примечание: поскольку отчёт содержит ваш промпт экспорта, MCP-клиент теперь может прочитать то, что вы написали в Настройки → Экспорт'
            ]
        },
        '2.4.3': {
            title: 'Всплывающие панели без обрезки и более строгий промпт экспорта',
            items: [
                'Выпадающие списки, всплывающая панель пути зависимости и меню экспорта рекомендаций больше не обрезаются таблицей или диалогом, в котором они находятся, — они отрисовываются поверх страницы и раскрываются вверх, когда снизу не хватает места',
                'Стандартный промпт экспорта рекомендаций теперь требует от агента сначала составить план и только потом что-то править, группировать находки, закрывающиеся одним исправлением, и описывать влияние каждого изменения версии на код; цель — ноль находок, но обходные пути к фальшивому нулю запрещены: заглушение, расширение диапазонов или сужение области сканирования, а действительно нерешаемое попадает в датированную таблицу остатков'
            ]
        },
        '2.4.2': {
            title: 'Ветка в отдельной колонке',
            items: [
                'Ветка git, на которой сканировался проект, теперь занимает отдельную колонку в списке проектов — обычный текст, без иконки — вместо строки под названием проекта'
            ]
        },
        '2.4.1': {
            title: 'Корректное завершение работы',
            items: [
                'Перезапуск контейнера больше не обрывает сканирование на середине записи, а воркер запускается сразу, а не после ~30 секунд повторных попыток',
                'Задайте stop_grace_period: 60s (или --stop-timeout 60) в compose-файле, чтобы дать ему запас, — README и документация по Docker теперь это описывают'
            ]
        },
        '2.4.0': {
            title: 'Полиглотное сканирование — к npm добавились Python, Go и Rust',
            items: [
                'Sentinello теперь сканирует проекты на Python, Go и Rust наряду с npm — файлы блокировок разбираются полностью офлайн, а каждый проект сообщает своё покрытие сканирования (полное, частичное или непроверяемое), поэтому пробелы видны, а не остаются незамеченными',
                'База gemnasium от GitLab присоединяется к npm audit и OSV как офлайн-источник рекомендаций с дедупликацией по псевдонимам CVE/GHSA; раздел Настройки → Источники стал матрицей «Языки × Источники» с областью уведомлений для каждой ячейки, а сам npm audit теперь можно отключить, пока активен хотя бы один источник',
                'Находки теперь фиксируют ветку git, из которой они получены, — она видна в списке проектов, в заголовке проекта и в каждом уведомлении',
                'В строках проектов появились собственные действия — сканировать сейчас, скопировать или скачать рекомендацию, заглушить или снять заглушение и изменить теги, — поэтому для разбора больше не нужно заходить в каждый проект',
                'Панель проектов ускорилась с ~3,3 с до ~0,03 с, а при переходах теперь показываются состояния загрузки вместо подвисшей страницы',
                'Безопасность: устранено 25 рекомендаций по зависимостям, включая CVE в libvips, которые реально действовали в оптимизаторе изображений портала, и девять рекомендаций Next.js, затрагивавших поставляемый портал',
                'Стандартный промпт экспорта рекомендаций теперь учитывает минимальный возраст релиза, проверку файла блокировки и устаревшие override'
            ]
        },
        '2.3.0': {
            title: 'Более простая настройка MCP — без переменных окружения',
            items: [
                'Теперь MCP настраивается полностью в «Настройки → MCP»: сгенерируйте токен, чтобы включить эндпойнт /api/mcp, очистите его, чтобы выключить — переменные окружения SENTINELLO_MCP_ENABLED и SENTINELLO_MCP_API_TOKEN удалены (существующий токен из окружения импортируется один раз при обновлении)',
                'Готовые к вставке фрагменты подключения для Claude Code, Codex, Cursor и Claude Desktop, уже заполненные вашим токеном',
                'Когда SENTINELLO_PORTAL_BASE_URL задана в окружении, она отображается только для чтения в «Настройки → Дополнительно», поскольку остаётся приоритетной и повторно применяется при каждом запуске'
            ]
        },
        '2.2.0': {
            title: 'Меньше ложных срабатываний и самоочищающиеся находки',
            items: [
                'Оповещения о вредоносном ПО теперь сопоставляются с точной затронутой версией — чистая или уже исправленная версия некогда скомпрометированного пакета больше не помечается',
                'Дублирующиеся находки теперь устраняются сами при следующем сканировании, поэтому старые или осиротевшие записи удаляются автоматически',
                'Метки production и development теперь вычисляются единым согласованным способом по всем источникам (npm и OSV)'
            ]
        },
        '2.1.0': {
            title: 'Более чистый заголовок проекта и единообразные фильтры',
            items: [
                'Упрощённый заголовок проекта — переименование рядом с названием, отключение и теги в виде иконок',
                'Фильтрация находок по источнику (npm / OSV) через новый выпадающий список рядом с фильтром типа зависимости',
                'Единообразные выпадающие списки по всему приложению, с поиском по вводу для длинных списков, например часовых поясов'
            ]
        },
        '2.0.1': {
            title: 'Более понятные инструкции по обновлению',
            items: [
                'Расширенные шаги обновления для несовместимых изменений 2.0',
                'В README указана привязка порта только к localhost'
            ]
        },
        '2.0.0': {
            title: 'Сканирование из нескольких источников и усиленная, безопасная по умолчанию установка',
            items: [
                'OSV как необязательный второй источник (Настройки → Источники, по умолчанию выключено) с обнаружением вредоносных пакетов, сверяемый с публичной базой данных OSV в локальном кэше',
                'Результаты теперь объединяются между источниками — одна строка на уязвимость, каждый источник помечен, лучшее доступное исправление и объединение путей зависимостей, с фильтром по источнику и всплывающим окном пути зависимости',
                'Усиление безопасности: эндпойнт MCP по умолчанию выключен и требует токен, доставка вебхуков защищена от SSRF, необязательный вход в портал, и контейнер запускается от непривилегированного пользователя',
                'Настройки теперь — раздел верхнего уровня с боковой панелью и страницей профиля'
            ]
        },
        '1.4.0': {
            title: 'Интеграция MCP и новинки',
            items: [
                'MCP-сервер по адресу /api/mcp для Claude Desktop, Cursor и других клиентов',
                'Новый раздел «Настройки → MCP» с URL сервера и управлением токенами',
                'Значок новинок и история примечаний к выпускам'
            ]
        },
        '1.3.1': { title: 'Исправление версии в подвале', items: ['Текущая версия корректно отображается в подвале'] },
        '1.3.0': {
            title: 'Улучшения уведомлений',
            items: [
                'Фильтрация уведомлений по среде',
                'Более простая форма редактирования получателей',
                'Дублирование существующего получателя уведомлений'
            ]
        },
        '1.2.0': {
            title: 'Страницы проектов и библиотек',
            items: ['Главный экран разделён на отдельные страницы проектов и библиотек']
        },
        '1.1.2': {
            title: 'Живая перезагрузка расписания',
            items: ['Воркер перезагружает расписание сканирования сразу после сохранения изменений в портале']
        },
        '1.1.0': {
            title: 'Более безопасное удаление и понятный баннер обновления',
            items: [
                'Подтверждение перед удалением корней и получателей уведомлений',
                'Уведомление об обновлении перенесено в закрываемый баннер сверху',
                'Воркер удаляет устаревшие корни, когда их монтирование исчезает'
            ]
        },
        '1.0.1': {
            title: 'Исправления точности сканера',
            items: [
                'Отбрасывает результаты, чья установленная версия фактически не входит в уязвимый диапазон',
                'Позволяет удалить получателя уведомлений с историей отправок'
            ]
        },
        '1.0.0': { title: 'Первый релиз с открытым исходным кодом', items: ['Первый публичный выпуск Sentinello'] }
    }
}

export function getReleases(): ReleaseEntry[] {
    return RELEASES
}

export function getLatestRelease(): ReleaseEntry | null {
    return RELEASES[0] || null
}

export function getReleaseFor(version: string): ReleaseEntry | null {
    const bare = stripVPrefix(version)
    return (
        RELEASES.find(function match(entry) {
            return entry.version === bare
        }) || null
    )
}

// Falls back to English when a locale is missing an entry (unlike next-intl’s hard error).
export function getReleaseCopy(locale: Locale, version: string): ReleaseCopy | null {
    const byLocale = RELEASE_COPY[locale] || RELEASE_COPY.en
    return byLocale[version] || RELEASE_COPY.en[version] || null
}
