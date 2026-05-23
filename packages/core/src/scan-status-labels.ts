import type { Locale, ScanStatus } from './types'

// Localized labels for a scan's terminal status. Same pattern as reason-code-labels: stable status
// id → human string per locale, used by the web portal in the active user locale. 'en' is canonical.
export const SCAN_STATUS_LABELS: Record<Locale, Record<ScanStatus, string>> = {
    'en': { ok: 'OK', unauditable: 'Unauditable', error: 'Error', timeout: 'Timeout' },
    'es': { ok: 'OK', unauditable: 'No auditable', error: 'Error', timeout: 'Tiempo de espera agotado' },
    'fr': { ok: 'OK', unauditable: 'Non auditable', error: 'Erreur', timeout: 'Délai dépassé' },
    'de': { ok: 'OK', unauditable: 'Nicht auditierbar', error: 'Fehler', timeout: 'Zeitüberschreitung' },
    'pt-BR': { ok: 'OK', unauditable: 'Não auditável', error: 'Erro', timeout: 'Tempo esgotado' },
    'it': { ok: 'OK', unauditable: 'Non controllabile', error: 'Errore', timeout: 'Timeout scaduto' },
    'ja': { ok: 'OK', unauditable: '監査不可', error: 'エラー', timeout: 'タイムアウト' },
    'zh-CN': { ok: 'OK', unauditable: '无法审计', error: '错误', timeout: '超时' },
    'ko': { ok: 'OK', unauditable: '감사 불가', error: '오류', timeout: '시간 초과' },
    'ru': { ok: 'OK', unauditable: 'Не поддаётся аудиту', error: 'Ошибка', timeout: 'Тайм-аут' }
}

export function scanStatusLabel(status: ScanStatus, locale: Locale = 'en'): string {
    const table = SCAN_STATUS_LABELS[locale] || SCAN_STATUS_LABELS['en']
    return table[status] || SCAN_STATUS_LABELS['en'][status] || status
}
