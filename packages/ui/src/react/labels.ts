import type { Deliver } from '@zboule/wasp-protocol';

/** Every string the chat shows. Pass any subset as `labels` to translate or reword it. */
export type WaspLabels = {
  placeholder: string;
  placeholderBusy: string;
  empty: string;
  loading: string;
  send: string;
  stop: string;
  wakingUp: string;
  working: string;
  queued: (count: number) => string;
  cancel: string;
  edit: string;
  deliver: Record<Deliver, { label: string; hint: string }>;
  deliveredMidTurn: Record<Exclude<Deliver, 'later'>, string>;
  interrupted: string;
  undeliverable: string;
  runError: string;
  toolArgs: string;
  toolResult: string;
  toolRunning: string;
  fullArgs: string;
  fullOutput: string;
  copy: string;
  copied: string;
  latest: string;
};

export const labelsEn: WaspLabels = {
  placeholder: 'Message the agent…',
  placeholderBusy: 'Add to the conversation…',
  empty: 'Start the conversation.',
  loading: 'Loading…',
  send: 'Send',
  stop: 'Stop',
  wakingUp: 'Starting the agent',
  working: 'Working',
  queued: (n) => (n === 1 ? '1 queued' : `${n} queued`),
  cancel: 'Remove from the queue',
  edit: 'Edit',
  deliver: {
    asap: { label: 'Next', hint: 'The agent reads it at its next step' },
    later: { label: 'After this turn', hint: 'Waits until the agent is done' },
    now: { label: 'Interrupt', hint: 'Stops the agent and sends this' }
  },
  deliveredMidTurn: { asap: 'Read mid-turn', now: 'Interrupted to send' },
  interrupted: 'Stopped',
  undeliverable: 'A message could not be delivered',
  runError: 'The agent hit an error',
  toolArgs: 'Input',
  toolResult: 'Output',
  toolRunning: 'Running…',
  fullArgs: 'Full input',
  fullOutput: 'Full output',
  copy: 'Copy',
  copied: 'Copied',
  latest: 'Jump to the latest'
};

export const labelsFr: WaspLabels = {
  placeholder: 'Écrire à l’agent…',
  placeholderBusy: 'Ajouter à la conversation…',
  empty: 'Commencez la conversation.',
  loading: 'Chargement…',
  send: 'Envoyer',
  stop: 'Arrêter',
  wakingUp: 'Démarrage de l’agent',
  working: 'En cours',
  queued: (n) => `${n} en attente`,
  cancel: 'Retirer de la file',
  edit: 'Modifier',
  deliver: {
    asap: { label: 'Ensuite', hint: 'L’agent le lit à sa prochaine étape' },
    later: { label: 'Après ce tour', hint: 'Attend que l’agent ait fini' },
    now: { label: 'Interrompre', hint: 'Arrête l’agent et envoie ceci' }
  },
  deliveredMidTurn: {
    asap: 'Lu en cours de route',
    now: 'Envoyé en interrompant'
  },
  interrupted: 'Arrêté',
  undeliverable: 'Un message n’a pas pu être remis',
  runError: 'L’agent a rencontré une erreur',
  toolArgs: 'Entrée',
  toolResult: 'Sortie',
  toolRunning: 'En cours…',
  fullArgs: 'Entrée complète',
  fullOutput: 'Sortie complète',
  copy: 'Copier',
  copied: 'Copié',
  latest: 'Aller au plus récent'
};

export function resolveLabels(labels?: Partial<WaspLabels>): WaspLabels {
  return labels
    ? {
        ...labelsEn,
        ...labels,
        deliver: { ...labelsEn.deliver, ...labels.deliver }
      }
    : labelsEn;
}
