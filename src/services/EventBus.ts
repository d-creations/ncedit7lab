// EventBus for application-level event handling

export type EventHandler<T = unknown> = (data: T) => void;

export interface EventSubscription {
  unsubscribe(): void;
}

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  subscribe<T>(eventName: string, handler: EventHandler<T>): EventSubscription {
    if (!this.handlers.has(eventName)) {
      this.handlers.set(eventName, new Set());
    }

    const handlers = this.handlers.get(eventName)!;
    handlers.add(handler as EventHandler);

    return {
      unsubscribe: () => {
        handlers.delete(handler as EventHandler);
        if (handlers.size === 0) {
          this.handlers.delete(eventName);
        }
      },
    };
  }

  publish<T>(eventName: string, data: T): void {
    const handlers = this.handlers.get(eventName);
    if (!handlers) return;

    handlers.forEach((handler) => {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for ${eventName}:`, error);
      }
    });
  }

  clear(eventName?: string): void {
    if (eventName) {
      this.handlers.delete(eventName);
    } else {
      this.handlers.clear();
    }
  }
}

// Event names constants
export const EVENT_NAMES = {
  STATE_CHANGED: 'state:changed',
  CHANNEL_ACTIVATED: 'channel:activated',
  CHANNEL_DEACTIVATED: 'channel:deactivated',
  MACHINE_CHANGED: 'machine:changed',
  PARSE_COMPLETED: 'parse:completed',
  PARSE_ERROR: 'parse:error',
  EXECUTION_COMPLETED: 'execution:completed',
  EXECUTION_ERROR: 'execution:error',
  PLOT_UPDATED: 'plot:updated',
  PLOT_REQUEST: 'plot:request',
  PLOT_CLEARED: 'plot:cleared',
  ERROR_OCCURRED: 'error:occurred',
  EDITOR_CURSOR_MOVED: 'editor:cursor_moved',
} as const;
