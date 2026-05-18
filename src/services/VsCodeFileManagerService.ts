import { IFileManagerService } from './IFileManagerService';
import { FileManagerService } from './FileManagerService';
import { EventBus } from './EventBus';
import { StateService } from './StateService';
import { NCFile, NCProgram, ChannelId } from '../core/types';
import { ServiceRegistry } from '../core/ServiceRegistry';
import { HOST_BRIDGE_SERVICE_TOKEN } from '../core/ServiceTokens';

export class VsCodeFileManagerService implements IFileManagerService {
    private baseManager: FileManagerService;
    private vsCodeFileId: string | null = null;
    private isInternalUpdate: boolean = false;

    private internalUpdateTimeout?: ReturnType<typeof setTimeout>;

    constructor(
        private eventBus: EventBus,
        private stateService: StateService
    ) {
        this.baseManager = new FileManagerService(eventBus, stateService, false);
        
        window.addEventListener('vscode:host-undo-redo', (event: any) => {
            const data = event.detail; // { type, channel, text }
            this.updateChannelFromHost(data.channel, data.text);
        });

        window.addEventListener('vscode:files-opened', (event: any) => {
            if (this.isInternalUpdate) return;
            const data = event.detail; // { type, activeChannel, isSingleFile, channels: { '1':'..', '2': '..' } }
            
            if (data.type === 'FILES_OPENED') {
                this.loadChannels(data.channels);
                
                const loadedChannels = Object.keys(data.channels);
                
                // Enable any channel that we received data for, and disable the ones we didn't
                ['1', '2', '3'].forEach(ch => {
                    const desktopToggles = document.querySelectorAll(`.app-channel-toggle[data-channel="${ch}"]`);
                    if (loadedChannels.includes(ch)) {
                        this.stateService.activateChannel(ch as ChannelId);
                        desktopToggles.forEach(toggle => toggle.classList.remove('inactive'));
                    } else {
                        this.stateService.deactivateChannel(ch as ChannelId);
                        desktopToggles.forEach(toggle => toggle.classList.add('inactive'));
                    }
                });

                // Programmatically switch focus/layout
                if (data.activeChannel) {
                    setTimeout(() => {
                        // Mobile: Force the bottom Nav to click into the requested channel
                        if (window.innerWidth <= 768) {
                            const mobileNavItems = document.querySelectorAll(`.nav-item[data-view="channel-${data.activeChannel}"]`);
                            mobileNavItems.forEach(nav => {
                                (nav as HTMLElement).click();
                            });
                        }
                        
                        // Fire a generic window resize to coerce any Flexbox/AceEditor layout updates
                        window.dispatchEvent(new Event('resize'));
                    }, 100);
                }
            } else if (data.type === 'FILE_UPDATED_EXTERNALLY') {
                if (data.channels) {
                    this.loadChannels(data.channels);
                } else if (data.channel && data.text !== undefined) {
                    this.updateChannelFromHost(data.channel, data.text);
                }
            }
        });
    }

    private loadChannels(channelsObj: Record<string, string>) {
        if (!this.vsCodeFileId) {
            // Pseudo file just so internal logic processes work
            this.baseManager.openFile("", "VSCode_Workspace", { parseMultiChannel: false }).then(file => {
                this.vsCodeFileId = file.id;
                this.applyChannelsObjects(channelsObj);
            });
        } else {
            this.applyChannelsObjects(channelsObj);
        }
    }

    private applyChannelsObjects(channelsObj: Record<string, string>) {
        for (const [ch, content] of Object.entries(channelsObj)) {
            this.updateChannelFromHost(ch, content);
        }
    }

    private updateChannelFromHost(channelId: string, content: string) {
        const normalized = content.replace(/\r\n/g, '\n');
        let activeProgram = this.baseManager.getActiveProgram(channelId);
        
        // If channel doesn't exist, create it
        if (!activeProgram) {
            this.baseManager.newProgram(channelId, `Channel ${channelId}`);
            activeProgram = this.baseManager.getActiveProgram(channelId);
        }
        
        if (activeProgram && activeProgram.content !== normalized) {
            activeProgram.content = normalized;
            this.eventBus.publish('program:content_changed', { channelId, program: activeProgram });
        }
    }

    private syncToHost(channelId: string, content: string, oldText: string) {
        const hostBridge = ServiceRegistry.getInstance().get(HOST_BRIDGE_SERVICE_TOKEN);
        if (hostBridge && hostBridge.isAvailable()) {
            hostBridge.notifyDocumentChanged(channelId, content, oldText);
        } else {
            // Broadcast the specific channel text payload up to the NCEditorProvider host
            window.dispatchEvent(new CustomEvent('vscode:file-changed', { 
                detail: { channel: channelId, text: content, oldText } 
            }));
        }
    }

    // --- Pass-through to Core Logic ---
    getFiles(): NCFile[] { return this.baseManager.getFiles(); }
    getPrograms(channelId: string): NCProgram[] { return this.baseManager.getPrograms(channelId); }
    getActiveProgram(channelId: string): NCProgram | null { return this.baseManager.getActiveProgram(channelId); }
    
    updateActiveProgramContent(channelId: string, content: string): void {
        const activeProgram = this.baseManager.getActiveProgram(channelId);
        const oldText = activeProgram ? activeProgram.content : '';
        this.baseManager.updateActiveProgramContent(channelId, content);
        this.isInternalUpdate = true;
        this.syncToHost(channelId, content, oldText);
        
        if (this.internalUpdateTimeout) {
            clearTimeout(this.internalUpdateTimeout);
        }
        this.internalUpdateTimeout = setTimeout(() => { this.isInternalUpdate = false; }, 50);
    }
    
    setActiveProgram(channelId: string, programId: string): void { this.baseManager.setActiveProgram(channelId, programId); }
    closeProgram(programId: string): void { this.baseManager.closeProgram(programId); }
    getActiveFile(): NCFile | null { return this.baseManager.getActiveFile(); }
    
    async openFile(content: string, name: string, options: { parseMultiChannel: boolean; channel?: number | undefined; }): Promise<NCFile> {
        return this.baseManager.openFile(content, name, options);
    }
    
    newFile(name?: string | undefined): void { this.baseManager.newFile(name); }
    newProgram(channelId: string, name?: string | undefined): void { this.baseManager.newProgram(channelId, name); }
    selectFile(id: string): void { this.baseManager.selectFile(id); }
    closeFile(id: string): void { this.baseManager.closeFile(id); }
    renameFile(id: string, newName: string): void { this.baseManager.renameFile(id, newName); }
    renameProgram(id: string, newName: string): void { this.baseManager.renameProgram(id, newName); }
}
