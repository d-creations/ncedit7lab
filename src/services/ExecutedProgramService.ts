// ExecutedProgramService for server-side program execution

import type {
  ChannelId,
  MachineType,
  ExecutedProgramResult,
  PlotRequest,
  PlotResponse,
  ToolValue,
  ToolOffsetValue,
  ToolPathMode,
  CustomVariable,
  BackendPlotChannel,
} from '@core/types';
import { BackendGateway } from './BackendGateway';
import { EventBus, EVENT_NAMES } from './EventBus';
import { freezeMetadata } from './tools/SimulationMetadata';
import type { PlotRunInput, PlotRunSnapshot } from './tools/PlotRunSnapshot';
import { executionProgram } from './tools/PlotRunSnapshot';

export interface ExecutionRequest {
  channelId: ChannelId;
  program: string;
  machineName: MachineType;
  toolValues?: ToolValue[];
  toolOffsets?: ToolOffsetValue[];
  customVariables?: CustomVariable[];
}

export class ExecutedProgramService {
  private backend: BackendGateway;
  private eventBus: EventBus;
  private executionCache = new Map<string, ExecutedProgramResult>();
  private plotRuns = new Map<string, PlotRunSnapshot>();
  private plotGeneration = 0;
  private readonly maxPlotRuns = 5;

  constructor(backend: BackendGateway, eventBus: EventBus) {
    this.backend = backend;
    this.eventBus = eventBus;
  }

  /** Detach all inputs before the first await; publish only the latest fully assembled run. */
  async executePlotRun(inputs: PlotRunInput[], singleChannel = false): Promise<PlotRunSnapshot> {
    const generation = ++this.plotGeneration;
    const runId = `plot-${generation}`;
    if (!inputs.length || (singleChannel && inputs.length !== 1)) {
      throw new Error('Plot requires the selected source programs');
    }
    const channels = new Set<string>();
    for (const input of inputs) {
      if (!input.snapshot.valid) throw new Error('Resolve program metadata diagnostics before plotting');
      if (input.snapshot.setup?.machineName && input.snapshot.setup.machineName !== input.machineName) {
        throw new Error('Program setup machine conflicts with the selected machine');
      }
      if (channels.has(input.snapshot.identity.channelId)) throw new Error('Duplicate plot channel');
      channels.add(input.snapshot.identity.channelId);
    }
    // Clone before freezing: callers, editor state and legacy execution consumers remain mutable.
    const captured = structuredClone(inputs);
    const requests = captured.map((input): ExecutionRequest => ({
      channelId: input.snapshot.identity.channelId,
      program: executionProgram(input.snapshot),
      machineName: input.machineName,
      toolValues: structuredClone(input.toolValues),
      toolOffsets: structuredClone(input.toolOffsets),
      customVariables: structuredClone(input.customVariables),
    }));
    freezeMetadata(captured);
    let results: ExecutedProgramResult[];
    try {
      const response = await this.backend.requestPlot(this.buildPlotRequest(requests));
      if (response.success === false) throw new Error('Backend rejected the plot request');
      results = requests.map((request) => this.parseExecutionResponse(response, request.channelId));
    } catch (error) {
      if (generation === this.plotGeneration) {
        requests.forEach((request) => this.eventBus.publish(EVENT_NAMES.EXECUTION_ERROR, {
          channelId: request.channelId, runId, error,
        }));
      }
      throw error;
    }
    const run = freezeMetadata({
      runId,
      toolPathMode: 'center' as const,
      inputs: captured,
      plotMetadata: structuredClone({
        points: results.flatMap((result) => result.plotMetadata?.points ?? []),
        segments: results.flatMap((result) => result.plotMetadata?.segments ?? []),
      }),
    });
    // Superseded/cleared requests must not evict or replace the displayed run.
    if (generation === this.plotGeneration) {
      this.plotRuns.set(runId, run);
      while (this.plotRuns.size > this.maxPlotRuns) {
        this.plotRuns.delete(this.plotRuns.keys().next().value!);
      }
      requests.forEach((request, index) => {
        if (generation === this.plotGeneration) {
          this.eventBus.publish(EVENT_NAMES.EXECUTION_COMPLETED, {
            channelId: request.channelId, runId, result: results[index],
          });
        }
      });
      if (generation === this.plotGeneration) {
        this.eventBus.publish(EVENT_NAMES.PLOT_RUN_COMPLETED, { runId });
      }
    }
    return run;
  }

  getPlotRun(runId: string): PlotRunSnapshot | undefined {
    return this.plotRuns.get(runId);
  }

  getRunTool(runId: string, programId: string, channelId: ChannelId, toolNumber: number | string | null | undefined) {
    if (toolNumber === undefined || toolNumber === null || toolNumber === 'unknown') return undefined;
    const input = this.plotRuns.get(runId)?.inputs.find((entry) =>
      entry.snapshot.identity.programId === programId && entry.snapshot.identity.channelId === channelId);
    return input?.snapshot.tools.find((tool) => tool.toolNumber === toolNumber);
  }

  discardPlotRun(runId: string): void {
    this.plotRuns.delete(runId);
  }

  cancelPendingPlot(): void {
    this.plotGeneration++;
  }

  async executeProgram(
    request: ExecutionRequest,
    // Accepted for legacy callers only. All application plots request the centre path.
    _toolPathMode: ToolPathMode = 'center',
  ): Promise<ExecutedProgramResult> {
    try {
      const plotRequest = this.buildPlotRequest([request]);

      console.debug('Plot request payload for channel', request.channelId, plotRequest);
      // Make server request
      const response: PlotResponse = await this.backend.requestPlot(plotRequest);
      console.debug('Plot response for channel', request.channelId, response);

      // Parse response
      const result = this.parseExecutionResponse(response, request.channelId);

      // Cache result
      const cacheKey = this.getCacheKey(request);
      this.executionCache.set(cacheKey, result);
      while (this.executionCache.size > this.maxPlotRuns) {
        this.executionCache.delete(this.executionCache.keys().next().value!);
      }

      // Publish event
      this.eventBus.publish(EVENT_NAMES.EXECUTION_COMPLETED, {
        channelId: request.channelId,
        result,
      });

      return result;
    } catch (error) {
      console.error('Execution failed:', error);
      this.eventBus.publish(EVENT_NAMES.EXECUTION_ERROR, {
        channelId: request.channelId,
        error,
      });
      throw error;
    }
  }

  async executeMultipleChannels(
    requests: ExecutionRequest[],
    // Accepted for legacy callers only; never forwarded to the backend.
    _toolPathMode: ToolPathMode = 'center',
  ): Promise<ExecutedProgramResult[]> {
    try {
      const plotRequest = this.buildPlotRequest(requests);

      // Make server request
      const response: PlotResponse = await this.backend.requestPlot(plotRequest);
      console.debug('Plot response for multi-channel request', response);

      // Parse response for each channel
      const results = requests.map((req) => {
        return this.parseExecutionResponse(response, req.channelId);
      });

      // Publish events
      requests.forEach((req, index) => {
        this.eventBus.publish(EVENT_NAMES.EXECUTION_COMPLETED, {
          channelId: req.channelId,
          result: results[index],
        });
      });

      return results;
    } catch (error) {
      console.error('Multi-channel execution failed:', error);
      requests.forEach((req) => {
        this.eventBus.publish(EVENT_NAMES.EXECUTION_ERROR, {
          channelId: req.channelId,
          error,
        });
      });
      throw error;
    }
  }

  private buildPlotRequest(requests: ExecutionRequest[]): PlotRequest {
    // Enforce at the shared boundary, including channel-header and host-triggered plots.
    // This requests the reference path; it does not certify backend compensation accuracy.
    return {
      toolPathMode: 'center',
      machinedata: requests.map((request) => ({
        program: this.preprocessProgram(request.program),
        machineName: request.machineName,
        canalNr: request.channelId,
        toolValues: request.toolValues,
        ...(request.toolOffsets !== undefined ? { toolOffsets: request.toolOffsets } : {}),
        customVariables: request.customVariables,
      })),
    };
  }

  private preprocessProgram(program: string): string {
    // We no longer strip () or {} here because the backend parser handles comments correctly.
    // Previously this was stripping brackets but leaving content, causing parsing errors.

    // Do not replace with ';' if the backend already supports \n and \r\n,
    // or at least handle \r to avoid double-splitting \r;
    return program.replace(/\r?\n/g, '\n');
  }

  private parseExecutionResponse(
    response: PlotResponse,
    targetChannelId?: string,
  ): ExecutedProgramResult {
    const result: ExecutedProgramResult = {
      executedLines: [],
      variableSnapshot: new Map(),
      namedVariableSnapshot: new Map(),
      timingData: new Map(),
      plotMetadata: {
        points: [],
        segments: [],
      },
      errors: [],
    };

    // Check for errors in response
    if (
      response.message &&
      typeof response.message === 'string' &&
      response.message.startsWith('Error')
    ) {
      throw new Error(`Server error: ${response.message}`);
    }

    // Parse top-level errors
    if (response.errors && Array.isArray(response.errors)) {
      response.errors.forEach((err) => {
        // Filter by channel if targetChannelId is specified
        // Backend returns canal as number, targetChannelId is string
        if (targetChannelId && err.canal !== parseInt(targetChannelId, 10)) {
          return;
        }

        result.errors!.push({
          lineNumber: err.line,
          message: err.message,
          severity: 'error',
        });
      });
    }

    // Parse canal data if available
    if (response.canal && typeof response.canal === 'object') {
      console.debug('Canal data received:', response.canal);

      // Parse the canal data - it's keyed by canal number
      const canalData = response.canal as Record<string, BackendPlotChannel>;

      // Merge data from all canals
      for (const canalNr of Object.keys(canalData)) {
        // If a specific channel was requested, only process data for that channel
        if (targetChannelId && canalNr !== targetChannelId) {
          continue;
        }

        const canal = canalData[canalNr];

        // Parse executed lines
        if (canal.executedLines && Array.isArray(canal.executedLines)) {
          result.executedLines.push(...canal.executedLines);
        }

        // Parse timing data. Backend timings are emitted for plotted segments,
        // not for every executed line, so index them by the matching segment line.
        if (canal.timing && Array.isArray(canal.timing)) {
          canal.timing.forEach((time, index) => {
            const lineNumber = canal.segments?.[index]?.lineNumber ?? canal.executedLines?.[index] ?? index + 1;
            const priorTime = result.timingData.get(lineNumber) ?? 0;
            result.timingData.set(lineNumber, priorTime + time);
          });
        }

        // Parse variables
        if (canal.variables && typeof canal.variables === 'object') {
          for (const [key, value] of Object.entries(canal.variables)) {
            const varNum = parseInt(key, 10);
            if (!isNaN(varNum)) {
              result.variableSnapshot.set(varNum, value);
            }
          }
        }

        if (canal.namedVariables && typeof canal.namedVariables === 'object') {
          for (const [key, value] of Object.entries(canal.namedVariables)) {
            result.namedVariableSnapshot.set(key, value);
          }
        }

        // Parse segments and convert to PlotSegment format
        // Track added points to avoid duplicates
        const addedPoints = new Set<string>();
        const getPointKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

        const canalSegmentCount = canal.segments?.length ?? 0;
        if (canalSegmentCount === 0) {
          console.debug('Canal has zero segments:', canalNr);
        }

        if (canal.segments && Array.isArray(canal.segments)) {
          canal.segments.forEach((segment, sourceSegmentIndex) => {
            if (segment.points && segment.points.length >= 2) {
              let segmentType: 'rapid' | 'feed' | 'arc' | undefined;
              const traversal = segment.traversal?.toUpperCase();
              const geometry = segment.geometry?.toUpperCase();

              if (traversal === 'RAPID') {
                segmentType = 'rapid';
              } else if (traversal === 'FEED' && (geometry === 'ARC_CW' || geometry === 'ARC_CCW')) {
                segmentType = 'arc';
              } else if (traversal === 'FEED' && geometry === 'LINEAR') {
                segmentType = 'feed';
              }

              if (!segmentType) {
                console.warn('Skipping segment without supported motion semantics:', segment);
                return;
              }

              const mappedPoints = segment.points.map((point) => ({
                x: point.x,
                y: point.y,
                z: point.z,
                lineNumber: segment.lineNumber,
              }));

              mappedPoints.forEach((point) => {
                const pointKey = getPointKey(point.x, point.y, point.z);
                if (!addedPoints.has(pointKey)) {
                  addedPoints.add(pointKey);
                  result.plotMetadata!.points.push(point);
                }
              });

              for (let index = 0; index < mappedPoints.length - 1; index += 1) {
                result.plotMetadata!.segments.push({
                  startPoint: mappedPoints[index],
                  endPoint: mappedPoints[index + 1],
                  type: segmentType,
                  toolNumber: segment.toolNumber,
                  executionStep: segment.executionStep,
                  sourceSegmentIndex,
                  subsegmentIndex: index,
                  channelId: canalNr as ChannelId,
                });
              }
            }
          });
        }
      }
    }

    return result;
  }

  private getCacheKey(request: ExecutionRequest): string {
    // Create a simple hash of the request content
    // Using a basic string hash for cache key generation
    const content = `${request.channelId}-${request.machineName}-${request.program}`;
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return `${request.channelId}-${request.machineName}-${Math.abs(hash)}`;
  }

  getCachedResult(request: ExecutionRequest): ExecutedProgramResult | undefined {
    const cacheKey = this.getCacheKey(request);
    return this.executionCache.get(cacheKey);
  }

  clearCache(): void {
    this.executionCache.clear();
    this.plotRuns.clear();
    this.cancelPendingPlot();
  }
}
