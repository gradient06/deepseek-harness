/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'dialog.preparingTitle': '正在导出 Session',
  'dialog.preparingDescription': '正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。',
  'dialog.successTitle': 'Session 导出已开始下载',
  'dialog.successDescription': '浏览器正在下载 Session ZIP 文件。',
  'dialog.errorTitle': 'Session 导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法启动 Session 导出。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'dialog.preparingTitle': 'Exporting Session',
  'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'dialog.successTitle': 'Session download started',
  'dialog.successDescription': 'The browser is downloading the Session ZIP.',
  'dialog.errorTitle': 'Session export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** French Session export strings. */
export const fr: Record<keyof typeof zh, string> = {
  'dialog.preparingTitle': 'Export de la Session',
  'dialog.preparingDescription': 'Préparation d’un ZIP contenant cette Session, ses sous-Sessions et ses pièces jointes.',
  'dialog.successTitle': 'Téléchargement de la Session démarré',
  'dialog.successDescription': 'Le navigateur télécharge le ZIP de la Session.',
  'dialog.errorTitle': 'Échec de l’export de la Session',
  'dialog.close': 'Fermer',
  'dialog.commandFailed': 'Impossible de démarrer l’export de la Session.',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh
