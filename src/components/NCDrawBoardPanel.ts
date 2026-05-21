import { DrawBoard, Camera, MouseControl, MouseState, PropertySchemaProvider, ToolInstructionProvider } from 'cnc7drawnccode';

export class NCDrawBoardPanel extends HTMLElement {
    private canvas: HTMLCanvasElement;
    private layoutRoot: HTMLDivElement;
    private canvasArea: HTMLDivElement;
    private canvasViewport: HTMLDivElement;
    private inspectorPanel: HTMLDivElement;
    private inspectorEmptyState: HTMLDivElement;
    private toolPanel: HTMLDivElement;
    private propertyPanel: HTMLDivElement;
    private toolbarDiv?: HTMLDivElement;

    public drawBoard!: DrawBoard;
    public mouseControl!: MouseControl;
    public propertySchema!: PropertySchemaProvider;
    public toolInstructions!: ToolInstructionProvider;

    constructor() {
        super();

        this.layoutRoot = document.createElement('div');
        this.layoutRoot.style.display = 'flex';
        this.layoutRoot.style.flexDirection = 'column';
        this.layoutRoot.style.width = '100%';
        this.layoutRoot.style.height = '100%';
        this.layoutRoot.style.minHeight = '0';

        this.canvasArea = document.createElement('div');
        this.canvasArea.style.display = 'flex';
        this.canvasArea.style.flex = '1';
        this.canvasArea.style.minHeight = '0';
        this.canvasArea.style.minWidth = '0';

        this.canvasViewport = document.createElement('div');
        this.canvasViewport.style.position = 'relative';
        this.canvasViewport.style.flex = '1';
        this.canvasViewport.style.minWidth = '0';
        this.canvasViewport.style.minHeight = '0';
        this.canvasViewport.style.background = 'var(--vscode-editor-background, #1e1e1e)';

        this.inspectorPanel = document.createElement('div');
        this.inspectorPanel.classList.add('nc-draw-inspector');
        this.inspectorPanel.style.display = 'flex';
        this.inspectorPanel.style.flexDirection = 'column';
        this.inspectorPanel.style.gap = '12px';
        this.inspectorPanel.style.width = '320px';
        this.inspectorPanel.style.maxWidth = '40%';
        this.inspectorPanel.style.minWidth = '280px';
        this.inspectorPanel.style.padding = '12px';
        this.inspectorPanel.style.borderLeft = '1px solid var(--vscode-editorGroup-border, #444)';
        this.inspectorPanel.style.background = 'var(--vscode-sideBar-background, var(--vscode-editorWidget-background, #252526))';
        this.inspectorPanel.style.overflowY = 'auto';
        this.inspectorPanel.style.boxSizing = 'border-box';

        this.inspectorEmptyState = document.createElement('div');
        this.inspectorEmptyState.textContent = 'Select geometry to edit properties or activate a drawing tool to see guided inputs here.';
        this.inspectorEmptyState.style.padding = '12px';
        this.inspectorEmptyState.style.border = '1px dashed var(--vscode-widget-border, #454545)';
        this.inspectorEmptyState.style.borderRadius = '8px';
        this.inspectorEmptyState.style.color = 'var(--vscode-descriptionForeground, #9d9d9d)';
        this.inspectorEmptyState.style.fontSize = '12px';
        this.inspectorEmptyState.style.lineHeight = '1.5';
        
        // 1. Create Canvas
        this.canvas = document.createElement("canvas");
        this.canvas.style.width = "100%";
        this.canvas.style.height = "100%";
        this.canvas.style.display = "block"; // prevents bottom scrollbar space

        // Create Tool Panel (Docked Inspector)
        this.toolPanel = document.createElement('div');
        this.toolPanel.classList.add('nc-tool-panel');
        this.toolPanel.style.display = 'none';
        this.toolPanel.style.padding = '10px 16px';
        this.toolPanel.style.background = 'var(--vscode-editorHoverWidget-background, rgba(40, 40, 40, 0.95))';
        this.toolPanel.style.color = 'var(--vscode-editorHoverWidget-foreground, white)';
        this.toolPanel.style.border = '1px solid var(--vscode-editorHoverWidget-border, #454545)';
        this.toolPanel.style.borderRadius = '8px';
        this.toolPanel.style.boxSizing = 'border-box';
        this.toolPanel.style.width = '100%';
        this.toolPanel.style.boxShadow = '0px 2px 5px rgba(0,0,0,0.15)';

        // Create Property Panel (Docked Inspector)
        this.propertyPanel = document.createElement('div');
        this.propertyPanel.classList.add('nc-property-panel');
        this.propertyPanel.style.background = 'var(--vscode-editorHoverWidget-background, rgba(40, 40, 40, 0.95))';
        this.propertyPanel.style.color = 'var(--vscode-editorHoverWidget-foreground, white)';
        this.propertyPanel.style.border = '1px solid var(--vscode-editorHoverWidget-border, #454545)';
        this.propertyPanel.style.boxShadow = '2px 2px 10px rgba(0,0,0,0.2)';
        this.propertyPanel.style.padding = '12px';
        this.propertyPanel.style.width = '100%';
        this.propertyPanel.style.boxSizing = 'border-box';
        this.propertyPanel.style.overflowY = 'auto';
        this.propertyPanel.style.display = 'none';

        this.canvasViewport.appendChild(this.canvas);
        this.inspectorPanel.appendChild(this.toolPanel);
        this.inspectorPanel.appendChild(this.propertyPanel);
        this.inspectorPanel.appendChild(this.inspectorEmptyState);
        this.canvasArea.appendChild(this.canvasViewport);
        this.canvasArea.appendChild(this.inspectorPanel);
        this.layoutRoot.appendChild(this.canvasArea);
    }

    connectedCallback() {
        this.style.display = "block";
        this.style.width = "100%";
        this.style.height = "100%";
        this.style.overflow = "hidden";
        this.style.minHeight = '0';

        this.appendChild(this.layoutRoot);

        // Connect initial toolbar state before sizing so the canvas region gets correct space.
        this.renderToolbar();

        // 2. Initialize Engine
        const camera = new Camera();
        this.drawBoard = new DrawBoard(this.canvas, camera);
        
        // Disable internal command tools from generating HTML directly, use only as headless engine
        this.mouseControl = new MouseControl(this, this.drawBoard);

        // Initialize headless providers
        this.toolInstructions = new ToolInstructionProvider(this.mouseControl);
        this.propertySchema = new PropertySchemaProvider(this.drawBoard);

        // 3. Setup Auto-Resizing
        this.setupResizeObserver();

        // 4. Bind Events
        this.setupEventForwarding();
    }

    private setupResizeObserver() {
        const ro = new ResizeObserver(entries => {
            for (let entry of entries) {
                const { width, height } = entry.contentRect;
                this.canvas.width = width;
                this.canvas.height = height;
                
                // Initialize camera position to center (0,0) on first valid sizing
                if (this.drawBoard && this.drawBoard.camera && !(this.drawBoard.camera as any)['_initialized']) {
                    this.drawBoard.camera.moveX(width / 2);
                    this.drawBoard.camera.moveY(height / 2);
                    (this.drawBoard.camera as any)['_initialized'] = true;
                }
                
                this.drawBoard.draw();
            }
        });
        ro.observe(this.canvasViewport);
    }

    private getPosition(e: MouseEvent) {
        // Calculate the accurate scale between CSS display size and actual Canvas resolution
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;

        return {
            // Adjust the coordinates proportionally to the canvas' inner bounds
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY,
            button: e.button
        };
    }

    private setupEventForwarding() {
        // Forward DOM interaction to CAD logic using relative offsets
        
        let downPos = { x: 0, y: 0 };
        this.canvas.addEventListener('mousedown', (e) => {
            const pos = this.getPosition(e);
            downPos = pos;
            this.mouseControl.mouseDown(pos);
        });
        
        this.canvas.addEventListener('mouseup', (e) => {
            const pos = this.getPosition(e);
            const dist = Math.hypot(pos.x - downPos.x, pos.y - downPos.y);
            this.mouseControl.mouseUp(pos);

            // Re-trigger click events from mouseUp to guarantee tool steps advance correctly (as browser `click` natively drops fast actions)
            if (dist < 5) {
                this.mouseControl.mouseClicked(pos);
            }
        });
        
        this.canvas.addEventListener('mousemove', (e) => this.mouseControl.mouseMove(this.getPosition(e)));
        
        // Disabling context menu to allow custom right-clicks or tool cancellations
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        this.canvas.addEventListener('selection-changed', (e: any) => {
            const { object } = e.detail;
            console.log("NC-Edit7 Canvas Selection Event Fired!", object);
            
            if (this.propertySchema) {
                this.propertySchema.setObject(object);
                this.renderPropertyPanel();
            }
        });

        // Hook up mouse state change to render instructions
        const previousOnStateChange = this.mouseControl.onStateChange;
        this.mouseControl.onStateChange = () => {
            if (typeof previousOnStateChange === 'function') {
                previousOnStateChange();
            }
            this.renderToolPanel();
        };

        // Render initial UI state
        // Need brief delay to allow panel rendering
        setTimeout(() => {
            if (this.toolInstructions) this.renderToolPanel();
            if (this.propertySchema) this.renderPropertyPanel();
        }, 0);
    }

    private renderToolPanel() {
        if (!this.toolInstructions) return;
        const snapshot = this.toolInstructions.getSnapshot();
        this.toolPanel.innerHTML = '';

        if (!snapshot.visible) {
            this.toolPanel.style.display = 'none';
            this.updateInspectorState();
            return;
        }

        this.toolPanel.style.display = 'block';

        const sectionLabel = document.createElement('div');
        sectionLabel.textContent = 'Active Tool';
        sectionLabel.style.fontSize = '11px';
        sectionLabel.style.fontWeight = '600';
        sectionLabel.style.letterSpacing = '0.08em';
        sectionLabel.style.textTransform = 'uppercase';
        sectionLabel.style.color = 'var(--vscode-descriptionForeground, #9d9d9d)';
        sectionLabel.style.marginBottom = '6px';
        this.toolPanel.appendChild(sectionLabel);

        const title = document.createElement('div');
        title.textContent = snapshot.title;
        title.style.fontWeight = 'bold';
        title.style.marginBottom = '6px';
        this.toolPanel.appendChild(title);

        const instruction = document.createElement('div');
        instruction.textContent = snapshot.instruction;
        instruction.style.color = 'var(--vscode-descriptionForeground, #ccc)';
        instruction.style.marginBottom = '8px';
        this.toolPanel.appendChild(instruction);

        for (const field of snapshot.fields) {
            const input = document.createElement('input');
            input.type = field.type || 'text';
            input.value = field.value;
            input.style.background = 'var(--vscode-input-background, #3c3c3c)';
            input.style.color = 'var(--vscode-input-foreground, #ccc)';
            input.style.border = '1px solid var(--vscode-input-border, #555)';
            input.style.padding = '4px';
            input.style.marginRight = '6px';
            if (field.min !== undefined) input.min = field.min;
            if (field.step !== undefined) input.step = field.step;
            input.onchange = () => {
                this.toolInstructions.setFieldValue(field.id, input.value);
                this.renderToolPanel();
            };
            this.toolPanel.appendChild(input);
        }

        for (const action of snapshot.actions) {
            const button = document.createElement('button');
            button.textContent = action.label;
            button.style.background = 'var(--vscode-button-background, #0e639c)';
            button.style.color = 'var(--vscode-button-foreground, #ffffff)';
            button.style.border = 'none';
            button.style.padding = '4px 8px';
            button.style.marginRight = '6px';
            button.style.cursor = 'pointer';
            button.onclick = () => {
                this.toolInstructions.runAction(action.id);
                this.renderToolPanel();
            };
            this.toolPanel.appendChild(button);
        }

        if (snapshot.output) {
            const output = document.createElement('textarea');
            output.readOnly = true;
            output.value = snapshot.output.value;
            output.placeholder = snapshot.output.placeholder || '';
            output.style.width = '100%';
            output.style.height = '120px';
            output.style.marginTop = '8px';
            output.style.background = 'var(--vscode-input-background, #3c3c3c)';
            output.style.color = 'var(--vscode-input-foreground, #ccc)';
            output.style.border = '1px solid var(--vscode-input-border, #555)';
            this.toolPanel.appendChild(output);
        }

        if (snapshot.status) {
            const status = document.createElement('div');
            status.textContent = snapshot.status.text;
            status.style.marginTop = '8px';
            status.style.color = snapshot.status.tone === 'error' ? 'var(--vscode-errorForeground, #f14c4c)' : 'var(--vscode-notificationsInfoIcon-foreground, #3794ff)';
            this.toolPanel.appendChild(status);
        }

        this.updateInspectorState();
    }

    private renderPropertyNode(node: any, parent: HTMLElement) {
        if (node.type === 'group') {
            const group = document.createElement('div');
            group.style.marginBottom = '10px';
            group.style.padding = '5px';
            group.style.border = '1px solid var(--vscode-widget-border, #454545)';

            if (node.title) {
                const heading = document.createElement('h4');
                heading.textContent = node.title;
                heading.style.margin = '0 0 6px 0';
                group.appendChild(heading);
            }

            for (const child of node.children || []) {
                this.renderPropertyNode(child, group);
            }

            parent.appendChild(group);
            return;
        }

        if (node.type === 'text') {
            const text = document.createElement('p');
            text.textContent = node.text;
            parent.appendChild(text);
            return;
        }

        if (node.type === 'field') {
            const row = document.createElement('div');
            row.style.marginBottom = '6px';
            row.style.display = 'flex';
            row.style.alignItems = 'center';

            const label = document.createElement('label');
            label.textContent = `${node.label}: `;
            label.style.width = '90px';
            label.style.flexShrink = '0';

            const input = document.createElement('input');
            input.type = node.inputType || 'text';
            input.value = node.value;
            input.style.flexGrow = '1';
            input.style.width = '100px';
            input.style.background = 'var(--vscode-input-background, #3c3c3c)';
            input.style.color = 'var(--vscode-input-foreground, #ccc)';
            input.style.border = '1px solid var(--vscode-input-border, #555)';
            if (node.step !== undefined) input.step = node.step;
            if (node.min !== undefined) input.min = node.min;
            input.onchange = () => {
                this.propertySchema.applyFieldValue(node.id, input.value);
                this.renderPropertyPanel();
                if (this.drawBoard) this.drawBoard.draw();
            };

            row.appendChild(label);
            row.appendChild(input);
            parent.appendChild(row);
            return;
        }

        if (node.type === 'action') {
            const button = document.createElement('button');
            button.textContent = node.label;
            button.style.background = 'var(--vscode-button-background, #0e639c)';
            button.style.color = 'var(--vscode-button-foreground, #ffffff)';
            button.style.border = 'none';
            button.style.padding = '4px 8px';
            button.style.marginRight = '6px';
            button.style.cursor = 'pointer';
            button.onclick = () => {
                this.propertySchema.runAction(node.id);
                this.renderPropertyPanel();
                if (this.drawBoard) this.drawBoard.draw();
            };
            parent.appendChild(button);
        }
    }

    private renderPropertyPanel() {
        if (!this.propertySchema) return;
        const schema = this.propertySchema.getSchema();
        this.propertyPanel.innerHTML = '';

        if (!schema.visible) {
            this.propertyPanel.style.display = 'none';
            this.updateInspectorState();
            return;
        }

        this.propertyPanel.style.display = 'block';

        const sectionLabel = document.createElement('div');
        sectionLabel.textContent = 'Selection';
        sectionLabel.style.fontSize = '11px';
        sectionLabel.style.fontWeight = '600';
        sectionLabel.style.letterSpacing = '0.08em';
        sectionLabel.style.textTransform = 'uppercase';
        sectionLabel.style.color = 'var(--vscode-descriptionForeground, #9d9d9d)';
        sectionLabel.style.marginBottom = '6px';
        this.propertyPanel.appendChild(sectionLabel);

        const title = document.createElement('h3');
        title.textContent = schema.title;
        title.style.marginTop = '0';
        title.style.marginBottom = '10px';
        this.propertyPanel.appendChild(title);

        for (const section of schema.sections) {
            this.renderPropertyNode(section, this.propertyPanel);
        }

        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.flexWrap = 'wrap';
        actions.style.gap = '6px';
        actions.style.marginTop = '10px';

        for (const action of schema.actions) {
            const button = document.createElement('button');
            button.textContent = action.label;
            button.style.background = 'var(--vscode-button-background, #0e639c)';
            button.style.color = 'var(--vscode-button-foreground, #ffffff)';
            button.style.border = 'none';
            button.style.padding = '4px 8px';
            button.style.cursor = 'pointer';
            button.onclick = () => {
                this.propertySchema.runAction(action.id);
                this.renderPropertyPanel();
                if (this.drawBoard) this.drawBoard.draw();
            };
            actions.appendChild(button);
        }

        this.propertyPanel.appendChild(actions);
        this.updateInspectorState();
    }

    private updateInspectorState() {
        const hasVisiblePanel = this.toolPanel.style.display !== 'none' || this.propertyPanel.style.display !== 'none';
        this.inspectorEmptyState.style.display = hasVisiblePanel ? 'none' : 'block';
    }

    public setTool(toolName: string) {
        switch(toolName) {
            case 'CLEAR': this.drawBoard.clearAll(); break;
            case 'UNDO': this.drawBoard.undo(); break;
            case 'REDO': this.drawBoard.redo(); break;

            case 'ZOOM_IN': this.drawBoard.zoom(1.2); break;
            case 'ZOOM_OUT': this.drawBoard.zoom(1 / 1.2); break;

            case 'SELECT': this.mouseControl.setState(MouseState.SELECT); break;
            case 'MOVE': this.mouseControl.setState(MouseState.MOVE); break;
            case 'POINT': this.mouseControl.setState(MouseState.POINT); break;
            case 'LINE': this.mouseControl.setState(MouseState.LINE); break;
            
            case 'CIRCLE': this.mouseControl.setState(MouseState.CIRCLE); break;
            case 'CIRCLE_3P': this.mouseControl.setState(MouseState.CIRCLE_3P); break;
            case 'CIRCLE_2T1R': this.mouseControl.setState(MouseState.CIRCLE_2T1R); break;
            case 'CIRCLE_3T': this.mouseControl.setState(MouseState.CIRCLE_3T); break;
            
            case 'ARC': this.mouseControl.setState(MouseState.ARC); break;
            case 'ARC_3P': this.mouseControl.setState(MouseState.ARC_3P); break;
            
            case 'CHAMFER_45': this.mouseControl.setState(MouseState.CHAMFER_45); break;
            case 'FILLET_ARC': this.mouseControl.setState(MouseState.FILLET_ARC); break;
            case 'TRIM': this.mouseControl.setState(MouseState.TRIM); break;
            case 'EXTEND': this.mouseControl.setState(MouseState.EXTEND); break;
            case 'CAM_PATH': this.mouseControl.setState(MouseState.CAM_PATH); break;

            case 'MEASURE_LENGTH': this.mouseControl.setState(MouseState.MEASURE_LENGTH); break;
            case 'MEASURE_HORIZONTAL': this.mouseControl.setState(MouseState.MEASURE_HORIZONTAL); break;
            case 'MEASURE_VERTICAL': this.mouseControl.setState(MouseState.MEASURE_VERTICAL); break;
            case 'MEASURE_ANGLE': this.mouseControl.setState(MouseState.MEASURE_ANGLE); break;
            case 'MEASURE_RADIUS': this.mouseControl.setState(MouseState.MEASURE_RADIUS); break;
            case 'MEASURE_LINECIRCLE': this.mouseControl.setState(MouseState.MEASURE_LINECIRCLE); break;

            case 'CONSTRAINT_HORIZONTAL': this.mouseControl.setState(MouseState.CONSTRAINT_HORIZONTAL); break;
            case 'CONSTRAINT_VERTICAL': this.mouseControl.setState(MouseState.CONSTRAINT_VERTICAL); break;
            case 'CONSTRAINT_TANGENT': this.mouseControl.setState(MouseState.CONSTRAINT_TANGENT); break;
        }
    }

    private renderToolbar() {
        if (this.toolbarDiv) {
            return;
        }

        const toolbarDiv = document.createElement('div');
        toolbarDiv.style.display = 'flex';
        toolbarDiv.style.gap = '5px';
        toolbarDiv.style.flexWrap = 'nowrap';
        toolbarDiv.style.alignItems = 'center';
        toolbarDiv.style.flex = '0 0 auto';
        toolbarDiv.style.backgroundColor = 'var(--vscode-editor-background, rgba(30,30,30,0.85))';
        toolbarDiv.style.padding = '8px 10px';
        toolbarDiv.style.borderBottom = '1px solid var(--vscode-editorGroup-border, #444)';
        toolbarDiv.style.overflowX = 'auto'; // Enable horizontal scrolling
        toolbarDiv.style.scrollbarWidth = 'none'; // Hide scrollbar (Firefox)
        (toolbarDiv.style as any)['-ms-overflow-style'] = 'none'; // Hide scrollbar (IE/Edge)

        // Hide scrollbar (Chrome/Safari/Webkit)
        if (!document.getElementById('nc-draw-toolbar-style')) {
            const style = document.createElement('style');
            style.id = 'nc-draw-toolbar-style';
            style.textContent = `
                .nc-draw-toolbar::-webkit-scrollbar {
                    display: none;
                }
            `;
            document.head.appendChild(style);
        }
        toolbarDiv.classList.add('nc-draw-toolbar');

        // Helper to format grouped tool dropdowns
        const createGroup = (labelStr: string, options: { label: string, val: string }[]) => {
            const select = document.createElement('select');
            select.style.backgroundColor = 'var(--vscode-dropdown-background, #3c3c3c)';
            select.style.color = 'var(--vscode-dropdown-foreground, #ccc)';
            select.style.border = '1px solid var(--vscode-dropdown-border, #555)';
            select.style.padding = '2px 4px';
            select.style.borderRadius = '2px';
            select.style.cursor = 'pointer';

            const placeholder = document.createElement('option');
            placeholder.text = labelStr;
            placeholder.disabled = true;
            placeholder.selected = true;
            select.appendChild(placeholder);

            options.forEach(opt => {
                const o = document.createElement('option');
                o.value = opt.val;
                o.text = opt.label;
                select.appendChild(o);
            });

            select.onchange = (e) => {
                const target = e.target as HTMLSelectElement;
                if(target.value) {
                    this.setTool(target.value);
                    // Reset back to placeholder so it acts like a menu button
                    target.selectedIndex = 0;
                }
            };
            return select;
        };

        // Quick Buttons for frequent tasks
        const createBtn = (label: string, cmd: string, isDanger = false) => {
            const btn = document.createElement('button');
            btn.innerText = label;
            btn.style.backgroundColor = isDanger ? '#d32f2f' : 'var(--vscode-button-secondaryBackground, #444)';
            btn.style.color = isDanger ? '#fff' : 'var(--vscode-button-secondaryForeground, #ccc)';
            btn.style.border = 'none';
            btn.style.padding = '4px 8px';
            btn.style.cursor = 'pointer';
            btn.style.borderRadius = '2px';
            btn.style.fontSize = '12px';
            
            btn.onclick = () => this.setTool(cmd);
            return btn;
        };

        toolbarDiv.appendChild(createBtn('Zoom +', 'ZOOM_IN'));
        toolbarDiv.appendChild(createBtn('Zoom -', 'ZOOM_OUT'));
        toolbarDiv.appendChild(createBtn('Select', 'SELECT'));
        toolbarDiv.appendChild(createBtn('Point', 'POINT'));
        toolbarDiv.appendChild(createBtn('Line', 'LINE'));
        toolbarDiv.appendChild(createBtn('CAM Gen.', 'CAM_PATH'));

        // Draw Tools Group
        toolbarDiv.appendChild(createGroup('Draw ...', [
            { label: 'Circle (Center + R)', val: 'CIRCLE' },
            { label: 'Circle (3 Points)', val: 'CIRCLE_3P' },
            { label: 'Circle (2 Tangents, 1R)', val: 'CIRCLE_2T1R' },
            { label: 'Circle (3 Tangents)', val: 'CIRCLE_3T' },
            { label: 'Arc (Center + Angles)', val: 'ARC' },
            { label: 'Arc (3 Points)', val: 'ARC_3P' }
        ]));

        // Edit Tools Group
        toolbarDiv.appendChild(createGroup('Edit ...', [
            { label: 'Move / Pan', val: 'MOVE' },
            { label: 'Trim Line', val: 'TRIM' },
            { label: 'Extend Line', val: 'EXTEND' },
            { label: 'Chamfer (45°)', val: 'CHAMFER_45' },
            { label: 'Fillet (Arc)', val: 'FILLET_ARC' }
        ]));

        // Measure Tools Group
        toolbarDiv.appendChild(createGroup('Measure ...', [
            { label: 'Length', val: 'MEASURE_LENGTH' },
            { label: 'Horizontal Dist', val: 'MEASURE_HORIZONTAL' },
            { label: 'Vertical Dist', val: 'MEASURE_VERTICAL' },
            { label: 'Angle', val: 'MEASURE_ANGLE' },
            { label: 'Radius', val: 'MEASURE_RADIUS' },
            { label: 'Line-Circle Disp', val: 'MEASURE_LINECIRCLE' }
        ]));

        // Constraints Group
        toolbarDiv.appendChild(createGroup('Constraints ...', [
            { label: 'Horizontal', val: 'CONSTRAINT_HORIZONTAL' },
            { label: 'Vertical', val: 'CONSTRAINT_VERTICAL' },
            { label: 'Tangent', val: 'CONSTRAINT_TANGENT' }
        ]));

        toolbarDiv.appendChild(createBtn('Undo', 'UNDO'));
        toolbarDiv.appendChild(createBtn('Clear', 'CLEAR', true));

        this.toolbarDiv = toolbarDiv;
        this.layoutRoot.insertBefore(toolbarDiv, this.canvasArea);
    }
}

customElements.define('nc-draw-board-panel', NCDrawBoardPanel);
