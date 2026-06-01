import { EventBus } from './EventBus';
import { ChannelId, NCFile, NCProgram } from '../core/types';
import { StateService } from './StateService';

import { IFileManagerService } from './IFileManagerService';

export class FileManagerService implements IFileManagerService {
  private files: NCFile[] = [];
  private programs: NCProgram[] = [];

  constructor(
    private eventBus: EventBus,
    private stateService?: StateService,
    private useLocalStorage: boolean = true
  ) {
    // If stateService is provided, we should NOT use local storage directly in FileManagerService
    // as StateService already handles its own persistence.
    // However, if no stateService is provided, we fall back to private file management.
    if (this.useLocalStorage && !this.stateService) {
      this.loadFromStorage();
    }
    
    // Auto-save the machine type against the active file when it changes globally
    this.eventBus.subscribe('machine:changed', (data: any) => {
        const file = this.getActiveFile();
        if (file && data.machine?.machineName) {
            if (file.machineType !== data.machine.machineName) {
                file.machineType = data.machine.machineName;
                this.saveToStorage();
            }
        }
    });
  }

  public getFiles(): NCFile[] {
    return this.files;
  }

  public getPrograms(channelId: string): NCProgram[] {
    return this.programs.filter(p => p.channelId === channelId);
  }

  public getActiveProgram(channelId: string): NCProgram | null {
    const id = this.stateService?.getActiveProgramId(channelId);
    return id ? this.programs.find(p => p.id === id) || null : null;
  }

  public updateActiveProgramContent(channelId: string, content: string) {
    const activeProgram = this.getActiveProgram(channelId);
    if (!activeProgram) return;

    // Optional: Could trigger undo snapshot here if we want to undo text edits via global state
    activeProgram.content = content;
    activeProgram.lastModified = Date.now();
    this.saveToStorage();
  }

  public setActiveProgram(channelId: string, programId: string) {
    const program = this.programs.find(p => p.id === programId && p.channelId === channelId);
    if (program) {
        this.stateService?.setActiveProgramId(channelId, programId);
        this.eventBus.publish('program:active_changed', { channelId, program });
        this.saveToStorage();
    }
  }

  public closeProgram(programId: string) {
    const program = this.programs.find(p => p.id === programId);
    if (!program) return;

    this.programs = this.programs.filter(p => p.id !== programId);
    
    // If it was active, unset it
    if (this.stateService?.getActiveProgramId(program.channelId) === programId) {
        const remaining = this.getPrograms(program.channelId);
        if (remaining.length > 0) {
            this.setActiveProgram(program.channelId, remaining[0].id);
        } else {
            this.stateService?.setActiveProgramId(program.channelId, '');
            this.eventBus.publish('program:active_changed', { channelId: program.channelId, program: null });
        }
    }
    
    this.eventBus.publish('program:closed', { channelId: program.channelId, programId });
    this.saveToStorage();
  }

  public getActiveFile(): NCFile | null {
    if (this.stateService) {
      const id = this.stateService.getState().activeFileId;
      return id ? this.files.find(f => f.id === id) || null : null;
    }
    // Fallback if no StateService is present (mostly for tests or decoupling)
    return this.files.length > 0 ? this.files[this.files.length - 1] : null;
  }

  public async openFile(content: string, name: string, options: { parseMultiChannel: boolean, channel?: number }): Promise<NCFile> {
    const parsed = this.parseNCCode(content, options);
    const globalMachine = this.stateService?.getState().globalMachine;
    
    const file: NCFile = {
      id: this.generateId(),
      name: name,
      content: content,
      channels: parsed,
      isMultiChannel: parsed.length > 1,
      lastModified: Date.now(),
      machineType: globalMachine
    };
    
    this.files.push(file);
    this.stateService?.setActiveFileId(file.id);

    // Create programs from the file
    parsed.forEach((channelContent, index) => {
        if (channelContent !== undefined && channelContent !== null) {
            const channelId = (index + 1).toString();
            const program: NCProgram = {
                id: this.generateId(),
                name: file.isMultiChannel ? `${name} (CH${channelId})` : name,
                content: channelContent,
                channelId: channelId,
                sourceFileId: file.id,
                lastModified: Date.now()
            };
            this.programs.push(program);
            // Automatically activate the new program for this channel
            this.setActiveProgram(channelId, program.id);
        }
    });

        if (this.shouldSyncChannelsOnOpen(options)) {
          this.syncChannelsForFile(parsed);
        }

    this.saveToStorage();
    this.eventBus.publish('file:opened', file);
    this.eventBus.publish('file:active_changed', file);
    return file;
  }

  public newFile(name: string = "Untitled.mpf") {
    // Create a new blank file specifically mapped to all 3 channels to start
    this.openFile("", name, { parseMultiChannel: false });
  }

  public newProgram(channelId: string, name: string = "New Program") {
    const activeFileId = this.stateService?.getState().activeFileId;
    const currentFileId = activeFileId || this.generateId();

    // Just push a new empty program mapped to the active file 
    // or a proxy if no file exists
    const program: NCProgram = {
        id: this.generateId(),
        name,
        content: "",
        channelId,
        sourceFileId: currentFileId,
        lastModified: Date.now()
    };
    this.programs.push(program);
    this.setActiveProgram(channelId, program.id);
    this.saveToStorage();
    this.eventBus.publish('file:opened', program); // Trick UI into reloading
  }

  public selectFile(id: string) {
    const file = this.files.find(f => f.id === id);
    if (file) {
      this.stateService?.setActiveFileId(id);
      
      if (file.machineType && this.stateService) {
         this.stateService.setGlobalMachine(file.machineType as any);
      }
      
      // Auto-switch channels to the newly selected file's programs
      ['1', '2', '3'].forEach(channelId => {
          const program = this.programs.find(p => p.sourceFileId === file.id && p.channelId === channelId);
          if (program) {
              this.setActiveProgram(channelId, program.id);
          }
      });

      if (file.isMultiChannel || file.channels.length > 1) {
        this.syncChannelsForFile(file.channels);
      }

      this.eventBus.publish('file:active_changed', file);
    }
  }

  public closeFile(id: string) {
    this.files = this.files.filter(f => f.id !== id);
    const programsToRemove = this.programs.filter(p => p.sourceFileId === id);
    programsToRemove.forEach(p => this.closeProgram(p.id));

    if (this.stateService?.getState().activeFileId === id) {
      const nextFile = this.files.length > 0 ? this.files[0] : null;
      this.stateService?.setActiveFileId(nextFile ? nextFile.id : null);
      if (nextFile) {
        this.selectFile(nextFile.id);
      } else {
        this.eventBus.publish('file:active_changed', null);
      }
    }
    this.saveToStorage();
    this.eventBus.publish('file:closed', id);
  }

  public renameFile(id: string, newName: string) {
      const file = this.files.find(f => f.id === id);
      if (file && newName.trim()) {
          file.name = newName.trim();
          file.lastModified = Date.now();
          this.saveToStorage();
          this.eventBus.publish('file:active_changed', file);
      }
  }

  public renameProgram(id: string, newName: string) {
      const program = this.programs.find(p => p.id === id);
      if (program && newName.trim()) {
          program.name = newName.trim();
          program.lastModified = Date.now();
          this.saveToStorage();
          this.eventBus.publish('program:active_changed', { channelId: program.channelId, program });
      }
  }

  private parseNCCode(content: string, options: { parseMultiChannel: boolean, channel?: number }): string[] {
    let result = content;
    let isMultiProgram = false;
    
    if (options.parseMultiChannel) {
        isMultiProgram = result.includes("<");
    }

    if (isMultiProgram) {
        result = result.replace(/&F=.*/g, "");
        result = result.replace(/%/g, "");
        let ret: string[] = [];
        let programs = result.split("<");
        // If the first part is empty (file starts with <), remove it
        if (programs[0].trim() === "") {
            programs.shift();
        }

        for (let i = 0; i < programs.length; i++) {
            if (i > 2) break;
            
            let programLines = programs[i].split("\n");
            let header = programLines[0];
            
            let endNameIndex = header.indexOf(".");
            if (endNameIndex === -1) {
                endNameIndex = header.length - 1;
            }
            
            let programNameS = header.substring(0, endNameIndex).replace("<", "");
            programNameS = programNameS.replace(/\..*\./, "");
            
            // User logic: ret.push(programNameS + programs[programNr].replace(/.*>/, ""));
            // Note: programs[i] still contains the header line if we didn't strip it.
            // The user's regex replace(/.*>/, "") seems to intend to remove the header tag?
            // But split("<") removes the separator.
            // If the file is `<HEAD>...`, split gives `HEAD>...`.
            // So `replace(/.*>/, "")` removes `HEAD>`.
            
            let contentBody = programs[i].replace(/.*>/, "");
            ret.push(programNameS + contentBody);
        }
        return ret;
    } else if (options.channel === 2) {
        return ["", result];
    } else if (options.channel === 3) {
        return ["", "", result];
    } else {
        return [result];
    }
  }

  private shouldSyncChannelsOnOpen(options: { parseMultiChannel: boolean, channel?: number }): boolean {
    return options.parseMultiChannel || options.channel !== undefined;
  }

  private syncChannelsForFile(channels: string[]): void {
    if (!this.stateService) return;

    (['1', '2', '3'] as ChannelId[]).forEach((channelId, index) => {
      const channelContent = channels[index];
      const hasContent = typeof channelContent === 'string' && channelContent.trim() !== '';

      if (hasContent) {
        this.stateService?.activateChannel(channelId);
      } else {
        this.stateService?.deactivateChannel(channelId);
      }
    });
  }

  private generateId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  private saveToStorage() {
    if (!this.useLocalStorage) return;
    try {
        localStorage.setItem('nc-files', JSON.stringify(this.files));
        localStorage.setItem('nc-programs', JSON.stringify(this.programs));
    } catch (e) {
        console.error("Failed to save files to localStorage", e);
    }
  }

  private loadFromStorage() {
    try {
        const storedFiles = localStorage.getItem('nc-files');
        if (storedFiles) {
            this.files = JSON.parse(storedFiles);
            // activeFileId is now handled in StateService
        }

        const storedPrograms = localStorage.getItem('nc-programs');
        if (storedPrograms) {
            this.programs = JSON.parse(storedPrograms);
        }
        // activeProgramIds are now handled in StateService
    } catch (e) {
        console.error("Failed to load files", e);
    }
  }
}
