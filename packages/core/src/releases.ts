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
    return value.startsWith('v') && value.slice(1) || value
}

// Newest first. The locale-independent version index. Adding a release = one entry here plus a
// RELEASE_COPY entry in every locale below. See CLAUDE.md for the release-please version-sync flow.
export const RELEASES: ReleaseEntry[] = [
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
        '2.3.0': { title: 'Simpler MCP setup — no environment variables', items: ['Set up MCP entirely in Settings → MCP: generate a token to turn the /api/mcp endpoint on, clear it to turn it off — the SENTINELLO_MCP_ENABLED and SENTINELLO_MCP_API_TOKEN environment variables are gone (an existing env token is imported once on upgrade)', 'Ready-to-paste connection snippets for Claude Code, Codex, Cursor, and Claude Desktop, pre-filled with your token', 'When SENTINELLO_PORTAL_BASE_URL is set in the environment it’s shown read-only in Settings → Advanced, since it stays authoritative and is re-applied on every boot'] },
        '2.2.0': { title: 'Fewer false alarms and self-cleaning findings', items: ['Malware advisories now match the exact compromised version — a clean or already-remediated version of a once-compromised package is no longer flagged', 'Duplicate findings now resolve themselves on the next scan, so old or stranded entries clear out automatically', 'Production and development labels are now computed one consistent way across every source (npm and OSV)'] },
        '2.1.0': { title: 'A cleaner project header and consistent filters', items: ['Streamlined the project header — rename inline beside the title, with mute and tags as one-tap icons', 'Filter findings by source (npm / OSV) from a new dropdown beside the dependency-type filter', 'Unified, consistent dropdowns across the app, with type-to-search on long lists like time zones'] },
        '2.0.1': { title: 'Clearer upgrade guidance', items: ['Expanded upgrade steps for the 2.0 breaking changes', 'README notes the localhost-only port binding'] },
        '2.0.0': { title: 'Multi-source scanning and a hardened, secure-by-default install', items: ['OSV as an opt-in second source (Settings → Sources, off by default) with malicious-package detection, matched against the public OSV database in a local cache', 'Findings now merge across sources — one row per vulnerability, every source tagged, the best available fix, and the union of dependency paths, with a source filter and a dependency-path popover', 'Security hardening: the MCP endpoint is off by default and requires a token, webhook delivery is guarded against SSRF, an optional portal login gate, and the container runs as an unprivileged user', 'Settings is now a top-level section with a sidebar and a Profile page'] },
        '1.4.0': { title: 'MCP integration & what’s-new', items: ['MCP server at /api/mcp for Claude Desktop, Cursor, and other clients', 'New Settings → MCP section with server URL and token management', 'What’s-new pill plus a Release notes history'] },
        '1.3.1': { title: 'Footer version fix', items: ['The running version renders cleanly in the footer'] },
        '1.3.0': { title: 'Notification improvements', items: ['Filter notifications by environment', 'Simpler notification-target edit form', 'Duplicate an existing notification target'] },
        '1.2.0': { title: 'Projects and Libraries pages', items: ['The home view is split into dedicated Projects and Libraries pages'] },
        '1.1.2': { title: 'Live schedule reload', items: ['The worker reloads the scan schedule the moment you save changes in the portal'] },
        '1.1.0': { title: 'Safer deletes & a clearer update banner', items: ['Confirmation prompts before deleting roots and notification targets', 'Update notice moved to a dismissible top banner', 'Worker prunes stale roots when a host mount disappears'] },
        '1.0.1': { title: 'Scanner accuracy fixes', items: ['Drop audit findings whose installed version isn’t actually in the vulnerable range', 'Allow deleting a notification target that has delivery history'] },
        '1.0.0': { title: 'Initial open-source release', items: ['The first public release of Sentinello'] }
    },
    es: {
        '2.3.0': { title: 'Configuración de MCP más simple, sin variables de entorno', items: ['Configura MCP por completo en Configuración → MCP: genera un token para activar el endpoint /api/mcp y bórralo para desactivarlo — las variables de entorno SENTINELLO_MCP_ENABLED y SENTINELLO_MCP_API_TOKEN ya no existen (un token de entorno existente se importa una vez al actualizar)', 'Fragmentos de conexión listos para pegar para Claude Code, Codex, Cursor y Claude Desktop, con tu token ya incluido', 'Cuando SENTINELLO_PORTAL_BASE_URL se define en el entorno, se muestra de solo lectura en Configuración → Avanzado, ya que sigue siendo autoritativa y se reaplica en cada arranque'] },
        '2.2.0': { title: 'Menos falsas alarmas y hallazgos que se limpian solos', items: ['Los avisos de malware ahora coinciden con la versión comprometida exacta: una versión limpia o ya corregida de un paquete que estuvo comprometido deja de marcarse', 'Los hallazgos duplicados ahora se resuelven solos en el siguiente análisis, de modo que las entradas antiguas o huérfanas se eliminan automáticamente', 'Las etiquetas de producción y desarrollo ahora se calculan de una sola forma coherente en todas las fuentes (npm y OSV)'] },
        '2.1.0': { title: 'Un encabezado de proyecto más limpio y filtros coherentes', items: ['Encabezado de proyecto simplificado: renombra junto al título, con silenciar y etiquetas como iconos', 'Filtra los hallazgos por fuente (npm / OSV) desde un nuevo desplegable junto al filtro de tipo de dependencia', 'Desplegables unificados y coherentes en toda la app, con búsqueda al escribir en listas largas como las zonas horarias'] },
        '2.0.1': { title: 'Guía de actualización más clara', items: ['Pasos de actualización ampliados para los cambios incompatibles de 2.0', 'El README indica el enlace de puerto solo en localhost'] },
        '2.0.0': { title: 'Análisis multi-fuente y una instalación reforzada y segura por defecto', items: ['OSV como segunda fuente opcional (Configuración → Fuentes, desactivada por defecto) con detección de paquetes maliciosos, cotejada con la base de datos pública de OSV en una caché local', 'Los hallazgos ahora se combinan entre fuentes: una fila por vulnerabilidad, con cada fuente etiquetada, la mejor corrección disponible y la unión de las rutas de dependencia, con filtro por fuente y un popover de ruta de dependencia', 'Refuerzo de seguridad: el endpoint MCP está desactivado por defecto y requiere un token, la entrega de webhooks está protegida contra SSRF, una puerta de inicio de sesión opcional del portal, y el contenedor se ejecuta como usuario sin privilegios', 'Configuración ahora es una sección de nivel superior con barra lateral y una página de Perfil'] },
        '1.4.0': { title: 'Integración MCP y novedades', items: ['Servidor MCP en /api/mcp para Claude Desktop, Cursor y otros clientes', 'Nueva sección Configuración → MCP con URL del servidor y gestión de tokens', 'Píldora de novedades e historial de notas de versión'] },
        '1.3.1': { title: 'Corrección de la versión en el pie', items: ['La versión en ejecución se muestra correctamente en el pie de página'] },
        '1.3.0': { title: 'Mejoras en las notificaciones', items: ['Filtrar notificaciones por entorno', 'Formulario de edición de destinos más simple', 'Duplicar un destino de notificación existente'] },
        '1.2.0': { title: 'Páginas de Proyectos y Bibliotecas', items: ['La vista de inicio se divide en páginas dedicadas de Proyectos y Bibliotecas'] },
        '1.1.2': { title: 'Recarga de la programación en vivo', items: ['El worker recarga la programación de escaneo en cuanto guardas cambios en el portal'] },
        '1.1.0': { title: 'Borrados más seguros y un aviso de actualización más claro', items: ['Confirmación antes de eliminar raíces y destinos de notificación', 'El aviso de actualización pasa a un banner superior descartable', 'El worker elimina raíces obsoletas cuando desaparece su montaje'] },
        '1.0.1': { title: 'Correcciones de precisión del escáner', items: ['Descarta hallazgos cuya versión instalada no está realmente en el rango vulnerable', 'Permite eliminar un destino de notificación con historial de envíos'] },
        '1.0.0': { title: 'Primera versión de código abierto', items: ['El primer lanzamiento público de Sentinello'] }
    },
    fr: {
        '2.3.0': { title: 'Configuration MCP simplifiée, sans variables d’environnement', items: ['Configurez MCP entièrement dans Paramètres → MCP : générez un jeton pour activer le point de terminaison /api/mcp, effacez-le pour le désactiver — les variables d’environnement SENTINELLO_MCP_ENABLED et SENTINELLO_MCP_API_TOKEN ont disparu (un jeton d’environnement existant est importé une fois lors de la mise à niveau)', 'Extraits de connexion prêts à coller pour Claude Code, Codex, Cursor et Claude Desktop, pré-remplis avec votre jeton', 'Lorsque SENTINELLO_PORTAL_BASE_URL est définie dans l’environnement, elle s’affiche en lecture seule dans Paramètres → Avancé, car elle reste prioritaire et est réappliquée à chaque démarrage'] },
        '2.2.0': { title: 'Moins de fausses alertes et des résultats qui se nettoient seuls', items: ['Les avis de malware correspondent désormais à la version compromise exacte — une version saine ou déjà corrigée d’un paquet autrefois compromis n’est plus signalée', 'Les résultats en double se résolvent désormais d’eux-mêmes au prochain scan, si bien que les entrées anciennes ou orphelines disparaissent automatiquement', 'Les étiquettes production et développement sont désormais calculées d’une seule façon cohérente pour toutes les sources (npm et OSV)'] },
        '2.1.0': { title: 'Un en-tête de projet plus épuré et des filtres cohérents', items: ['En-tête de projet simplifié — renommez à côté du titre, avec la mise en sourdine et les tags en icônes', 'Filtrez les résultats par source (npm / OSV) depuis un nouveau menu déroulant à côté du filtre de type de dépendance', 'Menus déroulants unifiés et cohérents dans toute l’application, avec recherche instantanée sur les longues listes comme les fuseaux horaires'] },
        '2.0.1': { title: 'Conseils de mise à niveau plus clairs', items: ['Étapes de mise à niveau détaillées pour les changements incompatibles de la 2.0', 'Le README indique la liaison du port en localhost uniquement'] },
        '2.0.0': { title: 'Analyse multi-source et une installation renforcée, sécurisée par défaut', items: ['OSV comme deuxième source optionnelle (Paramètres → Sources, désactivée par défaut) avec détection des paquets malveillants, comparée à la base de données publique OSV dans un cache local', 'Les résultats sont désormais fusionnés entre sources — une ligne par vulnérabilité, chaque source étiquetée, le meilleur correctif disponible et l’union des chemins de dépendances, avec un filtre par source et une infobulle de chemin de dépendance', 'Renforcement de la sécurité : le point de terminaison MCP est désactivé par défaut et requiert un jeton, la livraison des webhooks est protégée contre le SSRF, une page de connexion optionnelle au portail, et le conteneur s’exécute en utilisateur non privilégié', 'Les Paramètres forment désormais une section de premier niveau avec une barre latérale et une page Profil'] },
        '1.4.0': { title: 'Intégration MCP et nouveautés', items: ['Serveur MCP sur /api/mcp pour Claude Desktop, Cursor et d’autres clients', 'Nouvelle section Paramètres → MCP avec URL du serveur et gestion des jetons', 'Pastille de nouveautés et historique des notes de version'] },
        '1.3.1': { title: 'Correction de la version dans le pied de page', items: ['La version en cours s’affiche correctement dans le pied de page'] },
        '1.3.0': { title: 'Améliorations des notifications', items: ['Filtrer les notifications par environnement', 'Formulaire d’édition des cibles simplifié', 'Dupliquer une cible de notification existante'] },
        '1.2.0': { title: 'Pages Projets et Bibliothèques', items: ['La vue d’accueil est divisée en pages Projets et Bibliothèques dédiées'] },
        '1.1.2': { title: 'Rechargement du planning en direct', items: ['Le worker recharge le planning d’analyse dès que vous enregistrez des modifications dans le portail'] },
        '1.1.0': { title: 'Suppressions plus sûres et bannière de mise à jour plus claire', items: ['Confirmation avant la suppression de racines et de cibles de notification', 'L’avis de mise à jour devient une bannière supérieure que l’on peut fermer', 'Le worker supprime les racines obsolètes quand leur montage disparaît'] },
        '1.0.1': { title: 'Corrections de précision du scanner', items: ['Écarte les résultats dont la version installée n’est pas réellement dans la plage vulnérable', 'Permet de supprimer une cible de notification ayant un historique d’envois'] },
        '1.0.0': { title: 'Première version open source', items: ['La première version publique de Sentinello'] }
    },
    de: {
        '2.3.0': { title: 'Einfachere MCP-Einrichtung — ohne Umgebungsvariablen', items: ['MCP wird jetzt vollständig unter Einstellungen → MCP eingerichtet: Token generieren, um den Endpunkt /api/mcp einzuschalten, löschen, um ihn auszuschalten — die Umgebungsvariablen SENTINELLO_MCP_ENABLED und SENTINELLO_MCP_API_TOKEN entfallen (ein vorhandenes Umgebungs-Token wird beim Upgrade einmalig importiert)', 'Fertige Verbindungs-Snippets zum Einfügen für Claude Code, Codex, Cursor und Claude Desktop, bereits mit deinem Token ausgefüllt', 'Wenn SENTINELLO_PORTAL_BASE_URL in der Umgebung gesetzt ist, wird sie unter Einstellungen → Erweitert schreibgeschützt angezeigt, da sie maßgeblich bleibt und bei jedem Start erneut angewendet wird'] },
        '2.2.0': { title: 'Weniger Fehlalarme und selbstbereinigende Funde', items: ['Malware-Hinweise stimmen jetzt mit der genau betroffenen Version überein — eine saubere oder bereits behobene Version eines einst kompromittierten Pakets wird nicht mehr markiert', 'Doppelte Funde lösen sich jetzt beim nächsten Scan von selbst auf, sodass alte oder verwaiste Einträge automatisch verschwinden', 'Produktions- und Entwicklungs-Kennzeichnungen werden jetzt über alle Quellen (npm und OSV) auf eine einheitliche Weise berechnet'] },
        '2.1.0': { title: 'Ein aufgeräumter Projekt-Header und einheitliche Filter', items: ['Verschlankter Projekt-Header — Umbenennen direkt neben dem Titel, Stummschalten und Tags als Icon-Buttons', 'Funde nach Quelle filtern (npm / OSV) über ein neues Dropdown neben dem Abhängigkeitstyp-Filter', 'Einheitliche Dropdowns in der gesamten App, mit Tippsuche für lange Listen wie Zeitzonen'] },
        '2.0.1': { title: 'Klarere Upgrade-Hinweise', items: ['Erweiterte Upgrade-Schritte für die Breaking Changes von 2.0', 'Die README weist auf die nur-localhost-Portbindung hin'] },
        '2.0.0': { title: 'Multi-Quellen-Scan und eine gehärtete, standardmäßig sichere Installation', items: ['OSV als optionale zweite Quelle (Einstellungen → Quellen, standardmäßig aus) mit Erkennung schädlicher Pakete, abgeglichen mit der öffentlichen OSV-Datenbank in einem lokalen Cache', 'Funde werden jetzt quellenübergreifend zusammengeführt — eine Zeile pro Schwachstelle, jede Quelle markiert, der beste verfügbare Fix und die Vereinigung der Abhängigkeitspfade, mit Quellenfilter und einem Abhängigkeitspfad-Popover', 'Sicherheitshärtung: der MCP-Endpunkt ist standardmäßig aus und erfordert ein Token, die Webhook-Zustellung ist gegen SSRF abgesichert, ein optionales Portal-Login, und der Container läuft als unprivilegierter Benutzer', 'Einstellungen sind jetzt ein Bereich der obersten Ebene mit Seitenleiste und einer Profilseite'] },
        '1.4.0': { title: 'MCP-Integration & Neuigkeiten', items: ['MCP-Server unter /api/mcp für Claude Desktop, Cursor und andere Clients', 'Neuer Bereich Einstellungen → MCP mit Server-URL und Token-Verwaltung', 'Neuigkeiten-Symbol und ein Verlauf der Versionshinweise'] },
        '1.3.1': { title: 'Korrektur der Version in der Fußzeile', items: ['Die laufende Version wird in der Fußzeile sauber dargestellt'] },
        '1.3.0': { title: 'Verbesserungen bei Benachrichtigungen', items: ['Benachrichtigungen nach Umgebung filtern', 'Einfacheres Formular zum Bearbeiten von Zielen', 'Ein vorhandenes Benachrichtigungsziel duplizieren'] },
        '1.2.0': { title: 'Seiten für Projekte und Bibliotheken', items: ['Die Startansicht ist in eigene Seiten für Projekte und Bibliotheken aufgeteilt'] },
        '1.1.2': { title: 'Live-Neuladen des Zeitplans', items: ['Der Worker lädt den Scan-Zeitplan neu, sobald du Änderungen im Portal speicherst'] },
        '1.1.0': { title: 'Sichereres Löschen & ein klareres Update-Banner', items: ['Bestätigung vor dem Löschen von Roots und Benachrichtigungszielen', 'Update-Hinweis als schließbares Banner oben', 'Der Worker entfernt veraltete Roots, wenn ihr Host-Mount verschwindet'] },
        '1.0.1': { title: 'Korrekturen der Scanner-Genauigkeit', items: ['Verwirft Funde, deren installierte Version nicht wirklich im verwundbaren Bereich liegt', 'Ermöglicht das Löschen eines Benachrichtigungsziels mit Versandverlauf'] },
        '1.0.0': { title: 'Erste Open-Source-Version', items: ['Die erste öffentliche Veröffentlichung von Sentinello'] }
    },
    'pt-BR': {
        '2.3.0': { title: 'Configuração de MCP mais simples, sem variáveis de ambiente', items: ['Configure o MCP inteiramente em Configurações → MCP: gere um token para ativar o endpoint /api/mcp e limpe-o para desativá-lo — as variáveis de ambiente SENTINELLO_MCP_ENABLED e SENTINELLO_MCP_API_TOKEN foram removidas (um token de ambiente existente é importado uma vez na atualização)', 'Trechos de conexão prontos para colar para Claude Code, Codex, Cursor e Claude Desktop, já preenchidos com o seu token', 'Quando SENTINELLO_PORTAL_BASE_URL é definida no ambiente, ela aparece como somente leitura em Configurações → Avançado, pois continua sendo autoritativa e é reaplicada a cada inicialização'] },
        '2.2.0': { title: 'Menos alarmes falsos e achados que se limpam sozinhos', items: ['Os avisos de malware agora correspondem à versão comprometida exata — uma versão limpa ou já corrigida de um pacote que esteve comprometido deixa de ser sinalizada', 'Achados duplicados agora se resolvem sozinhos na próxima varredura, de modo que entradas antigas ou órfãs são removidas automaticamente', 'Os rótulos de produção e desenvolvimento agora são calculados de uma única forma consistente em todas as fontes (npm e OSV)'] },
        '2.1.0': { title: 'Um cabeçalho de projeto mais limpo e filtros consistentes', items: ['Cabeçalho de projeto simplificado — renomeie ao lado do título, com silenciar e tags como ícones', 'Filtre as ocorrências por fonte (npm / OSV) em um novo menu suspenso ao lado do filtro de tipo de dependência', 'Menus suspensos unificados e consistentes em todo o app, com busca ao digitar em listas longas como fusos horários'] },
        '2.0.1': { title: 'Orientações de atualização mais claras', items: ['Passos de atualização ampliados para as alterações incompatíveis da 2.0', 'O README indica a vinculação de porta somente em localhost'] },
        '2.0.0': { title: 'Varredura multi-fonte e uma instalação reforçada e segura por padrão', items: ['OSV como segunda fonte opcional (Configurações → Fontes, desativada por padrão) com detecção de pacotes maliciosos, comparada com o banco de dados público do OSV em um cache local', 'Os achados agora são mesclados entre fontes — uma linha por vulnerabilidade, cada fonte marcada, a melhor correção disponível e a união dos caminhos de dependência, com filtro por fonte e um popover de caminho de dependência', 'Reforço de segurança: o endpoint MCP está desativado por padrão e exige um token, a entrega de webhooks é protegida contra SSRF, uma porta de login opcional do portal, e o contêiner é executado como usuário sem privilégios', 'Configurações agora é uma seção de nível superior com barra lateral e uma página de Perfil'] },
        '1.4.0': { title: 'Integração MCP e novidades', items: ['Servidor MCP em /api/mcp para Claude Desktop, Cursor e outros clientes', 'Nova seção Configurações → MCP com URL do servidor e gerenciamento de tokens', 'Etiqueta de novidades e um histórico de notas de versão'] },
        '1.3.1': { title: 'Correção da versão no rodapé', items: ['A versão em execução é exibida corretamente no rodapé'] },
        '1.3.0': { title: 'Melhorias nas notificações', items: ['Filtrar notificações por ambiente', 'Formulário de edição de destinos mais simples', 'Duplicar um destino de notificação existente'] },
        '1.2.0': { title: 'Páginas de Projetos e Bibliotecas', items: ['A tela inicial é dividida em páginas dedicadas de Projetos e Bibliotecas'] },
        '1.1.2': { title: 'Recarregamento da agenda em tempo real', items: ['O worker recarrega a agenda de varredura assim que você salva alterações no portal'] },
        '1.1.0': { title: 'Exclusões mais seguras e um aviso de atualização mais claro', items: ['Confirmação antes de excluir raízes e destinos de notificação', 'Aviso de atualização movido para um banner superior dispensável', 'O worker remove raízes obsoletas quando o ponto de montagem desaparece'] },
        '1.0.1': { title: 'Correções de precisão do scanner', items: ['Descarta achados cuja versão instalada não está realmente na faixa vulnerável', 'Permite excluir um destino de notificação com histórico de envios'] },
        '1.0.0': { title: 'Primeira versão de código aberto', items: ['O primeiro lançamento público do Sentinello'] }
    },
    it: {
        '2.3.0': { title: 'Configurazione MCP più semplice, senza variabili d’ambiente', items: ['Configura MCP interamente in Impostazioni → MCP: genera un token per attivare l’endpoint /api/mcp, cancellalo per disattivarlo — le variabili d’ambiente SENTINELLO_MCP_ENABLED e SENTINELLO_MCP_API_TOKEN non esistono più (un token d’ambiente esistente viene importato una volta durante l’aggiornamento)', 'Frammenti di connessione pronti da incollare per Claude Code, Codex, Cursor e Claude Desktop, già compilati con il tuo token', 'Quando SENTINELLO_PORTAL_BASE_URL è impostata nell’ambiente, viene mostrata in sola lettura in Impostazioni → Avanzate, poiché resta autoritativa e viene riapplicata a ogni avvio'] },
        '2.2.0': { title: 'Meno falsi allarmi e risultati che si ripuliscono da soli', items: ['Gli avvisi di malware ora corrispondono alla versione compromessa esatta — una versione pulita o già corretta di un pacchetto un tempo compromesso non viene più segnalata', 'I risultati duplicati ora si risolvono da soli alla scansione successiva, così le voci vecchie o orfane vengono eliminate automaticamente', 'Le etichette di produzione e sviluppo ora vengono calcolate in un unico modo coerente su tutte le sorgenti (npm e OSV)'] },
        '2.1.0': { title: 'Un’intestazione di progetto più pulita e filtri coerenti', items: ['Intestazione di progetto semplificata — rinomina accanto al titolo, con silenzia e tag come icone', 'Filtra i risultati per fonte (npm / OSV) da un nuovo menu a discesa accanto al filtro per tipo di dipendenza', 'Menu a discesa unificati e coerenti in tutta l’app, con ricerca durante la digitazione per elenchi lunghi come i fusi orari'] },
        '2.0.1': { title: 'Indicazioni di aggiornamento più chiare', items: ['Passaggi di aggiornamento ampliati per le modifiche incompatibili della 2.0', 'Il README segnala il binding della porta solo su localhost'] },
        '2.0.0': { title: 'Scansione multi-sorgente e un’installazione rafforzata e sicura per impostazione predefinita', items: ['OSV come seconda sorgente opzionale (Impostazioni → Fonti, disattivata per impostazione predefinita) con rilevamento di pacchetti dannosi, confrontata con il database pubblico OSV in una cache locale', 'I risultati ora vengono uniti tra le sorgenti — una riga per vulnerabilità, ogni sorgente etichettata, la migliore correzione disponibile e l’unione dei percorsi di dipendenza, con un filtro per sorgente e un popover del percorso di dipendenza', 'Rafforzamento della sicurezza: l’endpoint MCP è disattivato per impostazione predefinita e richiede un token, la consegna dei webhook è protetta da SSRF, un gate di accesso opzionale al portale, e il contenitore viene eseguito come utente senza privilegi', 'Impostazioni è ora una sezione di primo livello con barra laterale e una pagina Profilo'] },
        '1.4.0': { title: 'Integrazione MCP e novità', items: ['Server MCP su /api/mcp per Claude Desktop, Cursor e altri client', 'Nuova sezione Impostazioni → MCP con URL del server e gestione dei token', 'Badge delle novità e una cronologia delle note di rilascio'] },
        '1.3.1': { title: 'Correzione della versione nel piè di pagina', items: ['La versione in esecuzione viene mostrata correttamente nel piè di pagina'] },
        '1.3.0': { title: 'Miglioramenti alle notifiche', items: ['Filtra le notifiche per ambiente', 'Modulo di modifica delle destinazioni più semplice', 'Duplica una destinazione di notifica esistente'] },
        '1.2.0': { title: 'Pagine Progetti e Librerie', items: ['La schermata iniziale è divisa in pagine dedicate Progetti e Librerie'] },
        '1.1.2': { title: 'Ricaricamento della pianificazione in tempo reale', items: ['Il worker ricarica la pianificazione della scansione non appena salvi le modifiche nel portale'] },
        '1.1.0': { title: 'Eliminazioni più sicure e un avviso di aggiornamento più chiaro', items: ['Conferma prima di eliminare radici e destinazioni di notifica', 'L’avviso di aggiornamento diventa un banner superiore richiudibile', 'Il worker rimuove le radici obsolete quando il loro mount scompare'] },
        '1.0.1': { title: 'Correzioni di precisione dello scanner', items: ['Scarta i risultati la cui versione installata non è realmente nell’intervallo vulnerabile', 'Consente di eliminare una destinazione di notifica con cronologia di invio'] },
        '1.0.0': { title: 'Prima versione open source', items: ['La prima versione pubblica di Sentinello'] }
    },
    ja: {
        '2.3.0': { title: 'よりシンプルな MCP 設定 — 環境変数は不要', items: ['MCP の設定はすべて「設定 → MCP」で完結します。トークンを生成すると /api/mcp エンドポイントがオンになり、削除するとオフになります — SENTINELLO_MCP_ENABLED と SENTINELLO_MCP_API_TOKEN の環境変数は廃止されました（既存の環境変数トークンはアップグレード時に一度だけ取り込まれます）', 'Claude Code、Codex、Cursor、Claude Desktop 向けの貼り付けるだけの接続スニペット。トークンが入力済みです', 'SENTINELLO_PORTAL_BASE_URL を環境変数で設定している場合、優先され起動のたびに再適用されるため、「設定 → 詳細設定」では読み取り専用で表示されます'] },
        '2.2.0': { title: '誤検知の低減と、自動で整理される検出結果', items: ['マルウェアのアドバイザリが、影響を受ける正確なバージョンと照合されるようになりました。かつて侵害されたパッケージでも、クリーンな、または修正済みのバージョンはもう検出されません', '重複した検出結果が次回のスキャンで自動的に解決され、古い項目や取り残された項目が自動でクリアされます', '本番（production）と開発（development）のラベルが、すべてのソース（npm と OSV）で一貫した単一の方法で算出されるようになりました'] },
        '2.1.0': { title: 'すっきりしたプロジェクトヘッダーと一貫したフィルター', items: ['プロジェクトヘッダーを簡素化 — タイトルの横で名前を変更でき、ミュートとタグはアイコンに', '依存タイプフィルターの横の新しいドロップダウンから、ソース（npm / OSV）で検出結果を絞り込み', 'アプリ全体でドロップダウンを統一し、タイムゾーンなどの長いリストでは入力して検索可能に'] },
        '2.0.1': { title: 'よりわかりやすいアップグレード手順', items: ['2.0 の破壊的変更に関するアップグレード手順を拡充', 'README に localhost のみのポートバインドを明記'] },
        '2.0.0': { title: '複数ソースのスキャンと、デフォルトで安全な堅牢化されたインストール', items: ['任意の第2ソースとしての OSV（設定 → ソース、デフォルトはオフ）。悪意あるパッケージ検出を備え、ローカルキャッシュ内の公開 OSV データベースと照合します', '検出結果がソース間で統合されるようになりました。脆弱性ごとに1行で、各ソースをタグ付けし、利用可能な最良の修正と依存パスの和集合を示し、ソースフィルターと依存パスのポップオーバーを備えます', 'セキュリティ強化: MCP エンドポイントはデフォルトでオフかつトークンが必要、Webhook 配信は SSRF から保護、任意のポータルログインゲート、コンテナは非特権ユーザーとして実行されます', '設定が、サイドバーとプロフィールページを備えたトップレベルのセクションになりました'] },
        '1.4.0': { title: 'MCP 連携と新着情報', items: ['Claude Desktop、Cursor などのクライアント向けの /api/mcp の MCP サーバー', 'サーバー URL とトークン管理を備えた新しい「設定 → MCP」セクション', '新着情報バッジとリリースノートの履歴'] },
        '1.3.1': { title: 'フッターのバージョン表示の修正', items: ['実行中のバージョンがフッターに正しく表示されます'] },
        '1.3.0': { title: '通知の改善', items: ['環境ごとに通知をフィルタリング', '通知先の編集フォームを簡素化', '既存の通知先を複製'] },
        '1.2.0': { title: 'プロジェクトとライブラリのページ', items: ['ホーム画面が専用のプロジェクトページとライブラリページに分割されました'] },
        '1.1.2': { title: 'スケジュールのライブ再読み込み', items: ['ポータルで変更を保存すると、ワーカーがスキャンスケジュールをすぐに再読み込みします'] },
        '1.1.0': { title: 'より安全な削除と分かりやすい更新バナー', items: ['ルートと通知先を削除する前に確認', '更新のお知らせが画面上部の閉じられるバナーに変更', 'ホストのマウントが消えると、ワーカーが古いルートを整理します'] },
        '1.0.1': { title: 'スキャナーの精度修正', items: ['インストール済みバージョンが実際には脆弱な範囲にない検出結果を除外', '送信履歴のある通知先を削除できるように'] },
        '1.0.0': { title: '初のオープンソースリリース', items: ['Sentinello の最初の一般公開リリース'] }
    },
    'zh-CN': {
        '2.3.0': { title: '更简单的 MCP 设置——无需环境变量', items: ['现在完全在“设置 → MCP”中配置 MCP：生成令牌即可开启 /api/mcp 端点，清除令牌即可关闭——SENTINELLO_MCP_ENABLED 和 SENTINELLO_MCP_API_TOKEN 环境变量已移除（升级时会一次性导入已有的环境变量令牌）', '面向 Claude Code、Codex、Cursor 和 Claude Desktop 的即贴即用连接片段，已预填你的令牌', '当通过环境变量设置 SENTINELLO_PORTAL_BASE_URL 时，它会在“设置 → 高级”中以只读方式显示，因为它具有最高优先级并在每次启动时重新应用'] },
        '2.2.0': { title: '更少的误报，以及会自我清理的检测结果', items: ['恶意软件公告现在会与确切的受影响版本进行比对——曾被入侵的包，其干净或已修复的版本不再被标记', '重复的检测结果现在会在下次扫描时自我解决，过期或遗留的条目会自动清除', '生产（production）和开发（development）标签现在在所有来源（npm 和 OSV）上以统一的单一方式计算'] },
        '2.1.0': { title: '更简洁的项目页头与一致的筛选器', items: ['精简的项目页头——在标题旁直接重命名，静音和标签改为图标按钮', '在依赖类型筛选器旁新增下拉框，可按来源（npm / OSV）筛选发现', '全应用统一一致的下拉框，时区等长列表支持输入即搜索'] },
        '2.0.1': { title: '更清晰的升级指引', items: ['扩充了 2.0 重大变更的升级步骤', 'README 说明了仅限本地（localhost）的端口绑定'] },
        '2.0.0': { title: '多来源扫描，以及默认安全的加固安装', items: ['将 OSV 作为可选的第二来源（设置 → 来源，默认关闭），具备恶意软件包检测，并与本地缓存中的公开 OSV 数据库进行比对', '检测结果现在可跨来源合并——每个漏洞一行，标记每个来源、提供可用的最佳修复方案以及依赖路径的并集，并配有来源筛选和依赖路径弹出框', '安全加固：MCP 端点默认关闭并需要令牌，webhook 投递可防御 SSRF，可选的门户登录入口，容器以非特权用户身份运行', '“设置”现在是带侧边栏和个人资料页面的顶级板块'] },
        '1.4.0': { title: 'MCP 集成与新功能', items: ['面向 Claude Desktop、Cursor 等客户端的 /api/mcp MCP 服务器', '全新的“设置 → MCP”板块，提供服务器 URL 和令牌管理', '新功能标记以及发行说明历史'] },
        '1.3.1': { title: '页脚版本显示修复', items: ['运行中的版本在页脚正确显示'] },
        '1.3.0': { title: '通知改进', items: ['按环境筛选通知', '更简单的通知目标编辑表单', '复制现有的通知目标'] },
        '1.2.0': { title: '项目与库页面', items: ['主页拆分为独立的项目页面和库页面'] },
        '1.1.2': { title: '计划实时重载', items: ['在门户中保存更改后，worker 会立即重新加载扫描计划'] },
        '1.1.0': { title: '更安全的删除与更清晰的更新横幅', items: ['删除根目录和通知目标前进行确认', '更新提示改为可关闭的顶部横幅', '当主机挂载消失时，worker 会清理过期的根目录'] },
        '1.0.1': { title: '扫描器准确性修复', items: ['丢弃已安装版本实际上不在易受攻击范围内的审计结果', '允许删除有发送历史的通知目标'] },
        '1.0.0': { title: '首个开源版本', items: ['Sentinello 的首个公开发布版本'] }
    },
    ko: {
        '2.3.0': { title: '더 간단해진 MCP 설정 — 환경 변수 불필요', items: ['이제 MCP를 설정 → MCP에서 전부 구성합니다: 토큰을 생성하면 /api/mcp 엔드포인트가 켜지고, 지우면 꺼집니다 — SENTINELLO_MCP_ENABLED와 SENTINELLO_MCP_API_TOKEN 환경 변수는 제거되었습니다(기존 환경 변수 토큰은 업그레이드 시 한 번만 가져옵니다)', 'Claude Code, Codex, Cursor, Claude Desktop용 붙여넣기만 하면 되는 연결 스니펫, 토큰이 미리 채워져 있습니다', '환경 변수로 SENTINELLO_PORTAL_BASE_URL을 설정하면 우선 적용되며 부팅할 때마다 다시 적용되므로 설정 → 고급에서 읽기 전용으로 표시됩니다'] },
        '2.2.0': { title: '더 적은 오탐과 스스로 정리되는 발견 항목', items: ['악성코드 권고가 이제 정확히 영향받는 버전과 대조됩니다 — 한때 침해되었던 패키지라도 깨끗하거나 이미 수정된 버전은 더 이상 표시되지 않습니다', '중복된 발견 항목이 이제 다음 스캔에서 스스로 해결되어, 오래되었거나 남겨진 항목이 자동으로 정리됩니다', '프로덕션과 개발 라벨이 이제 모든 소스(npm 및 OSV)에서 일관된 단일 방식으로 계산됩니다'] },
        '2.1.0': { title: '더 깔끔한 프로젝트 헤더와 일관된 필터', items: ['프로젝트 헤더 간소화 — 제목 옆에서 바로 이름 변경, 음소거와 태그는 아이콘으로', '의존성 유형 필터 옆의 새 드롭다운에서 소스(npm / OSV)별로 발견 항목 필터링', '앱 전반의 통일되고 일관된 드롭다운, 시간대 같은 긴 목록은 입력하여 검색 지원'] },
        '2.0.1': { title: '더 명확한 업그레이드 안내', items: ['2.0 호환성 깨짐 변경에 대한 업그레이드 단계 보강', 'README에 localhost 전용 포트 바인딩 명시'] },
        '2.0.0': { title: '다중 소스 스캔과 기본값으로 안전한 강화된 설치', items: ['선택적 두 번째 소스로서의 OSV(설정 → 소스, 기본값 꺼짐). 악성 패키지 탐지를 갖추고 로컬 캐시의 공개 OSV 데이터베이스와 대조합니다', '이제 검출 결과가 소스 간에 병합됩니다 — 취약점당 한 행으로, 각 소스를 태그하고 사용 가능한 최선의 수정과 의존성 경로의 합집합을 보여주며, 소스 필터와 의존성 경로 팝오버를 제공합니다', '보안 강화: MCP 엔드포인트는 기본적으로 꺼져 있고 토큰이 필요하며, 웹훅 전송은 SSRF로부터 보호되고, 선택적 포털 로그인 게이트가 있으며, 컨테이너는 비권한 사용자로 실행됩니다', '설정이 이제 사이드바와 프로필 페이지를 갖춘 최상위 섹션이 되었습니다'] },
        '1.4.0': { title: 'MCP 연동 및 새로운 기능', items: ['Claude Desktop, Cursor 등 클라이언트를 위한 /api/mcp MCP 서버', '서버 URL과 토큰 관리를 갖춘 새로운 설정 → MCP 섹션', '새로운 기능 배지와 릴리스 노트 기록'] },
        '1.3.1': { title: '푸터 버전 표시 수정', items: ['실행 중인 버전이 푸터에 깔끔하게 표시됩니다'] },
        '1.3.0': { title: '알림 개선', items: ['환경별로 알림 필터링', '더 간단해진 알림 대상 편집 양식', '기존 알림 대상 복제'] },
        '1.2.0': { title: '프로젝트 및 라이브러리 페이지', items: ['홈 화면이 전용 프로젝트 페이지와 라이브러리 페이지로 분리되었습니다'] },
        '1.1.2': { title: '일정 실시간 다시 로드', items: ['포털에서 변경 사항을 저장하면 워커가 즉시 스캔 일정을 다시 로드합니다'] },
        '1.1.0': { title: '더 안전한 삭제와 더 명확한 업데이트 배너', items: ['루트와 알림 대상을 삭제하기 전에 확인', '업데이트 알림이 닫을 수 있는 상단 배너로 이동', '호스트 마운트가 사라지면 워커가 오래된 루트를 정리합니다'] },
        '1.0.1': { title: '스캐너 정확도 수정', items: ['설치된 버전이 실제로 취약 범위에 없는 점검 결과 제외', '발송 기록이 있는 알림 대상을 삭제할 수 있도록 허용'] },
        '1.0.0': { title: '첫 오픈 소스 릴리스', items: ['Sentinello의 첫 공개 릴리스'] }
    },
    ru: {
        '2.3.0': { title: 'Более простая настройка MCP — без переменных окружения', items: ['Теперь MCP настраивается полностью в «Настройки → MCP»: сгенерируйте токен, чтобы включить эндпойнт /api/mcp, очистите его, чтобы выключить — переменные окружения SENTINELLO_MCP_ENABLED и SENTINELLO_MCP_API_TOKEN удалены (существующий токен из окружения импортируется один раз при обновлении)', 'Готовые к вставке фрагменты подключения для Claude Code, Codex, Cursor и Claude Desktop, уже заполненные вашим токеном', 'Когда SENTINELLO_PORTAL_BASE_URL задана в окружении, она отображается только для чтения в «Настройки → Дополнительно», поскольку остаётся приоритетной и повторно применяется при каждом запуске'] },
        '2.2.0': { title: 'Меньше ложных срабатываний и самоочищающиеся находки', items: ['Оповещения о вредоносном ПО теперь сопоставляются с точной затронутой версией — чистая или уже исправленная версия некогда скомпрометированного пакета больше не помечается', 'Дублирующиеся находки теперь устраняются сами при следующем сканировании, поэтому старые или осиротевшие записи удаляются автоматически', 'Метки production и development теперь вычисляются единым согласованным способом по всем источникам (npm и OSV)'] },
        '2.1.0': { title: 'Более чистый заголовок проекта и единообразные фильтры', items: ['Упрощённый заголовок проекта — переименование рядом с названием, отключение и теги в виде иконок', 'Фильтрация находок по источнику (npm / OSV) через новый выпадающий список рядом с фильтром типа зависимости', 'Единообразные выпадающие списки по всему приложению, с поиском по вводу для длинных списков, например часовых поясов'] },
        '2.0.1': { title: 'Более понятные инструкции по обновлению', items: ['Расширенные шаги обновления для несовместимых изменений 2.0', 'В README указана привязка порта только к localhost'] },
        '2.0.0': { title: 'Сканирование из нескольких источников и усиленная, безопасная по умолчанию установка', items: ['OSV как необязательный второй источник (Настройки → Источники, по умолчанию выключено) с обнаружением вредоносных пакетов, сверяемый с публичной базой данных OSV в локальном кэше', 'Результаты теперь объединяются между источниками — одна строка на уязвимость, каждый источник помечен, лучшее доступное исправление и объединение путей зависимостей, с фильтром по источнику и всплывающим окном пути зависимости', 'Усиление безопасности: эндпойнт MCP по умолчанию выключен и требует токен, доставка вебхуков защищена от SSRF, необязательный вход в портал, и контейнер запускается от непривилегированного пользователя', 'Настройки теперь — раздел верхнего уровня с боковой панелью и страницей профиля'] },
        '1.4.0': { title: 'Интеграция MCP и новинки', items: ['MCP-сервер по адресу /api/mcp для Claude Desktop, Cursor и других клиентов', 'Новый раздел «Настройки → MCP» с URL сервера и управлением токенами', 'Значок новинок и история примечаний к выпускам'] },
        '1.3.1': { title: 'Исправление версии в подвале', items: ['Текущая версия корректно отображается в подвале'] },
        '1.3.0': { title: 'Улучшения уведомлений', items: ['Фильтрация уведомлений по среде', 'Более простая форма редактирования получателей', 'Дублирование существующего получателя уведомлений'] },
        '1.2.0': { title: 'Страницы проектов и библиотек', items: ['Главный экран разделён на отдельные страницы проектов и библиотек'] },
        '1.1.2': { title: 'Живая перезагрузка расписания', items: ['Воркер перезагружает расписание сканирования сразу после сохранения изменений в портале'] },
        '1.1.0': { title: 'Более безопасное удаление и понятный баннер обновления', items: ['Подтверждение перед удалением корней и получателей уведомлений', 'Уведомление об обновлении перенесено в закрываемый баннер сверху', 'Воркер удаляет устаревшие корни, когда их монтирование исчезает'] },
        '1.0.1': { title: 'Исправления точности сканера', items: ['Отбрасывает результаты, чья установленная версия фактически не входит в уязвимый диапазон', 'Позволяет удалить получателя уведомлений с историей отправок'] },
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
    return RELEASES.find(function match(entry) {
        return entry.version === bare
    }) || null
}

// Falls back to English when a locale is missing an entry (unlike next-intl’s hard error).
export function getReleaseCopy(locale: Locale, version: string): ReleaseCopy | null {
    const byLocale = RELEASE_COPY[locale] || RELEASE_COPY.en
    return byLocale[version] || RELEASE_COPY.en[version] || null
}
