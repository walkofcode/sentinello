import type { Locale } from './types'

// What a notice says about a package, in the same ten locales as the reason labels. A kind upstream adds later has
// no label and reads as its own word, which is still what the source said.

export const NOTICE_KIND_LABELS: Record<Locale, Record<'unmaintained' | 'unsound' | 'notice', string>> = {
    'en': { unmaintained: 'Unmaintained', unsound: 'Unsound', notice: 'Notice' },
    'es': { unmaintained: 'Sin mantenimiento', unsound: 'Inseguro por diseño (unsound)', notice: 'Aviso' },
    'fr': { unmaintained: 'Non maintenu', unsound: 'Non sûr (unsound)', notice: 'Avis' },
    'de': { unmaintained: 'Nicht gewartet', unsound: 'Unsound', notice: 'Hinweis' },
    'pt-BR': { unmaintained: 'Sem manutenção', unsound: 'Inseguro (unsound)', notice: 'Aviso' },
    'it': { unmaintained: 'Non mantenuto', unsound: 'Non sicuro (unsound)', notice: 'Avviso' },
    'ja': { unmaintained: 'メンテナンス終了', unsound: '健全性の問題 (unsound)', notice: 'お知らせ' },
    'zh-CN': { unmaintained: '已停止维护', unsound: '不健全 (unsound)', notice: '通知' },
    'ko': { unmaintained: '유지 관리 중단', unsound: '건전성 문제 (unsound)', notice: '공지' },
    'ru': { unmaintained: 'Не поддерживается', unsound: 'Некорректный (unsound)', notice: 'Уведомление' }
}

export function noticeKindLabel(kind: string, locale: Locale = 'en'): string {
    return NOTICE_KIND_LABELS[locale][kind as 'unmaintained' | 'unsound' | 'notice'] ?? kind
}
