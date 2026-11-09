import type { Locale } from '@sentinello/core'

// The run summary and the weekly digest, in the ten notification locales. Severity words are not here: the portal's
// pills read critical, high, moderate, unrated, low and info in every language, and these messages use its words.
// Each locale words its own plurals, as capability-copy.ts does.
export type FleetSummaryCopy = {
    runSummaryTitle: string
    digestTitle: string
    nothingOutstanding: string
    resolvedHeading: string
    newlyUnscannableHeading: string
    currentlyUnscannableHeading: string
    advisories(count: number): string
    fix(version: string): string
    untaggedFix(version: string): string
    noFix: string
    andMore(count: number): string
}

const RUSSIAN_PLURAL = new Intl.PluralRules('ru')

function russian(count: number, one: string, few: string, many: string): string {
    const form = RUSSIAN_PLURAL.select(count)
    if (form === 'one') return one
    if (form === 'few') return few
    return many
}

export const FLEET_SUMMARY_COPY: Record<Locale, FleetSummaryCopy> = {
    'en': {
        runSummaryTitle: 'Sentinello run summary',
        digestTitle: 'Sentinello weekly digest',
        nothingOutstanding: 'Nothing outstanding',
        resolvedHeading: 'Resolved',
        newlyUnscannableHeading: 'Newly unscannable',
        currentlyUnscannableHeading: 'Cannot be fully scanned',
        advisories: function advisories(n) { return n + (n === 1 ? ' advisory' : ' advisories') },
        fix: function fix(v) { return 'fix ' + v },
        untaggedFix: function untaggedFix(v) { return 'fix ' + v + ' (untagged commit)' },
        noFix: 'no fix released',
        andMore: function andMore(n) { return '…and ' + n + ' more' }
    },
    'es': {
        runSummaryTitle: 'Resumen de ejecución de Sentinello',
        digestTitle: 'Resumen semanal de Sentinello',
        nothingOutstanding: 'Nada pendiente',
        resolvedHeading: 'Resueltos',
        newlyUnscannableHeading: 'Ya no se pueden analizar',
        currentlyUnscannableHeading: 'No se pueden analizar por completo',
        advisories: function advisories(n) { return n + (n === 1 ? ' aviso' : ' avisos') },
        fix: function fix(v) { return 'corrección ' + v },
        untaggedFix: function untaggedFix(v) { return 'corrección ' + v + ' (commit sin etiqueta)' },
        noFix: 'sin corrección publicada',
        andMore: function andMore(n) { return '…y ' + n + ' más' }
    },
    'fr': {
        runSummaryTitle: 'Résumé d’exécution de Sentinello',
        digestTitle: 'Résumé hebdomadaire de Sentinello',
        nothingOutstanding: 'Rien en attente',
        resolvedHeading: 'Résolus',
        newlyUnscannableHeading: 'Désormais impossibles à analyser',
        currentlyUnscannableHeading: 'Analyse complète impossible',
        advisories: function advisories(n) { return n + ' avis' },
        fix: function fix(v) { return 'correctif ' + v },
        untaggedFix: function untaggedFix(v) { return 'correctif ' + v + ' (commit sans tag)' },
        noFix: 'aucun correctif publié',
        andMore: function andMore(n) { return '…et ' + n + ' de plus' }
    },
    'de': {
        runSummaryTitle: 'Sentinello-Laufzusammenfassung',
        digestTitle: 'Sentinello-Wochenübersicht',
        nothingOutstanding: 'Nichts offen',
        resolvedHeading: 'Behoben',
        newlyUnscannableHeading: 'Neu nicht scanbar',
        currentlyUnscannableHeading: 'Nicht vollständig scanbar',
        advisories: function advisories(n) { return n + (n === 1 ? ' Advisory' : ' Advisories') },
        fix: function fix(v) { return 'Fix ' + v },
        untaggedFix: function untaggedFix(v) { return 'Fix ' + v + ' (Commit ohne Tag)' },
        noFix: 'kein Fix veröffentlicht',
        andMore: function andMore(n) { return '…und ' + n + ' weitere' }
    },
    'pt-BR': {
        runSummaryTitle: 'Resumo de execução do Sentinello',
        digestTitle: 'Resumo semanal do Sentinello',
        nothingOutstanding: 'Nada pendente',
        resolvedHeading: 'Resolvidos',
        newlyUnscannableHeading: 'Não podem mais ser verificados',
        currentlyUnscannableHeading: 'Não podem ser verificados por completo',
        advisories: function advisories(n) { return n + (n === 1 ? ' alerta' : ' alertas') },
        fix: function fix(v) { return 'correção ' + v },
        untaggedFix: function untaggedFix(v) { return 'correção ' + v + ' (commit sem tag)' },
        noFix: 'nenhuma correção publicada',
        andMore: function andMore(n) { return '…e mais ' + n }
    },
    'it': {
        runSummaryTitle: 'Riepilogo dell’esecuzione di Sentinello',
        digestTitle: 'Riepilogo settimanale di Sentinello',
        nothingOutstanding: 'Niente in sospeso',
        resolvedHeading: 'Risolti',
        newlyUnscannableHeading: 'Non più analizzabili',
        currentlyUnscannableHeading: 'Non analizzabili del tutto',
        advisories: function advisories(n) { return n + (n === 1 ? ' avviso' : ' avvisi') },
        fix: function fix(v) { return 'correzione ' + v },
        untaggedFix: function untaggedFix(v) { return 'correzione ' + v + ' (commit senza tag)' },
        noFix: 'nessuna correzione pubblicata',
        andMore: function andMore(n) { return '…e altri ' + n }
    },
    'ja': {
        runSummaryTitle: 'Sentinello 実行サマリー',
        digestTitle: 'Sentinello 週次ダイジェスト',
        nothingOutstanding: '未対応の項目はありません',
        resolvedHeading: '解決済み',
        newlyUnscannableHeading: '新たにスキャンできなくなったプロジェクト',
        currentlyUnscannableHeading: '完全にはスキャンできないプロジェクト',
        advisories: function advisories(n) { return 'アドバイザリ ' + n + ' 件' },
        fix: function fix(v) { return '修正 ' + v },
        untaggedFix: function untaggedFix(v) { return '修正 ' + v + '（タグなしコミット）' },
        noFix: '修正は未公開',
        andMore: function andMore(n) { return '…他 ' + n + ' 件' }
    },
    'zh-CN': {
        runSummaryTitle: 'Sentinello 运行摘要',
        digestTitle: 'Sentinello 每周摘要',
        nothingOutstanding: '没有待处理项',
        resolvedHeading: '已解决',
        newlyUnscannableHeading: '新增无法扫描的项目',
        currentlyUnscannableHeading: '无法完整扫描的项目',
        advisories: function advisories(n) { return n + ' 条公告' },
        fix: function fix(v) { return '修复版本 ' + v },
        untaggedFix: function untaggedFix(v) { return '修复版本 ' + v + '（未打标签的提交）' },
        noFix: '尚未发布修复',
        andMore: function andMore(n) { return '…还有 ' + n + ' 项' }
    },
    'ko': {
        runSummaryTitle: 'Sentinello 실행 요약',
        digestTitle: 'Sentinello 주간 요약',
        nothingOutstanding: '미해결 항목 없음',
        resolvedHeading: '해결됨',
        newlyUnscannableHeading: '새로 스캔할 수 없게 된 프로젝트',
        currentlyUnscannableHeading: '완전히 스캔할 수 없는 프로젝트',
        advisories: function advisories(n) { return '권고 ' + n + '개' },
        fix: function fix(v) { return '수정 ' + v },
        untaggedFix: function untaggedFix(v) { return '수정 ' + v + ' (태그 없는 커밋)' },
        noFix: '공개된 수정 없음',
        andMore: function andMore(n) { return '…외 ' + n + '개' }
    },
    'ru': {
        runSummaryTitle: 'Сводка запуска Sentinello',
        digestTitle: 'Еженедельная сводка Sentinello',
        nothingOutstanding: 'Нет нерешённых проблем',
        resolvedHeading: 'Решено',
        newlyUnscannableHeading: 'Больше не удаётся сканировать',
        currentlyUnscannableHeading: 'Не удаётся просканировать полностью',
        advisories: function advisories(n) { return n + ' ' + russian(n, 'уведомление', 'уведомления', 'уведомлений') },
        fix: function fix(v) { return 'исправление ' + v },
        untaggedFix: function untaggedFix(v) { return 'исправление ' + v + ' (коммит без тега)' },
        noFix: 'исправление не выпущено',
        andMore: function andMore(n) { return '…и ещё ' + n }
    }
}
