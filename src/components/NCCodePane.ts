import { ServiceRegistry } from '@core/ServiceRegistry';
import { PARSER_SERVICE_TOKEN, EVENT_BUS_TOKEN, STATE_SERVICE_TOKEN, FILE_MANAGER_SERVICE_TOKEN } from '@core/ServiceTokens';
import { ParserService } from '@services/ParserService';
import { StateService } from '@services/StateService';
import { IFileManagerService } from '@services/IFileManagerService';
import { EventBus, EVENT_NAMES, EventSubscription } from '@services/EventBus';
import type { ChannelId, ExecutedProgramResult, FaultDetail, NCProgram } from '@core/types';
// @ts-expect-error - ACE module doesn't export types correctly
import ace from 'ace-builds/src-noconflict/ace';
import 'ace-builds/src-noconflict/mode-text';
import 'ace-builds/src-noconflict/theme-github';
import 'ace-builds/src-noconflict/theme-one_dark';
import 'ace-builds/src-noconflict/ext-searchbox';

// Mobile breakpoint - matches the media query in NCEditorApp.ts
const MOBILE_BREAKPOINT = 768;

export class NCCodePane extends HTMLElement {
  private editor?: ace.Ace.Editor;
  private parserService: ParserService;
  private stateService: StateService;
  private fileManager: IFileManagerService;
  private eventBus: EventBus;
  private channelId: ChannelId = '1';
  private resizeObserver?: ResizeObserver;
  private executedLineMarkers: number[] = [];
  private errorMarkers: number[] = [];
  private executionSubscription?: EventSubscription;
  private plotClearedSubscription?: EventSubscription;
  private machineChangedSubscription?: EventSubscription;
  private themeObserver?: MutationObserver;

  constructor() {
    super();
    // ACE editor has issues with Shadow DOM, so we render directly to light DOM
    const registry = ServiceRegistry.getInstance();
    this.parserService = registry.get(PARSER_SERVICE_TOKEN);
    this.stateService = registry.get(STATE_SERVICE_TOKEN);
    this.fileManager = registry.get(FILE_MANAGER_SERVICE_TOKEN);
    this.eventBus = registry.get(EVENT_BUS_TOKEN);
  }

  static get observedAttributes() {
    return ['channel-id'];
  }

  attributeChangedCallback(name: string, _oldValue: string, newValue: string) {
    if (name === 'channel-id') {
      this.channelId = newValue as ChannelId;
    }
  }

  connectedCallback() {
    this.render();
    this.initEditor();
    this.setupEventListeners();
    
    const activeProgram = this.fileManager.getActiveProgram(this.channelId);
    if (activeProgram) {
        this.setValue(activeProgram.content);
      this.stateService.updateChannel(this.channelId, { program: activeProgram.content });
    }
  }

  private setupEventListeners() {
    // Listen for keyword clicks
    this.addEventListener('keyword-click', ((e: CustomEvent) => {
      const lineNumber = e.detail.lineNumber;
      this.scrollToLine(lineNumber);
    }) as EventListener);

    // Listen for execution completed events to highlight executed lines
    this.executionSubscription = this.eventBus.subscribe(
      EVENT_NAMES.EXECUTION_COMPLETED,
      (data: unknown) => {
        const executionData = data as {
          channelId: string;
          result?: ExecutedProgramResult;
        };

        // Only highlight if this is for our channel
        if (executionData.channelId === this.channelId && executionData.result) {
          this.highlightExecutedLines(executionData.result);

          if (executionData.result.errors && executionData.result.errors.length > 0) {
            this.showErrors(executionData.result.errors);
          } else {
            this.clearErrors();
          }
        }
      },
    );

    // Listen for plot cleared events to remove executed line highlighting
    this.plotClearedSubscription = this.eventBus.subscribe(EVENT_NAMES.PLOT_CLEARED, () => {
      this.clearExecutedLineMarkers();
      this.clearErrors();
    });

    // Listen for machine changes to re-parse with new regex patterns
    this.machineChangedSubscription = this.eventBus.subscribe(EVENT_NAMES.MACHINE_CHANGED, () => {
      this.triggerParse();
      this.updateSyntaxHighlighting();
    });

    this.eventBus.subscribe('program:active_changed', (data: { channelId: string, program: NCProgram | null }) => {
      if (data.channelId === this.channelId) {
        if (data.program) {
          this.setValue(data.program.content);
          this.stateService.updateChannel(this.channelId, { program: data.program.content });
        } else {
          this.setValue('');
          this.stateService.updateChannel(this.channelId, { program: '' });
        }
      }
    });

    this.eventBus.subscribe('program:content_changed', (data: { channelId: string, program: NCProgram }) => {
      if (data.channelId === this.channelId && this.editor) {
        // Only update if it actually differs from what we currently have
        // This catches VS Code 'Undo/Redo' events safely.
        // Normalize CRLF to LF to prevent continuous loop triggers on Windows
        const editorText = this.editor.getValue().replace(/\r\n/g, '\n');
        const incomingText = data.program.content.replace(/\r\n/g, '\n');
        if (editorText !== incomingText) {
            this.setValue(incomingText);
            this.stateService.updateChannel(this.channelId, { program: incomingText });
        }
      }
    });
  }

  disconnectedCallback() {
    if (this.executionSubscription) {
      this.executionSubscription.unsubscribe();
    }
    if (this.plotClearedSubscription) {
      this.plotClearedSubscription.unsubscribe();
    }
    if (this.machineChangedSubscription) {
      this.machineChangedSubscription.unsubscribe();
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.themeObserver) {
      this.themeObserver.disconnect();
    }
    if (this.editor) {
      this.editor.destroy();
      this.editor = undefined;
    }
  }

  private render() {
    // Ensure host has dimensions and block display
    this.style.display = 'block';
    this.style.width = '100%';
    this.style.height = '100%';
    this.style.position = 'relative';

    // Use a class instead of ID to avoid conflicts across multiple instances
    this.innerHTML = `
      <style>
        .ace_editor {
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', 'source-code-pro', monospace !important;
          background-color: var(--vscode-editor-background, #282c34) !important;
          color: var(--vscode-editor-foreground, #abb2bf) !important;
        }
        
        /* Layering fixes to ensure text is always on top of markers */
        .ace_marker-layer {
            z-index: 1 !important;
        }
        .ace_text-layer {
            z-index: 2 !important;
          color: var(--vscode-editor-foreground, #abb2bf) !important;
        }
        .ace_cursor-layer {
            z-index: 3 !important;
        }
        
        .ace_line {
            /* Allow syntax highlighting to work, but default to white */
            color: inherit;
        }

        .ace_executed-line {
            position: absolute;
            background-color: rgba(0, 128, 0, 0.2) !important;
            border-left: 3px solid #4ec9b0 !important;
        }

        .ace_error-line {
            position: absolute;
            background-color: rgba(255, 0, 0, 0.2) !important;
            border-bottom: 1px dotted #ff0000 !important;
        }
        
        /* Improve active line visibility */
        .ace_marker-layer .ace_active-line {
          background-color: var(--vscode-editor-lineHighlightBackground, #2c313c) !important;
          border-top: 1px solid var(--vscode-editorHoverWidget-border, #3e4451);
          border-bottom: 1px solid var(--vscode-editorHoverWidget-border, #3e4451);
        }
        .ace_gutter-active-line {
          background-color: var(--vscode-editor-lineHighlightBackground, #2c313c) !important;
          color: var(--vscode-editorLineNumber-activeForeground, var(--vscode-editor-foreground, #abb2bf)) !important;
        }
        .ace_cursor {
          color: var(--vscode-editorCursor-foreground, #61afef) !important;
          border-left: 2px solid var(--vscode-editorCursor-foreground, #61afef) !important;
        }
        
        /* Mobile touch support for text selection and copy */
        @media (max-width: 768px) {
          .ace_editor {
            /* Enable text selection on touch devices */
            -webkit-user-select: text !important;
            user-select: text !important;
            /* Prevent zooming interference with selection */
            touch-action: manipulation;
          }
          .ace_content {
            -webkit-user-select: text !important;
            user-select: text !important;
          }
          .ace_text-layer {
            -webkit-user-select: text !important;
            user-select: text !important;
          }
          .ace_scroller {
            /* Improve scrolling behavior on mobile */
            -webkit-overflow-scrolling: touch;
          }
        }
      </style>
      <div class="pane-wrapper" style="display: flex; flex-direction: column; width: 100%; height: 100%;">
        <div class="pane-header" style="height: 20px; background-color: var(--vscode-editorGroupHeader-tabsBackground, #21252b); border-bottom: 1px solid var(--vscode-editorGroup-border, #181a1f); display: flex; flex-shrink: 0; display: none;">
            <div class="editor-header-spacer" style="flex: 1;"></div>
          <div class="timing-header" style="width: 60px; color: var(--vscode-descriptionForeground, #7f848e); font-size: 10px; text-align: center; line-height: 20px; border-left: 1px solid var(--vscode-editorGroup-border, #181a1f);">TIME</div>
        </div>
        <div class="pane-body" style="flex: 1; display: flex; position: relative; overflow: hidden;">
          <div class="ace-editor-container" style="flex: 1; position: relative; font-size: 14px; background-color: var(--vscode-editor-background, #282c34); color: var(--vscode-editor-foreground, #abb2bf); z-index: 1;"></div>
          <div class="timing-gutter" style="width: 60px; background-color: var(--vscode-editor-background, #282c34); border-left: 1px solid var(--vscode-editorGroup-border, #181a1f); overflow: hidden; position: relative; display: none;">
                <div class="timing-content" style="position: absolute; top: 0; left: 0; width: 100%;"></div>
            </div>
        </div>
      </div>
    `;
  }

  private initEditor() {
    const editorElement = this.querySelector('.ace-editor-container') as HTMLElement;
    if (!editorElement) return;

    // Ensure the container has explicit dimensions before initializing ACE
    const rect = this.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // Fallback if not yet laid out
      editorElement.style.width = '100%';
      editorElement.style.height = '100%';
    }

    this.editor = ace.edit(editorElement, {
      mode: 'ace/mode/text', // TODO: Custom NC mode
      theme: 'ace/theme/one_dark',
      fontSize: 14,
      showPrintMargin: false,
      showGutter: true,
      highlightActiveLine: true,
      readOnly: false,
      value: "", // Start empty, let FileManager provide content
    });

    // Enable native scrolling and better mobile support
    this.editor.setOption('scrollPastEnd', 0.5);
    this.editor.setOption('useWorker', false);

    // Sync scrolling with timing gutter
    this.editor.session.on('changeScrollTop', (scrollTop: number) => {
      const timingContent = this.querySelector('.timing-content') as HTMLElement;
      if (timingContent) {
        timingContent.style.transform = `translateY(-${scrollTop}px)`;
      }
    });

    // Check if mobile and adjust settings for better touch handling
    const isMobile = window.innerWidth <= MOBILE_BREAKPOINT || 'ontouchstart' in window;
    if (isMobile) {
      this.editor.setOption('enableMobileMenu', true);
      // Larger font for easier touch interaction on mobile
      this.editor.setFontSize(16);
    }

    this.applyEditorTheme();
    if (this.isVsCodeHost()) {
      this.themeObserver = new MutationObserver(() => this.applyEditorTheme());
      this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme-mode'] });
    }

    // Use ResizeObserver to handle dynamic layout changes
    this.resizeObserver = new ResizeObserver(() => {
      this.editor?.resize();
    });
    this.resizeObserver.observe(this);

    // Trigger initial parse
    this.triggerParse();
    setTimeout(() => this.updateSyntaxHighlighting(), 100);

    this.editor.on('change', () => {
      if (this.isSettingValue) return;
      const value = this.editor?.getValue() || '';
      this.fileManager.updateActiveProgramContent(this.channelId, value);
      this.stateService.updateChannel(this.channelId, { program: value });
      this.dispatchEvent(
        new CustomEvent('code-change', {
          detail: { channelId: this.channelId, code: value },
          bubbles: true,
          composed: true,
        }),
      );

      // Trigger parse
      this.triggerParse();
    });

    // Listen for cursor changes to highlight corresponding plot segment
    this.editor.selection.on('changeCursor', () => {
      if (!this.editor) return;
      const cursorPosition = this.editor.getCursorPosition();
      // Ace uses 0-based rows, but our NC parser/plotter uses 1-based line numbers
      const lineNumber = cursorPosition.row + 1;

      this.eventBus.publish(EVENT_NAMES.EDITOR_CURSOR_MOVED, {
        channelId: this.channelId,
        lineNumber: lineNumber,
      });
    });
  }

  private updateSyntaxHighlighting() {
    const activeMachine = this.stateService.getState().activeMachine;
    if (activeMachine && activeMachine.controlType) {
        this.applySyntaxRules(activeMachine.controlType);
    } else {
        this.applySyntaxRules("FANUC_MILL");
    }
  }

  private isVsCodeHost(): boolean {
    // @ts-ignore
    return window.acquireVsCodeApi !== undefined || (window.parent && window.parent !== window);
  }

  private applyEditorTheme(): void {
    if (!this.editor) return;

    const themeMode = document.body.dataset.themeMode || (this.isVsCodeHost() ? 'vscode' : 'one-dark');
    if (themeMode === 'light') {
      this.editor.setTheme('ace/theme/github');
      return;
    }
    if (themeMode === 'one-dark') {
      this.editor.setTheme('ace/theme/one_dark');
      return;
    }

    const useLightTheme = this.isVsCodeHost() && document.body.classList.contains('vscode-light');
    this.editor.setTheme(useLightTheme ? 'ace/theme/github' : 'ace/theme/one_dark');
  }

  private async applySyntaxRules(controlType: string) {
    try {
      const port = (window as any).backendPort || 8000;
      const portUrl = `http://127.0.0.1:${port}`;
      const response = await fetch(`${portUrl}/api/syntax/${controlType}`);
      if (!response.ok) throw new Error("Failed to load syntax");
      const data = await response.json();
      
      const machineRules = data.rules || [];
      const modeName = `ace/mode/nc_${controlType.toLowerCase()}`;
      
      // ACE requires dynamic modules to be defined before use
      ace.define(`${modeName}_highlight_rules`, ["require", "exports", "module", "ace/lib/oop", "ace/mode/text_highlight_rules"], function(require: any, exports: any, _module: any) {
          const oop = require("ace/lib/oop");
          const TextHighlightRules = require("ace/mode/text_highlight_rules").TextHighlightRules;

          const NCRules = function(this: any) {
              this.$rules = {
                  "start": machineRules
              };
          };

          oop.inherits(NCRules, TextHighlightRules);
          exports.NCRules = NCRules;
      });

      ace.define(modeName, ["require", "exports", "module", "ace/lib/oop", "ace/mode/text", `${modeName}_highlight_rules`], function(require: any, exports: any, _module: any) {
          const oop = require("ace/lib/oop");
          const TextMode = require("ace/mode/text").Mode;
          const NCRules = require(`${modeName}_highlight_rules`).NCRules;

          const Mode = function(this: any) {
              this.HighlightRules = NCRules;
          };

          oop.inherits(Mode, TextMode);
          exports.Mode = Mode;
      });

      if (this.editor && this.editor.session) {
        this.editor.session.setMode(modeName);
        console.log(`Applied syntax highlighting mode: ${modeName} via backend`);
      }
    } catch (e) {
      console.error("Syntax Highlighting Error:", e);
    }
  }

  private triggerParse() {
    if (!this.editor) return;
    const value = this.editor.getValue();
    const activeMachine = this.stateService.getState().activeMachine;
    const regexPatterns = activeMachine?.regexPatterns;

    this.parserService.parse(value, this.channelId, { regexPatterns });
  }

  private isSettingValue = false;

  setValue(code: string) {
    if (this.editor && this.editor.getValue() !== code) {
      this.isSettingValue = true;
      const cursor = this.editor.getCursorPosition();
      // Use doc.setValue to avoid wiping the Ace UndoManager stack history.
      this.editor.session.doc.setValue(code);
      this.editor.clearSelection();
      this.editor.moveCursorToPosition(cursor);
      this.isSettingValue = false;
    }
  }

  getValue(): string {
    return this.editor?.getValue() || '';
  }

  scrollToLine(lineNumber: number): void {
    if (!this.editor) return;

    // Convert to 0-based index
    const line = lineNumber - 1;

    // Scroll to line
    this.editor.scrollToLine(line, true, true, () => {
      // Callback after scroll
    });

    // Select the line
    this.editor.gotoLine(lineNumber, 0, true);

    // Highlight the line temporarily
    const Range = ace.require('ace/range').Range;
    const marker = this.editor.session.addMarker(
      new Range(line, 0, line, 1),
      'ace_active-line',
      'fullLine',
    );

    // Remove highlight after 2 seconds
    setTimeout(() => {
      this.editor?.session.removeMarker(marker);
    }, 2000);
  }

  /**
   * Highlights lines in the editor that have been executed/plotted.
   * Called when execution completes to show which lines were processed.
   */
  highlightExecutedLines(result: ExecutedProgramResult): void {
    if (!this.editor) return;

    // Clear previous executed line markers
    this.clearExecutedLineMarkers();

    // Get line numbers from segments if available (more accurate than executedLines)
    const lineNumbers = new Set<number>();

    // Add lines from plotMetadata segments
    if (result.plotMetadata?.segments) {
      result.plotMetadata.segments.forEach((segment) => {
        if (segment.startPoint.lineNumber !== undefined) {
          lineNumbers.add(segment.startPoint.lineNumber);
        }
        if (segment.endPoint.lineNumber !== undefined) {
          lineNumbers.add(segment.endPoint.lineNumber);
        }
      });
    }

    // Also add from executedLines array if available
    if (result.executedLines && result.executedLines.length > 0) {
      result.executedLines.forEach((line) => lineNumbers.add(line));
    }

    // Add markers for each executed line
    const Range = ace.require('ace/range').Range;
    lineNumbers.forEach((lineNumber) => {
      // Convert to 0-based index
      const line = lineNumber - 1;
      if (line >= 0 && line < this.editor!.session.getLength()) {
        const markerId = this.editor!.session.addMarker(
          new Range(line, 0, line, 1),
          'ace_executed-line',
          'fullLine',
          false,
        );
        this.executedLineMarkers.push(markerId);
      }
    });

    // Update timing gutter if timing data is available
    if (result.timingData) {
      this.updateTimingGutter(result.timingData);
    }
  }

  /**
   * Clears all executed line markers from the editor.
   */
  clearExecutedLineMarkers(): void {
    if (!this.editor) return;

    this.executedLineMarkers.forEach((markerId) => {
      this.editor?.session.removeMarker(markerId);
    });
    this.executedLineMarkers = [];
    this.clearTimingGutter();
  }

  private updateTimingGutter(timingData: Map<number, number>): void {
    if (timingData.size === 0) {
      this.clearTimingGutter();
      return;
    }

    const timingGutter = this.querySelector('.timing-gutter') as HTMLElement;
    const timingContent = this.querySelector('.timing-content') as HTMLElement;
    const paneHeader = this.querySelector('.pane-header') as HTMLElement;
    
    if (!timingGutter || !timingContent || !this.editor) return;

    // Show the gutter and header
    timingGutter.style.display = 'block';
    if (paneHeader) paneHeader.style.display = 'flex';
    
    // Clear existing content
    timingContent.innerHTML = '';
    
    const lineHeight = this.editor.renderer.lineHeight;
    
    timingData.forEach((time, lineNumber) => {
      // Convert to 0-based index
      const lineIndex = lineNumber - 1;
      
      const div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.top = `${lineIndex * lineHeight}px`;
      div.style.right = '5px';
      div.style.height = `${lineHeight}px`;
      div.style.lineHeight = `${lineHeight}px`;
      div.style.fontSize = '10px';
      div.style.color = '#888';
      div.textContent = `${time.toFixed(3)}s`;
      
      timingContent.appendChild(div);
    });
    
    // Trigger resize to adjust editor width/height
    this.editor.resize();
  }

  private clearTimingGutter(): void {
    const timingGutter = this.querySelector('.timing-gutter') as HTMLElement;
    const timingContent = this.querySelector('.timing-content') as HTMLElement;
    const paneHeader = this.querySelector('.pane-header') as HTMLElement;
    
    if (timingGutter) {
      timingGutter.style.display = 'none';
    }
    if (paneHeader) {
      paneHeader.style.display = 'none';
    }
    if (timingContent) {
      timingContent.innerHTML = '';
    }
    
    // Trigger resize to adjust editor width/height
    this.editor?.resize();
  }

  showErrors(errors: FaultDetail[]): void {
    if (!this.editor) return;
    this.clearErrors();

    const annotations: ace.Ace.Annotation[] = [];
    const Range = ace.require('ace/range').Range;

    errors.forEach((error) => {
      const line = error.lineNumber - 1;
      if (line >= 0 && line < this.editor!.session.getLength()) {
        // Add gutter annotation
        annotations.push({
          row: line,
          column: 0,
          text: error.message,
          type: error.severity, // 'error' or 'warning'
        });

        // Add marker
        const markerId = this.editor!.session.addMarker(
          new Range(line, 0, line, 1),
          'ace_error-line',
          'fullLine',
          false,
        );
        this.errorMarkers.push(markerId);
      }
    });

    this.editor.session.setAnnotations(annotations);
  }

  clearErrors(): void {
    if (!this.editor) return;
    this.errorMarkers.forEach((markerId) => {
      this.editor?.session.removeMarker(markerId);
    });
    this.errorMarkers = [];
    this.editor.session.clearAnnotations();
  }
}

customElements.define('nc-code-pane', NCCodePane);
