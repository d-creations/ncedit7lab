// DiagnosticsService for aggregating errors and diagnostics

import { EventBus, EVENT_NAMES } from './EventBus';
import type { FaultDetail } from '@core/types';

export interface Diagnostic {
  id: string;
  timestamp: number;
  severity: 'error' | 'warning' | 'info';
  category: 'parser' | 'backend' | 'runtime' | 'network';
  message: string;
  details?: unknown;
  channelId?: string;
}

export class DiagnosticsService {
  private diagnostics: Diagnostic[] = [];
  private eventBus: EventBus;
  private maxDiagnostics = 100;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Listen for parser errors
    this.eventBus.subscribe(EVENT_NAMES.PARSE_ERROR, (data: unknown) => {
      this.addDiagnostic({
        severity: 'error',
        category: 'parser',
        message: 'Parser error occurred',
        details: data,
      });
    });

    // Listen for execution errors
    this.eventBus.subscribe(EVENT_NAMES.EXECUTION_ERROR, (data: unknown) => {
      this.addDiagnostic({
        severity: 'error',
        category: 'backend',
        message: 'Execution error occurred',
        details: data,
      });
    });

    // Listen for general errors
    this.eventBus.subscribe(EVENT_NAMES.ERROR_OCCURRED, (data: unknown) => {
      const errorData = data as { message?: string; error?: Error };
      this.addDiagnostic({
        severity: 'error',
        category: 'runtime',
        message: errorData.message || 'Unknown error occurred',
        details: errorData.error,
      });
    });
  }

  addDiagnostic(diagnostic: Omit<Diagnostic, 'id' | 'timestamp'>): void {
    const newDiagnostic: Diagnostic = {
      ...diagnostic,
      id: `diag-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      timestamp: Date.now(),
    };

    this.diagnostics.unshift(newDiagnostic);

    // Trim to max size
    if (this.diagnostics.length > this.maxDiagnostics) {
      this.diagnostics = this.diagnostics.slice(0, this.maxDiagnostics);
    }

    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, {
      diagnostics: this.diagnostics,
    });
  }

  addFaults(faults: FaultDetail[], channelId?: string): void {
    faults.forEach((fault) => {
      this.addDiagnostic({
        severity: fault.severity,
        category: 'parser',
        message: `Line ${fault.lineNumber}: ${fault.message}`,
        channelId,
        details: fault,
      });
    });
  }

  getDiagnostics(): Diagnostic[] {
    return [...this.diagnostics];
  }

  getRecentDiagnostics(count: number): Diagnostic[] {
    return this.diagnostics.slice(0, count);
  }

  getErrorCount(): number {
    return this.diagnostics.filter((d) => d.severity === 'error').length;
  }

  getWarningCount(): number {
    return this.diagnostics.filter((d) => d.severity === 'warning').length;
  }

  clear(): void {
    this.diagnostics = [];
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, { diagnostics: [] });
  }

  clearChannel(channelId: string): void {
    this.diagnostics = this.diagnostics.filter((d) => d.channelId !== channelId);
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, {
      diagnostics: this.diagnostics,
    });
  }
}
