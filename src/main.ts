// Main entry point for NC-Edit7 application

import { ServiceRegistry, ServiceScope } from '@core/ServiceRegistry';
import {
  EVENT_BUS_TOKEN,
  STATE_SERVICE_TOKEN,
  BACKEND_GATEWAY_TOKEN,
  MACHINE_SERVICE_TOKEN,
  PARSER_SERVICE_TOKEN,
  DIAGNOSTICS_SERVICE_TOKEN,
  EXECUTED_PROGRAM_SERVICE_TOKEN,
  PLOT_SERVICE_TOKEN,
  FILE_MANAGER_SERVICE_TOKEN,
  CONFIG_SERVICE_TOKEN,
  HOST_BRIDGE_SERVICE_TOKEN,
} from '@core/ServiceTokens';
import { EventBus } from '@services/EventBus';
import { StateService } from '@services/StateService';
import { BackendGateway } from '@services/BackendGateway';
import { MachineService } from '@services/MachineService';
import { ParserService } from '@services/ParserService';
import { DiagnosticsService } from '@services/DiagnosticsService';
import { ExecutedProgramService } from '@services/ExecutedProgramService';
import { PlotService } from '@services/PlotService';
import { FileManagerService } from '@services/FileManagerService';
import { VsCodeFileManagerService } from '@services/VsCodeFileManagerService';
import { VsCodeConfigService } from '@services/config/VsCodeConfigService';
import { WebConfigService } from '@services/config/WebConfigService';
import { BrowserHostBridgeService, VsCodeHostBridgeService } from '@services/HostBridgeService';
import type { ExecutedProgramResult } from '@core/types';
import { EVENT_NAMES } from '@services/EventBus';
import '@components/NCEditorApp';
import '@components/NCWorkbenchPanelApp';

function applyThemeMode(themeMode: 'vscode' | 'one-dark' | 'light', isVSCode: boolean) {
  const body = document.body;
  const root = document.documentElement;
  if (!body || !root) return;

  const oneDarkPalette: Record<string, string> = {
    '--vscode-editor-background': '#282c34',
    '--vscode-editor-foreground': '#abb2bf',
    '--vscode-editorGroupHeader-tabsBackground': '#21252b',
    '--vscode-editorGroup-border': '#181a1f',
    '--vscode-tab-activeBackground': '#282c34',
    '--vscode-tab-activeForeground': '#abb2bf',
    '--vscode-tab-inactiveBackground': '#21252b',
    '--vscode-tab-inactiveForeground': '#7f848e',
    '--vscode-tab-activeBorderTop': '#61afef',
    '--vscode-sideBar-background': '#21252b',
    '--vscode-sideBar-border': '#181a1f',
    '--vscode-button-background': '#61afef',
    '--vscode-button-foreground': '#1f2329',
    '--vscode-button-hoverBackground': '#70b7ff',
    '--vscode-button-secondaryBackground': '#3a3f4b',
    '--vscode-button-secondaryForeground': '#abb2bf',
    '--vscode-input-background': '#3c3f41',
    '--vscode-input-foreground': '#abb2bf',
    '--vscode-input-border': '#181a1f',
    '--vscode-disabledForeground': '#7f848e',
    '--vscode-textLink-foreground': '#61afef',
    '--vscode-widget-border': '#181a1f',
    '--vscode-statusBar-background': '#21252b',
    '--vscode-statusBar-foreground': '#abb2bf',
    '--vscode-inputValidation-errorBackground': '#e06c75',
    '--vscode-inputValidation-errorForeground': '#1f2329',
    '--vscode-descriptionForeground': '#7f848e',
    '--vscode-list-hoverBackground': 'rgba(255, 255, 255, 0.05)',
    '--vscode-editor-lineHighlightBackground': '#2c313c',
    '--vscode-editorHoverWidget-border': '#3e4451',
    '--vscode-editorCursor-foreground': '#61afef',
    '--vscode-editorLineNumber-activeForeground': '#abb2bf',
    '--vscode-titleBar-activeBackground': '#21252b',
    '--vscode-focusBorder': '#528bff',
    '--vscode-editorWidget-background': '#21252b'
  };

  const lightPalette: Record<string, string> = {
    '--vscode-editor-background': '#ffffff',
    '--vscode-editor-foreground': '#24292f',
    '--vscode-editorGroupHeader-tabsBackground': '#f6f8fa',
    '--vscode-editorGroup-border': '#d0d7de',
    '--vscode-tab-activeBackground': '#ffffff',
    '--vscode-tab-activeForeground': '#24292f',
    '--vscode-tab-inactiveBackground': '#f6f8fa',
    '--vscode-tab-inactiveForeground': '#57606a',
    '--vscode-tab-activeBorderTop': '#0969da',
    '--vscode-sideBar-background': '#f6f8fa',
    '--vscode-sideBar-border': '#d0d7de',
    '--vscode-button-background': '#0969da',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-hoverBackground': '#0860ca',
    '--vscode-button-secondaryBackground': '#eaeef2',
    '--vscode-button-secondaryForeground': '#24292f',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-foreground': '#24292f',
    '--vscode-input-border': '#d0d7de',
    '--vscode-disabledForeground': '#6e7781',
    '--vscode-textLink-foreground': '#0969da',
    '--vscode-widget-border': '#d0d7de',
    '--vscode-statusBar-background': '#f6f8fa',
    '--vscode-statusBar-foreground': '#24292f',
    '--vscode-inputValidation-errorBackground': '#ffebe9',
    '--vscode-inputValidation-errorForeground': '#24292f',
    '--vscode-descriptionForeground': '#57606a',
    '--vscode-list-hoverBackground': '#f3f4f6',
    '--vscode-editor-lineHighlightBackground': '#f6f8fa',
    '--vscode-editorHoverWidget-border': '#d0d7de',
    '--vscode-editorCursor-foreground': '#0969da',
    '--vscode-editorLineNumber-activeForeground': '#24292f',
    '--vscode-titleBar-activeBackground': '#f6f8fa',
    '--vscode-focusBorder': '#0969da',
    '--vscode-editorWidget-background': '#f6f8fa'
  };

  const overridePalette = themeMode === 'one-dark' ? oneDarkPalette : themeMode === 'light' ? lightPalette : undefined;
  body.dataset.themeMode = themeMode;
  root.dataset.themeMode = themeMode;

  const knownKeys = new Set([...Object.keys(oneDarkPalette), ...Object.keys(lightPalette)]);
  for (const key of knownKeys) {
    body.style.removeProperty(key);
    root.style.removeProperty(key);
  }

  if (themeMode === 'vscode' && isVSCode) {
    return;
  }

  const palette = overridePalette ?? oneDarkPalette;
  for (const [key, value] of Object.entries(palette)) {
    body.style.setProperty(key, value);
    root.style.setProperty(key, value);
  }
}

// Bootstrap application
async function bootstrap() {
  try {
    const registry = ServiceRegistry.getInstance();

    // Determine environment
    // @ts-ignore
    const isVSCode = window.acquireVsCodeApi !== undefined || (window.parent && window.parent !== window);

    // Register Config Service early (Factory/Strategy pattern based on environment)
    registry.register(
      CONFIG_SERVICE_TOKEN,
      () => isVSCode ? new VsCodeConfigService() : new WebConfigService(),
      ServiceScope.Singleton
    );

    const configService = registry.get(CONFIG_SERVICE_TOKEN);
    const initialConfig = await configService.getConfig();

    registry.register(
      HOST_BRIDGE_SERVICE_TOKEN,
      () => initialConfig.hostMode.startsWith('vscode') ? new VsCodeHostBridgeService() : new BrowserHostBridgeService(),
      ServiceScope.Singleton,
    );

    const syncTheme = (config: { themeMode: 'vscode' | 'one-dark' | 'light' }) => {
      applyThemeMode(config.themeMode, isVSCode);
    };
    syncTheme(initialConfig);
    configService.onConfigChanged(syncTheme);

    // Register services using the tokens directly
    registry.register(EVENT_BUS_TOKEN, () => new EventBus(), ServiceScope.Singleton);

    registry.register(BACKEND_GATEWAY_TOKEN, () => new BackendGateway(), ServiceScope.Singleton);

    registry.register(
      STATE_SERVICE_TOKEN,
      () => {
        const eventBus = registry.get(EVENT_BUS_TOKEN);
        // @ts-ignore
        const isVSCode = window.acquireVsCodeApi !== undefined || (window.parent && window.parent !== window);
        // Turn off local storage persistence for StateService in VS Code
        return new StateService(eventBus, !isVSCode);
      },
      ServiceScope.Singleton,
    );

    registry.register(
      FILE_MANAGER_SERVICE_TOKEN,
      () => {
        const eventBus = registry.get(EVENT_BUS_TOKEN);
        const stateService = registry.get(STATE_SERVICE_TOKEN);
        
        // CLEAN ARCHITECTURE: Detect if we are running inside VS Code / Theia
        // If so, inject the VsCodeFileManagerService, otherwise fallback to the web FileManagerService
        // @ts-ignore
        const isVSCode = window.acquireVsCodeApi !== undefined || (window.parent && window.parent !== window);
        
        if (isVSCode) {
            console.log("Running in Desktop/IDE Mode: Injecting VsCodeFileManagerService");
            return new VsCodeFileManagerService(eventBus, stateService);
        } else {
            console.log("Running in Web Mode: Injecting standard FileManagerService");
            return new FileManagerService(eventBus, stateService);
        }
      },
      ServiceScope.Singleton,
    );

    registry.register(
      MACHINE_SERVICE_TOKEN,
      () => {
        const backend = registry.get(BACKEND_GATEWAY_TOKEN);
        const eventBus = registry.get(EVENT_BUS_TOKEN);
        return new MachineService(backend, eventBus);
      },
      ServiceScope.Singleton,
    );

    registry.register(
      PARSER_SERVICE_TOKEN,
      () => {
        const eventBus = registry.get(EVENT_BUS_TOKEN);
        return new ParserService(eventBus);
      },
      ServiceScope.Singleton,
    );

    registry.register(
      DIAGNOSTICS_SERVICE_TOKEN,
      () => {
        const eventBus = registry.get(EVENT_BUS_TOKEN);
        return new DiagnosticsService(eventBus);
      },
      ServiceScope.Singleton,
    );

    registry.register(
      EXECUTED_PROGRAM_SERVICE_TOKEN,
      () => {
        const backend = registry.get(BACKEND_GATEWAY_TOKEN);
        const eventBus = registry.get(EVENT_BUS_TOKEN);
        return new ExecutedProgramService(backend, eventBus);
      },
      ServiceScope.Singleton,
    );

    registry.register(
      PLOT_SERVICE_TOKEN,
      () => {
        const eventBus = registry.get(EVENT_BUS_TOKEN);
        return new PlotService(eventBus);
      },
      ServiceScope.Singleton,
    );

    const hostBridge = registry.get(HOST_BRIDGE_SERVICE_TOKEN);
    if (
      initialConfig.hostMode === 'vscode-editor' &&
      hostBridge.isAvailable()
    ) {
      const eventBus = registry.get(EVENT_BUS_TOKEN);

      const serializeExecutionResult = (result: ExecutedProgramResult) => ({
        variableSnapshotEntries: Array.from(result.variableSnapshot.entries()),
        errors: result.errors || [],
      });

      eventBus.subscribe(EVENT_NAMES.EXECUTION_COMPLETED, (data: unknown) => {
        const executionData = data as { channelId: string; result: ExecutedProgramResult };
        hostBridge.relayToWorkbench({
          type: 'WORKBENCH_BRIDGE',
          eventType: 'EXECUTION_COMPLETED',
          payload: {
            channelId: executionData.channelId,
            result: serializeExecutionResult(executionData.result),
          },
        });
      });

      eventBus.subscribe(EVENT_NAMES.EXECUTION_ERROR, (data: unknown) => {
        const errorData = data as { channelId: string; error: { message?: string } };
        hostBridge.relayToWorkbench({
          type: 'WORKBENCH_BRIDGE',
          eventType: 'EXECUTION_ERROR',
          payload: {
            channelId: errorData.channelId,
            error: {
              message: errorData.error?.message || 'Unknown execution error',
            },
          },
        });
      });

      eventBus.subscribe(EVENT_NAMES.PLOT_CLEARED, () => {
        hostBridge.relayToWorkbench({
          type: 'WORKBENCH_BRIDGE',
          eventType: 'PLOT_CLEARED',
          payload: {},
        });
      });
    }

    // Initialize the app
    if (initialConfig.hostMode === 'vscode-panel') {
      const appElement = document.createElement('nc-workbench-panel-app');
      const appContainer = document.getElementById('app-root') || document.getElementById('app');
      if (!appContainer) throw new Error('App container not found');
      appContainer.innerHTML = '';
      appContainer.appendChild(appElement);
    } else {
      const appElement = document.createElement('nc-editor-app');
      const appContainer = document.getElementById('app');
      if (!appContainer) throw new Error('App container not found');
      appContainer.innerHTML = '';
      appContainer.appendChild(appElement);
    }

    console.log('NC-Edit7 application initialized successfully');
  } catch (error) {
    console.error('Failed to bootstrap application:', error);

    const appContainer = document.getElementById('app');
    if (appContainer) {
      appContainer.innerHTML = `
        <div style="
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          flex-direction: column;
          gap: 16px;
        ">
          <div style="color: #f48771; font-size: 24px;">Failed to Initialize</div>
          <div style="color: #d4d4d4;">
            ${error instanceof Error ? error.message : 'Unknown error'}
          </div>
          <button 
            onclick="location.reload()" 
            style="
              padding: 8px 16px;
              background: #0e639c;
              color: #fff;
              border: none;
              border-radius: 4px;
              cursor: pointer;
            "
          >
            Reload
          </button>
        </div>
      `;
    }
  }
}

// Error handling - catch console errors and prevent endless loops
let errorCount = 0;
const ERROR_THRESHOLD = 10;
const ERROR_RESET_INTERVAL = 5000; // 5 seconds

// Reset error count periodically
setInterval(() => {
  if (errorCount > 0) {
    errorCount = Math.max(0, errorCount - 1);
  }
}, ERROR_RESET_INTERVAL);

window.addEventListener('error', (event) => {
  errorCount++;
  console.error('Global error:', event.error);

  // Prevent endless loops by stopping if too many errors
  if (errorCount > ERROR_THRESHOLD) {
    console.error('Too many errors detected, stopping execution to prevent infinite loops');
    event.preventDefault();
    const appContainer = document.getElementById('app');
    if (appContainer) {
      appContainer.innerHTML = `
        <div style="
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          flex-direction: column;
          gap: 16px;
          padding: 24px;
          text-align: center;
        ">
          <div style="color: #f48771; font-size: 24px;">⚠️ Too Many Errors</div>
          <div style="color: #d4d4d4; max-width: 600px;">
            The application has encountered too many errors in a short period. 
            This may indicate an infinite loop or critical issue. 
            Please reload the page to try again.
          </div>
          <button 
            onclick="location.reload()" 
            style="
              padding: 8px 16px;
              background: #0e639c;
              color: #fff;
              border: none;
              border-radius: 4px;
              cursor: pointer;
            "
          >
            Reload Application
          </button>
        </div>
      `;
    }
  }
});

window.addEventListener('unhandledrejection', (event) => {
  errorCount++;
  console.error('Unhandled promise rejection:', event.reason);

  // Check if it's a network error (server offline)
  const isNetworkError =
    event.reason instanceof Error &&
    (event.reason.message.includes('fetch') ||
      event.reason.message.includes('network') ||
      event.reason.message.includes('HTTP error'));

  if (isNetworkError) {
    console.warn('Server appears to be offline or unreachable');
    // Don't count network errors as aggressively
    errorCount = Math.max(0, errorCount - 1);
  }
});

// Start the application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

// Cleanup on page unload
window.addEventListener('beforeunload', async () => {
  const registry = ServiceRegistry.getInstance();
  await registry.disposeAll();
});
