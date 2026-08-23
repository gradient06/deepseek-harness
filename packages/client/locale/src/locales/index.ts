/**
 * The common-namespace dictionary pair. zh is the source of truth for the
 * key set (Chinese-first repo convention); en and fr are checked complete
 * against it — a missing or extra key is a compile error.
 */
export { zh } from './zh.ts'
export { en } from './en.ts'
export { fr } from './fr.ts'
export type { CommonKey } from './zh.ts'
