import type { Locale, ReasonCode } from './types'

// What would fix a reason on the project's side, in the same ten locales as its label: a file in the project
// stops it from being read, so the reader can do something about it. A reason on the install's side is the
// operator's, and its label already names the tool. Technical tokens (npm, pnpm, Yarn, lockfile names, commands)
// are not translated, as in reason-code-labels.

export type ProjectFixableReason = Extract<ReasonCode, 'no_lockfile' | 'unknown_pm' | 'yarn_v1_unsupported' | 'partial_dependency_graph' | 'ambiguous_dependency_spec' | 'unsupported_lockfile'>

export const REASON_FIX_HINTS: Record<Locale, Record<ProjectFixableReason, string>> = {
    'en': {
        no_lockfile: 'commit the lockfile your package manager writes',
        unknown_pm: 'name the package manager in package.json, or commit its lockfile',
        yarn_v1_unsupported: 'move to Yarn 2 or later, npm or pnpm',
        partial_dependency_graph: 'pin what comes from git, a local path or a URL to a released version where you can',
        ambiguous_dependency_spec: 'pin exact versions (== in requirements.txt) or commit a lockfile',
        unsupported_lockfile: 'regenerate it in a format Sentinello reads: npm install with npm 7 or later, or bun install --save-text-lockfile'
    },
    'es': {
        no_lockfile: 'haz commit del lockfile que escribe tu gestor de paquetes',
        unknown_pm: 'indica el gestor de paquetes en package.json o haz commit de su lockfile',
        yarn_v1_unsupported: 'pasa a Yarn 2 o posterior, npm o pnpm',
        partial_dependency_graph: 'fija en una versión publicada lo que venga de git, de una ruta local o de una URL, cuando puedas',
        ambiguous_dependency_spec: 'fija versiones exactas (== en requirements.txt) o haz commit de un lockfile',
        unsupported_lockfile: 'regenéralo en un formato que Sentinello lea: npm install con npm 7 o posterior, o bun install --save-text-lockfile'
    },
    'fr': {
        no_lockfile: 'committez le lockfile écrit par votre gestionnaire de paquets',
        unknown_pm: 'indiquez le gestionnaire de paquets dans package.json, ou committez son lockfile',
        yarn_v1_unsupported: 'passez à Yarn 2 ou ultérieur, npm ou pnpm',
        partial_dependency_graph: 'épinglez sur une version publiée ce qui vient de git, d\'un chemin local ou d\'une URL, si possible',
        ambiguous_dependency_spec: 'épinglez des versions exactes (== dans requirements.txt) ou committez un lockfile',
        unsupported_lockfile: 'régénérez-le dans un format que Sentinello lit : npm install avec npm 7 ou ultérieur, ou bun install --save-text-lockfile'
    },
    'de': {
        no_lockfile: 'committe die Lockfile, die dein Paketmanager schreibt',
        unknown_pm: 'nenne den Paketmanager in package.json oder committe seine Lockfile',
        yarn_v1_unsupported: 'wechsle zu Yarn 2 oder neuer, npm oder pnpm',
        partial_dependency_graph: 'pinne, was aus git, einem lokalen Pfad oder einer URL kommt, wo möglich auf eine veröffentlichte Version',
        ambiguous_dependency_spec: 'pinne exakte Versionen (== in requirements.txt) oder committe eine Lockfile',
        unsupported_lockfile: 'erzeuge sie in einem Format neu, das Sentinello liest: npm install mit npm 7 oder neuer, oder bun install --save-text-lockfile'
    },
    'pt-BR': {
        no_lockfile: 'faça commit do lockfile que seu gerenciador de pacotes escreve',
        unknown_pm: 'indique o gerenciador de pacotes no package.json ou faça commit do lockfile dele',
        yarn_v1_unsupported: 'migre para Yarn 2 ou posterior, npm ou pnpm',
        partial_dependency_graph: 'fixe em uma versão publicada o que vem do git, de um caminho local ou de uma URL, quando possível',
        ambiguous_dependency_spec: 'fixe versões exatas (== no requirements.txt) ou faça commit de um lockfile',
        unsupported_lockfile: 'gere-o de novo em um formato que o Sentinello leia: npm install com npm 7 ou posterior, ou bun install --save-text-lockfile'
    },
    'it': {
        no_lockfile: 'esegui il commit del lockfile scritto dal tuo gestore di pacchetti',
        unknown_pm: 'indica il gestore di pacchetti in package.json o esegui il commit del suo lockfile',
        yarn_v1_unsupported: 'passa a Yarn 2 o successivo, npm o pnpm',
        partial_dependency_graph: 'fissa su una versione pubblicata ciò che viene da git, da un percorso locale o da un URL, dove puoi',
        ambiguous_dependency_spec: 'fissa versioni esatte (== in requirements.txt) o esegui il commit di un lockfile',
        unsupported_lockfile: 'rigeneralo in un formato che Sentinello legge: npm install con npm 7 o successivo, oppure bun install --save-text-lockfile'
    },
    'ja': {
        no_lockfile: 'パッケージマネージャーが生成する lockfile をコミットしてください',
        unknown_pm: 'package.json でパッケージマネージャーを指定するか、その lockfile をコミットしてください',
        yarn_v1_unsupported: 'Yarn 2 以降、npm、pnpm のいずれかに移行してください',
        partial_dependency_graph: 'git、ローカルパス、URL から取得しているものは、可能な範囲で公開済みバージョンに固定してください',
        ambiguous_dependency_spec: '正確なバージョンを固定する（requirements.txt の ==）か、lockfile をコミットしてください',
        unsupported_lockfile: 'Sentinello が読める形式で再生成してください: npm 7 以降の npm install、または bun install --save-text-lockfile'
    },
    'zh-CN': {
        no_lockfile: '提交包管理器生成的 lockfile',
        unknown_pm: '在 package.json 中指明包管理器，或提交其 lockfile',
        yarn_v1_unsupported: '迁移到 Yarn 2 或更高版本、npm 或 pnpm',
        partial_dependency_graph: '尽可能将来自 git、本地路径或 URL 的依赖固定到已发布版本',
        ambiguous_dependency_spec: '固定确切版本（requirements.txt 中使用 ==）或提交 lockfile',
        unsupported_lockfile: '以 Sentinello 可读的格式重新生成：使用 npm 7 或更高版本运行 npm install，或运行 bun install --save-text-lockfile'
    },
    'ko': {
        no_lockfile: '패키지 관리자가 생성하는 lockfile을 커밋하세요',
        unknown_pm: 'package.json에 패키지 관리자를 지정하거나 해당 lockfile을 커밋하세요',
        yarn_v1_unsupported: 'Yarn 2 이상, npm 또는 pnpm으로 옮기세요',
        partial_dependency_graph: 'git, 로컬 경로, URL에서 가져오는 항목은 가능한 경우 게시된 버전으로 고정하세요',
        ambiguous_dependency_spec: '정확한 버전을 고정하거나(requirements.txt의 ==) lockfile을 커밋하세요',
        unsupported_lockfile: 'Sentinello가 읽을 수 있는 형식으로 다시 생성하세요: npm 7 이상의 npm install 또는 bun install --save-text-lockfile'
    },
    'ru': {
        no_lockfile: 'закоммитьте lockfile, который создаёт ваш менеджер пакетов',
        unknown_pm: 'укажите менеджер пакетов в package.json или закоммитьте его lockfile',
        yarn_v1_unsupported: 'перейдите на Yarn 2 или новее, npm или pnpm',
        partial_dependency_graph: 'по возможности закрепите на опубликованной версии то, что берётся из git, локального пути или URL',
        ambiguous_dependency_spec: 'закрепите точные версии (== в requirements.txt) или закоммитьте lockfile',
        unsupported_lockfile: 'создайте его заново в формате, который читает Sentinello: npm install с npm 7 или новее либо bun install --save-text-lockfile'
    }
}

// The hint for a reason, or null for one whose fix is not the project's.
export function reasonFixHint(code: string, locale: Locale = 'en'): string | null {
    return REASON_FIX_HINTS[locale][code as ProjectFixableReason] ?? null
}
