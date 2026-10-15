import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import type { MachineProfile, PlotRequest, PlotResponse } from '@core/types';
import { BackendGateway } from '../../BackendGateway';
import { EventBus } from '../../EventBus';
import { ExecutedProgramService } from '../../ExecutedProgramService';
import { ProgramToolService } from '../ProgramToolService';
import { SimulationCommentCodec } from '../SimulationCommentCodec';
import { buildInsertContour } from '../InsertOutline';
import { CuttingToolModel } from '../../simulation/shared/CuttingToolModel';
import { rotationQuaternion, stockPlacement } from '../../simulation/shared/SimulationTransforms';
import { compileGpuSweeps } from '../../simulation/strategies/gpu-dexel/GpuSweepCompiler';
import { RotationalProfile } from '../../simulation/strategies/cpu-hybrid/RotationalProfile';

const url = process.env.NCEDIT_LIVE_BACKEND;
const fixture = process.env.NCEDIT_LIVE_PROGRAM;

it.skipIf(!url || !fixture)('verifies the corrected program against real backend center paths, insert locations and CPU profiles', async () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  try {
    const machines = await (await fetch(`${url}/api/machines`)).json();
    const machine = machines.machines.find((m: MachineProfile) => m.machineName === 'FANUC_STAR_SR20R_IV_B') as MachineProfile;
    expect(machine.turningReferenceContract).toBe('resolved-center-path-v1');
    const tools = new ProgramToolService(new SimulationCommentCodec());
    const snapshot = tools.captureProgramSnapshot(
      { documentId: 'live-reference', programId: 'corrected', channelId: '1' }, 1,
      readFileSync(fixture!, 'utf8'), { kind: 'block', open: '(', close: ')' },
    );
    expect(snapshot.valid).toBe(true);
    expect(snapshot.tools.find((tool) => tool.toolNumber === 200)).toMatchObject({
      Q: 3, R: 0.2, orientation: [0, 90, 0],
      cutting: [{ type: 'insert', shape: 'V', noseRadius: 0.2, ic: 4.7625,
        thickness: 1.59, position: [-8, 0, 0], rotation: [0, 19, 0] }],
    });
    expect(snapshot.tools.find((tool) => tool.toolNumber === 3300)).toMatchObject({
      orientation: [0, 90, 0], cutting: [{ type: 'endMill', diameter: 3, length: 9 }],
      holder: [{ type: 'cylinder', diameter: 3, length: 12, stickOut: 9 }],
    });
    for (const [toolNumber, orientation] of [[1100, [0, 90, 0]], [1200, [0, 180, 0]]] as const)
      expect(snapshot.tools.find((tool) => tool.toolNumber === toolNumber)).toMatchObject({
        orientation, cutting: [{ type: 'drill', diameter: 2, length: 12, tipAngle: 118 }],
        holder: [{ type: 'cylinder', diameter: 2, length: 12, stickOut: 12 }],
      });
    let response: PlotResponse | undefined;
    const backend = {
      async requestPlot(request: PlotRequest) {
        expect(request.toolPathMode).toBe('center');
        expect(request.machinedata[0].simulation?.tools.find((tool) => tool.toolNumber === 200)?.turningNoseRadius).toBe(0.2);
        const http = await fetch(`${url}/cgiserver_import`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
        });
        expect(http.ok).toBe(true);
        response = await http.json() as PlotResponse;
        return response;
      },
    } as BackendGateway;
    const run = await new ExecutedProgramService(backend, new EventBus()).executePlotRun([{
      snapshot, machineName: machine.machineName, machineProfile: machine,
      toolValues: tools.getExecutionToolValues(snapshot), customVariables: [],
    }], true, 'simulation');
    const simulation = run.materialRemoval!.simulation!;
    expect(response?.success).toBe(true);
    expect(simulation.motions[0].executionStep).toBe(30);
    expect(simulation.motions.length).toBeGreaterThan(18);
    expect(simulation.motions.some((motion) => motion.lineNumber === 50)).toBe(true);
    expect(simulation.stop?.lineNumber ?? Infinity).toBeGreaterThan(50);
    let verifiedSamples = 0;
    let verifiedVertices = 0;
    for (const segment of run.plotMetadata.segments) {
      if (!segment.poses?.[0].turningReference) continue;
      const tool = snapshot.tools.find((candidate) => candidate.toolNumber === segment.toolNumber)!;
      const part = tool.cutting![0];
      if (part.type !== 'insert') throw new Error('Wrong cutter for turning');
      const contour = buildInsertContour(part, tool.turning?.activeCorner);
      const partRotation = rotationQuaternion(part.rotation ?? [0, 0, 0]);
      const center = new THREE.Vector3(contour.radiusCenter![0], 0, contour.radiusCenter![1]).applyQuaternion(partRotation);
      const cutter = new CuttingToolModel(tool, segment.motionContext!.toolOffset.tipOrientation);
      for (const [pose, point] of [
        [segment.poses[segment.subsegmentIndex!], segment.startPoint],
        [segment.poses[segment.subsegmentIndex! + 1], segment.endPoint],
      ] as const) {
        const orientation = new THREE.Quaternion(...pose.orientation);
        const origin = new THREE.Vector3(...pose.position);
        const backendCenter = new THREE.Vector3(point.x, point.y, point.z);
        const resolved = pose.turningReference!;
        const centerPath = resolved.radiusMode !== 'OFF' && resolved.compensationRadius > 0;
        const vectors = [[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1],
          [0, -1], [1, 0], [0, 1], [-1, 0], [0, 0]];
        const [qx, qz] = vectors[resolved.tipOrientation];
        const expectedNose = backendCenter.clone().add(
          centerPath ? new THREE.Vector3() : new THREE.Vector3(qx * part.noseRadius, 0, qz * part.noseRadius),
        );
        const actualNose = new THREE.Vector3(contour.radiusCenter![0], 0, contour.radiusCenter![1])
          .applyMatrix4(cutter.partToAssembly).applyQuaternion(orientation).add(origin);
        expect(actualNose.distanceTo(expectedNose)).toBeLessThan(1e-8);
        for (let index = 0; index < contour.contour.length; index++) {
          const [x, z] = contour.contour[index];
          const expected = new THREE.Vector3(x, 0, z).applyQuaternion(partRotation).sub(center)
            .applyQuaternion(orientation).add(expectedNose);
          const actual = cutter.insertSection![index].clone().applyQuaternion(orientation).add(origin);
          expect(actual.distanceTo(expected)).toBeLessThan(1e-8);
          // Stock translations/rotations do not change the reference coincidence.
          const transformedStock = stockPlacement(
            { ...simulation.stock, position: [3, -2, 5], rotation: [20, 30, 40] },
            { ...simulation.binding, position: [-4, 6, 1], rotation: [10, -15, 25] },
          ).invert();
          expect(actual.applyMatrix4(transformedStock).distanceTo(expected.applyMatrix4(transformedStock))).toBeLessThan(1e-8);
          verifiedVertices++;
        }
        verifiedSamples++;
      }
    }
    expect(verifiedSamples).toBeGreaterThan(20);
    const sweeps = compileGpuSweeps(simulation);
    const stopped = run.plotMetadata.segments.find((segment) =>
      segment.executionStep === simulation.stop?.executionStep,
    );
    const profile = new RotationalProfile(10, 50);
    let applied = 0;
    for (const sweep of sweeps) {
      if (!sweep.turningVolume || !profile.canApply(sweep.turningVolume)) break;
      profile.apply(sweep.turningVolume, () => {});
      applied++;
    }
    expect(applied).toBeGreaterThan(18);
    expect(profile.meridianSlabs.length).toBeGreaterThan(1);
    console.log('LIVE_TURNING_REFERENCE', JSON.stringify({
      motions: simulation.motions.length, first: simulation.motions[0].executionStep,
      last: simulation.motions.at(-1)?.executionStep, lastLine: simulation.motions.at(-1)?.lineNumber,
      stop: simulation.stop, rawStops: run.plotMetadata.removalStops,
      stoppedMotion: stopped && { start: stopped.startPoint, end: stopped.endPoint,
        mode: stopped.machiningMode, orientation: stopped.poses?.[0].orientation },
      verifiedSamples, verifiedVertices, cpuProfileSweeps: applied,
      tools: snapshot.tools.filter((tool) => [200, 3300, 1100, 1200].includes(Number(tool.toolNumber))),
    }));
  } finally {
    debug.mockRestore();
  }
}, 120000);
