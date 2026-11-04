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
      const parseData = data as { channelId?: string; error?: { message?: string } | string } | undefined;
      const channelId = parseData?.channelId;
      if (channelId) {
        this.diagnostics = this.diagnostics.filter(
          (d) => !(d.channelId === channelId && d.category === 'parser'),
        );
      }
      const detailMessage =
        typeof parseData?.error === 'string'
          ? parseData.error
          : parseData?.error?.message;
      this.addDiagnostic({
        severity: 'error',
        category: 'parser',
        message: detailMessage || 'Parser error occurred',
        channelId,
        details: data,
      });
    });

    // Clear parser diagnostics for a channel when parsing succeeds, and record any parse faults
    this.eventBus.subscribe(EVENT_NAMES.PARSE_COMPLETED, (data: unknown) => {
      const parseData = data as {
        channelId?: string;
        result?: { faults?: FaultDetail[] };
      } | undefined;
      const channelId = parseData?.channelId;
      if (!channelId) return;

      const beforeCount = this.diagnostics.length;
      this.diagnostics = this.diagnostics.filter(
        (d) => !(d.channelId === channelId && d.category === 'parser'),
      );
      const faults = parseData?.result?.faults ?? [];
      if (faults.length > 0) {
        this.addFaults(faults, channelId);
      } else if (this.diagnostics.length !== beforeCount) {
        this.publishStateChanged();
      }
    });

    // Listen for completed execution to update per-channel backend diagnostics
    this.eventBus.subscribe(EVENT_NAMES.EXECUTION_COMPLETED, (data: unknown) => {
      const execData = data as {
        channelId?: string;
        result?: { errors?: FaultDetail[] };
      } | undefined;
      const channelId = execData?.channelId;
      if (channelId) {
        this.diagnostics = this.diagnostics.filter(
          (d) => !(d.channelId === channelId && d.category === 'backend'),
        );
      }
      // Clear previous runtime errors once a new execution completes cleanly
      this.diagnostics = this.diagnostics.filter((d) => d.category !== 'runtime');

      const errors = execData?.result?.errors ?? [];
      errors.forEach((fault) => {
        this.diagnostics.unshift({
          id: `diag-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
          timestamp: Date.now(),
          severity: fault.severity,
          category: 'backend',
          message: `Line ${fault.lineNumber}: ${fault.message}`,
          channelId,
          details: fault,
        });
      });
      this.trimDiagnostics();
      this.publishStateChanged();
    });

    // Listen for execution errors
    this.eventBus.subscribe(EVENT_NAMES.EXECUTION_ERROR, (data: unknown) => {
      const errorData = data as {
        channelId?: string;
        error?: { message?: string } | string;
      } | undefined;
      const channelId = errorData?.channelId;
      if (channelId) {
        this.diagnostics = this.diagnostics.filter(
          (d) => !(d.channelId === channelId && d.category === 'backend'),
        );
      }
      const detailMessage =
        typeof errorData?.error === 'string'
          ? errorData.error
          : errorData?.error?.message;
      this.addDiagnostic({
        severity: 'error',
        category: 'backend',
        message: detailMessage || 'Execution error occurred',
        channelId,
        details: data,
      });
    });

    // Clear diagnostics when the plot is cleared
    this.eventBus.subscribe(EVENT_NAMES.PLOT_CLEARED, () => {
      this.clear();
    });

    // Clear channel diagnostics when a channel is deactivated
    this.eventBus.subscribe(EVENT_NAMES.CHANNEL_DEACTIVATED, (data: unknown) => {
      const channelData = data as { channelId?: string } | undefined;
      if (channelData?.channelId) {
        this.clearChannel(channelData.channelId);
      }
    });

    // Listen for general errors
    this.eventBus.subscribe(EVENT_NAMES.ERROR_OCCURRED, (data: unknown) => {
      const errorData = data as { message?: string; error?: Error; channelId?: string };
      this.addDiagnostic({
        severity: 'error',
        category: 'runtime',
        message: errorData.message || 'Unknown error occurred',
        channelId: errorData.channelId,
        details: errorData.error,
      });
    });
  }

  private trimDiagnostics(): void {
    if (this.diagnostics.length > this.maxDiagnostics) {
      this.diagnostics = this.diagnostics.slice(0, this.maxDiagnostics);
    }
  }

  private publishStateChanged(): void {
    this.eventBus.publish(EVENT_NAMES.STATE_CHANGED, {
      diagnostics: this.diagnostics,
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
