import type { CommonKey } from './zh.ts'

/** fr base dictionary for the common namespace, checked complete against the zh key set. */
export const fr = {
  'ok': 'OK',
  'cancel': 'Annuler',
  'close': 'Fermer',
  'copy': 'Copier',
  'copied': 'Copié',
  'retry': 'Réessayer',
  'loading': 'Chargement…',
  'load.failed': 'Échec du chargement',
  'submit': 'Envoyer',
  'submitting': 'Envoi…',
  'next': 'Suivant',
  'previous': 'Précédent',
  'skip': 'Passer',
  'delete': 'Supprimer',
  'edit': 'Modifier',
  'save': 'Enregistrer',
  'search': 'Rechercher',
  'more': 'Plus',
  'collapse': 'Réduire',
  'expand': 'Déplier',
  'back': 'Retour',
  'unknown': 'Inconnu',
  'none': 'Aucun',
  'truncated': 'Tronqué',
} satisfies Record<CommonKey, string>
