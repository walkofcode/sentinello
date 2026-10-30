import type { Locale } from '@sentinello/core'

// The silent baseline's one summary, in the ten notification locales. Each locale words its own plurals: the
// counts are plain numbers, never spelled out, and a locale whose grammar has no plural (ja, zh-CN, ko) uses
// one form. "Settings → Sources" is the portal's own label in that locale (Nav.settings → Nav.tabs.sources).
export type CapabilitySummaryCopy = {
    title(version: string, languages: string): string
    counts(findings: number, projects: number, critical: number): string
    sourceDisabled(projects: number): string
}

// One form for exactly one, another for the rest: English, Spanish, German, Portuguese, Italian.
function oneOther(count: number, one: string, other: string): string {
    return count === 1 ? one : other
}

// French reads zero as singular: "0 projet".
function frenchOneOther(count: number, one: string, other: string): string {
    return count < 2 ? one : other
}

// Russian picks by the last digits: 1, 21 → one; 2–4, 22–24 → few; the rest → many.
const RUSSIAN_PLURAL = new Intl.PluralRules('ru')

function russian(count: number, one: string, few: string, many: string): string {
    const form = RUSSIAN_PLURAL.select(count)
    if (form === 'one') return one
    if (form === 'few') return few
    return many
}

export const CAPABILITY_SUMMARY_COPY: Record<Locale, CapabilitySummaryCopy> = {
    'en': {
        title: function title(version, languages) { return 'Sentinello ' + version + ' now checks ' + languages },
        counts: function counts(n, m, x) { return n + ' ' + oneOther(n, 'finding', 'findings') + ' across ' + m + ' ' + oneOther(m, 'project', 'projects') + ', ' + x + ' critical' },
        sourceDisabled: function sourceDisabled(k) { return k + ' ' + oneOther(k, 'project has', 'projects have') + ' no enabled source, turn one on in Settings → Sources' }
    },
    'es': {
        title: function title(version, languages) { return 'Sentinello ' + version + ' ahora revisa ' + languages },
        counts: function counts(n, m, x) { return n + ' ' + oneOther(n, 'hallazgo', 'hallazgos') + ' en ' + m + ' ' + oneOther(m, 'proyecto', 'proyectos') + ', ' + x + ' ' + oneOther(x, 'crítico', 'críticos') },
        sourceDisabled: function sourceDisabled(k) { return k + ' ' + oneOther(k, 'proyecto no tiene', 'proyectos no tienen') + ' ninguna fuente activada, activa una en Configuración → Fuentes' }
    },
    'fr': {
        title: function title(version, languages) { return 'Sentinello ' + version + ' vérifie désormais ' + languages },
        counts: function counts(n, m, x) { return n + ' ' + frenchOneOther(n, 'vulnérabilité', 'vulnérabilités') + ' dans ' + m + ' ' + frenchOneOther(m, 'projet', 'projets') + ', dont ' + x + ' ' + frenchOneOther(x, 'critique', 'critiques') },
        sourceDisabled: function sourceDisabled(k) { return k + ' ' + frenchOneOther(k, 'projet n’a', 'projets n’ont') + ' aucune source activée, activez-en une dans Paramètres → Sources' }
    },
    'de': {
        title: function title(version, languages) { return 'Sentinello ' + version + ' prüft jetzt ' + languages },
        counts: function counts(n, m, x) { return n + ' ' + oneOther(n, 'Befund', 'Befunde') + ' in ' + m + ' ' + oneOther(m, 'Projekt', 'Projekten') + ', ' + x + ' kritisch' },
        sourceDisabled: function sourceDisabled(k) { return k + ' ' + oneOther(k, 'Projekt hat', 'Projekte haben') + ' keine aktivierte Quelle, aktivieren Sie eine unter Einstellungen → Quellen' }
    },
    'pt-BR': {
        title: function title(version, languages) { return 'Sentinello ' + version + ' agora verifica ' + languages },
        counts: function counts(n, m, x) { return n + ' ' + oneOther(n, 'achado', 'achados') + ' em ' + m + ' ' + oneOther(m, 'projeto', 'projetos') + ', ' + x + ' ' + oneOther(x, 'crítico', 'críticos') },
        sourceDisabled: function sourceDisabled(k) { return k + ' ' + oneOther(k, 'projeto não tem', 'projetos não têm') + ' nenhuma fonte ativada, ative uma em Configurações → Fontes' }
    },
    'it': {
        title: function title(version, languages) { return 'Sentinello ' + version + ' ora controlla ' + languages },
        counts: function counts(n, m, x) { return n + ' ' + oneOther(n, 'vulnerabilità trovata', 'vulnerabilità trovate') + ' in ' + m + ' ' + oneOther(m, 'progetto', 'progetti') + ', ' + x + ' ' + oneOther(x, 'critica', 'critiche') },
        sourceDisabled: function sourceDisabled(k) { return k + ' ' + oneOther(k, 'progetto non ha', 'progetti non hanno') + ' alcuna fonte attivata, attivane una in Impostazioni → Fonti' }
    },
    'ja': {
        title: function title(version, languages) { return 'Sentinello ' + version + ' は ' + languages + ' もチェックするようになりました' },
        counts: function counts(n, m, x) { return m + ' 件のプロジェクトで ' + n + ' 件の検出、うち重大 ' + x + ' 件' },
        sourceDisabled: function sourceDisabled(k) { return k + ' 件のプロジェクトで有効なソースがありません。設定 → ソースで有効にしてください' }
    },
    'zh-CN': {
        title: function title(version, languages) { return 'Sentinello ' + version + ' 现已检查 ' + languages },
        counts: function counts(n, m, x) { return m + ' 个项目中有 ' + n + ' 个发现，其中 ' + x + ' 个严重' },
        sourceDisabled: function sourceDisabled(k) { return k + ' 个项目没有已启用的来源，请在 设置 → 来源 中启用一个' }
    },
    'ko': {
        title: function title(version, languages) { return 'Sentinello ' + version + '부터 ' + languages + '도 검사합니다' },
        counts: function counts(n, m, x) { return '프로젝트 ' + m + '개에서 발견 항목 ' + n + '개, 그중 심각 ' + x + '개' },
        sourceDisabled: function sourceDisabled(k) { return '프로젝트 ' + k + '개에 활성화된 소스가 없습니다. 설정 → 소스에서 하나를 켜세요' }
    },
    'ru': {
        title: function title(version, languages) { return 'Sentinello ' + version + ' теперь проверяет ' + languages },
        counts: function counts(n, m, x) { return n + ' ' + russian(n, 'находка', 'находки', 'находок') + ' в ' + m + ' ' + russian(m, 'проекте', 'проектах', 'проектах') + ', ' + x + ' ' + russian(x, 'критическая', 'критических', 'критических') },
        sourceDisabled: function sourceDisabled(k) { return 'В ' + k + ' ' + russian(k, 'проекте', 'проектах', 'проектах') + ' нет включённого источника, включите его в Настройки → Источники' }
    }
}
