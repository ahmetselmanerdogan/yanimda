'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.STEP_RESULTS = exports.TOPICS = void 0;
exports.TOPICS = {
  signalReceived: 'signal.received',
  eventCreated: 'event.created',
  eventTransitioned: 'event.transitioned',
  eventClosed: 'event.closed',
  eventUpdated: 'event.updated',
  notifyRequested: 'notify.requested',
  rulesReloaded: 'rules.reloaded',
  protectionChanged: 'user.protection.changed',
  coverageChanged: 'user.coverage.changed',
  chainStepResult: 'chain.step.result',
  devicePromptAnswered: 'device.prompt.answered',
  /** Amir uyarısı (T-021: operatör kilidi düştü). Konsol amir odasına yayınlar. */
  supervisorAlert: 'supervisor.alert',
  /** T-071 (D-07): yanlış alarm kaydı (kişi, olay, neden). */
  eventFalseAlarm: 'event.false_alarm',
};
exports.STEP_RESULTS = ['REACHED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'SKIPPED'];
//# sourceMappingURL=index.js.map
