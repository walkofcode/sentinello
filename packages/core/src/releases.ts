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
