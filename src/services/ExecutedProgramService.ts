// ExecutedProgramService for server-side program execution

import type {
  ChannelId,
  MachineType,
  ExecutedProgramResult,
  PlotRequest,
  PlotResponse,
  ToolValue,
  CustomVariable,
} from '@core/types';
import { BackendGateway } from './BackendGateway';
import { EventBus, EVENT_NAMES } from './EventBus';

export interface ExecutionRequest {
  channelId: ChannelId;
  program: string;
  machineName: MachineType;
  toolValues?: ToolValue[];
  customVariables?: CustomVariable[];
}

export class ExecutedProgramService {
  private backend: BackendGateway;
  private eventBus: EventBus;
  private executionCache = new Map<string, ExecutedProgramResult>();

  constructor(backend: BackendGateway, eventBus: EventBus) {
    this.backend = backend;
    this.eventBus = eventBus;
  }

  async executeProgram(request: ExecutionRequest): Promise<ExecutedProgramResult> {
    try {
      // Preprocess program: remove () {} characters as per server requirements
      const cleanProgram = this.preprocessProgram(request.program);

      // Build plot request
      const plotRequest: PlotRequest = {
        machinedata: [
          {
            program: cleanProgram,
            machineName: request.machineName,
            canalNr: request.channelId,
            toolValues: request.toolValues,
            customVariables: request.customVariables,
          },
        ],
      };

      console.debug('Plot request payload for channel', request.channelId, plotRequest);
      // Make server request
      const response: PlotResponse = await this.backend.requestPlot(plotRequest);
      console.debug('Plot response for channel', request.channelId, response);

      // Parse response
      const result = this.parseExecutionResponse(response, request.channelId);

      // Cache result
      const cacheKey = this.getCacheKey(request);
      this.executionCache.set(cacheKey, result);

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

  async executeMultipleChannels(requests: ExecutionRequest[]): Promise<ExecutedProgramResult[]> {
    try {
      // Preprocess all programs
      const machinedata = requests.map((req) => ({
        program: this.preprocessProgram(req.program),
        machineName: req.machineName,
        canalNr: req.channelId,
        toolValues: req.toolValues,
        customVariables: req.customVariables,
      }));

      // Build plot request
      const plotRequest: PlotRequest = { machinedata };

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
      const canalData = response.canal as Record<
        string,
        {
          segments?: Array<{
            type?: string;
            lineNumber?: number;
            toolNumber?: number;
            points?: Array<{ x: number; y: number; z: number }>;
          }>;
          executedLines?: number[];
          variables?: Record<string, number>;
          timing?: number[];
          errors?: Array<{
            type: string;
            code: number;
            line: number;
            message: string;
            value: string;
            canal: number;
          }>;
        }
      >;

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

        // Parse segments and convert to PlotSegment format
        // Track added points to avoid duplicates
        const addedPoints = new Set<string>();
        const getPointKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

        const canalSegmentCount = canal.segments?.length ?? 0;
        if (canalSegmentCount === 0) {
          console.debug('Canal has zero segments:', canalNr);
        }

        if (canal.segments && Array.isArray(canal.segments)) {
          canal.segments.forEach((segment) => {
            if (segment.points && segment.points.length >= 2) {
              // Map server segment type to client type
              let segmentType: 'rapid' | 'feed' | 'arc' = 'feed';
              if (segment.type) {
                const serverType = segment.type.toUpperCase();
                if (serverType === 'RAPID' || serverType === 'G0') {
                  segmentType = 'rapid';
                } else if (serverType === 'ARC' || serverType === 'G2' || serverType === 'G3') {
                  segmentType = 'arc';
                }
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
  }
}
