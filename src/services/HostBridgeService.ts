export type WorkbenchTab = 'variables' | 'errors' | 'focas';

export type WorkbenchBridgeMessage =
  | {
      type: 'WORKBENCH_BRIDGE';
      eventType: 'EXECUTION_COMPLETED';
      payload: {
        channelId: string;
        result: {
          variableSnapshotEntries: Array<[number, number]>;
          errors: unknown[];
        };
      };
    }
  | {
      type: 'WORKBENCH_BRIDGE';
      eventType: 'EXECUTION_ERROR';
      payload: {
        channelId: string;
        error: {
          message: string;
        };
      };
    }
  | {
      type: 'WORKBENCH_BRIDGE';
      eventType: 'PLOT_CLEARED';
      payload: Record<string, never>;
    };

export interface IHostBridgeService {
  isAvailable(): boolean;
  relayToWorkbench(message: WorkbenchBridgeMessage): void;
  openWorkbenchPanel(tab?: WorkbenchTab): void;
  notifyDocumentChanged(channel: string, text: string, oldText: string): void;
}

type VsCodeApi = {
  postMessage: (message: unknown) => void;
};

export class BrowserHostBridgeService implements IHostBridgeService {
  isAvailable(): boolean {
    return false;
  }

  relayToWorkbench(_message: WorkbenchBridgeMessage): void {}

  openWorkbenchPanel(_tab?: WorkbenchTab): void {}
  notifyDocumentChanged(_channel: string, _text: string, _oldText: string): void {}
}

export class VsCodeHostBridgeService implements IHostBridgeService {
  private api?: VsCodeApi;

  constructor() {
    const win = window as Window & {
      vscodeApi?: VsCodeApi;
      acquireVsCodeApi?: () => VsCodeApi;
    };

    win.vscodeApi = win.vscodeApi || (typeof win.acquireVsCodeApi === 'function' ? win.acquireVsCodeApi() : undefined);
    this.api = win.vscodeApi;

    window.addEventListener('message', this.handleHostMessage.bind(this));
  }

  private handleHostMessage(event: MessageEvent) {
    const data = event.data;
    if (data && typeof data === 'object') {
      if (data.type === 'UNDO_APPLIED' || data.type === 'REDO_APPLIED') {
        const { channel, text } = data;
        if (channel && text !== undefined) {
          // Trigger a custom event that VsCodeFileManagerService can handle 
          // without triggering another 'changed' response
          window.dispatchEvent(new CustomEvent('vscode:host-undo-redo', { 
            detail: { type: data.type, channel, text } 
          }));
        }
      }
    }
  }

  notifyDocumentChanged(channel: string, text: string, oldText: string): void {
    this.api?.postMessage({
      type: 'changed',
      channel,
      text,
      oldText,
    });
  }

  isAvailable(): boolean {
    return typeof this.api?.postMessage === 'function';
  }

  relayToWorkbench(message: WorkbenchBridgeMessage): void {
    this.api?.postMessage({
      type: 'workbench:relay',
      message,
    });
  }

  openWorkbenchPanel(tab?: WorkbenchTab): void {
    this.api?.postMessage({
      type: 'workbench:open-panel',
      tab,
    });
  }
}