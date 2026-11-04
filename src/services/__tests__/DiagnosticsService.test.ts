// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { DiagnosticsService } from '../DiagnosticsService';
import { EventBus, EVENT_NAMES } from '../EventBus';
import { ServiceRegistry } from '@core/ServiceRegistry';
import { DIAGNOSTICS_SERVICE_TOKEN, EVENT_BUS_TOKEN } from '@core/ServiceTokens';
import '@components/NCStatusIndicator';
import '@components/NCErrorList';

describe('DiagnosticsService and NCStatusIndicator', () => {
  let eventBus: EventBus;
  let diagnosticsService: DiagnosticsService;

  beforeEach(async () => {
    const registry = ServiceRegistry.getInstance();
    await registry.disposeAll();
    eventBus = new EventBus();
    diagnosticsService = new DiagnosticsService(eventBus);
    registry.register(EVENT_BUS_TOKEN, () => eventBus);
    registry.register(DIAGNOSTICS_SERVICE_TOKEN, () => diagnosticsService);
    document.body.innerHTML = '';
  });

  afterEach(async () => {
    document.body.replaceChildren();
    await ServiceRegistry.getInstance().disposeAll();
  });

  it('tracks execution errors and clears them on clean execution or plot clear', () => {
    const indicator = document.createElement('nc-status-indicator');
    document.body.appendChild(indicator);

    const statusSpan = () => indicator.shadowRoot?.querySelector('.status');
    const messageSpan = () => indicator.shadowRoot?.querySelector<HTMLElement>('.status-message');

    expect(statusSpan()?.textContent).toBe('Ready');
    expect(messageSpan()?.hidden).toBe(true);

    // Execution completed with line errors
    eventBus.publish(EVENT_NAMES.EXECUTION_COMPLETED, {
      channelId: '1',
      result: {
        executedLines: [],
        variableSnapshot: new Map(),
        namedVariableSnapshot: new Map(),
        timingData: new Map(),
        errors: [{ lineNumber: 12, message: 'Invalid G-code', severity: 'error' }],
      },
    });

    expect(diagnosticsService.getErrorCount()).toBe(1);
    expect(statusSpan()?.textContent).toBe('1 Error');
    expect(messageSpan()?.hidden).toBe(false);
    expect(messageSpan()?.textContent).toContain('Ch 1: Line 12: Invalid G-code');

    // Subsequent clean execution clears channel backend errors
    eventBus.publish(EVENT_NAMES.EXECUTION_COMPLETED, {
      channelId: '1',
      result: {
        executedLines: [1],
        variableSnapshot: new Map(),
        namedVariableSnapshot: new Map(),
        timingData: new Map(),
        errors: [],
      },
    });

    expect(diagnosticsService.getErrorCount()).toBe(0);
    expect(statusSpan()?.textContent).toBe('Ready');
    expect(messageSpan()?.hidden).toBe(true);

    // Runtime error via ERROR_OCCURRED
    eventBus.publish(EVENT_NAMES.ERROR_OCCURRED, {
      message: 'Failed to load machines from server, using defaults',
    });

    expect(diagnosticsService.getErrorCount()).toBe(1);
    expect(statusSpan()?.textContent).toBe('1 Error');
    expect(messageSpan()?.textContent).toBe('Failed to load machines from server, using defaults');

    // Plot clear resets diagnostics
    eventBus.publish(EVENT_NAMES.PLOT_CLEARED, undefined);
    expect(diagnosticsService.getErrorCount()).toBe(0);
    expect(statusSpan()?.textContent).toBe('Ready');
  });

  it('surfaces ERROR_OCCURRED in NCErrorList', () => {
    const errorList = document.createElement('nc-error-list');
    errorList.setAttribute('channel-id', '1');
    document.body.appendChild(errorList);

    eventBus.publish(EVENT_NAMES.ERROR_OCCURRED, {
      message: 'Cannot restore program machine: invalid or conflicting setup metadata',
    });

    const text = errorList.shadowRoot?.textContent ?? '';
    expect(text).toContain('Cannot restore program machine: invalid or conflicting setup metadata');
  });
});
