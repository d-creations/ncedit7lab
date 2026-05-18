// PlotService for managing three.js scene and plot data

import * as THREE from 'three';
import type { ChannelId, MachineType, PlotMetadata, PlotSegment } from '@core/types';
import { EventBus } from './EventBus';

export interface PlotCache {
  channelId: ChannelId;
  machineName: MachineType;
  metadata: PlotMetadata;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export class PlotService {
  private plotCache = new Map<string, PlotCache>();

  constructor(_eventBus: EventBus) {
    // EventBus may be used in future for plot updates
  }

  createPlotGeometry(metadata: PlotMetadata): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();

    if (!metadata.points || metadata.points.length === 0) {
      return geometry;
    }

    // Create vertices from points
    const vertices: number[] = [];
    metadata.points.forEach((point) => {
      vertices.push(point.x, point.y, point.z);
    });

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

    // Create line segments if we have segment data
    if (metadata.segments && metadata.segments.length > 0) {
      const indices: number[] = [];
      metadata.segments.forEach((segment) => {
        // Find indices of start and end points
        const startIdx = metadata.points.findIndex(
          (p) =>
            p.x === segment.startPoint.x &&
            p.y === segment.startPoint.y &&
            p.z === segment.startPoint.z,
        );
        const endIdx = metadata.points.findIndex(
          (p) =>
            p.x === segment.endPoint.x && p.y === segment.endPoint.y && p.z === segment.endPoint.z,
        );

        if (startIdx >= 0 && endIdx >= 0) {
          indices.push(startIdx, endIdx);
        }
      });

      geometry.setIndex(indices);
    }

    return geometry;
  }

  createPlotMaterial(segmentType?: 'rapid' | 'feed' | 'arc'): THREE.LineBasicMaterial {
    const colors = {
      rapid: 0x00ff00, // Green for rapid moves
      feed: 0x0088ff, // Blue for feed moves
      arc: 0xff8800, // Orange for arcs
      default: 0xffffff, // White for default
    };

    const color = segmentType ? colors[segmentType] : colors.default;

    return new THREE.LineBasicMaterial({
      color,
      // Note: linewidth is deprecated in WebGL and has no effect in most contexts
      // For thicker lines, consider using LineSegments2 from three/examples
    });
  }

  createToolpathLine(
    metadata: PlotMetadata,
    channelId: ChannelId,
    machineName: MachineType,
  ): THREE.Line | null {
    if (!metadata.points || metadata.points.length === 0) {
      return null;
    }

    const geometry = this.createPlotGeometry(metadata);
    const material = this.createPlotMaterial();
    const line = new THREE.Line(geometry, material);

    // Cache the plot data
    this.plotCache.set(this.getCacheKey(channelId, machineName), {
      channelId,
      machineName,
      metadata,
      geometry,
      material,
    });

    return line;
  }

  createSegmentedToolpath(metadata: PlotMetadata): THREE.Group {
    const group = new THREE.Group();

    if (!metadata.segments || metadata.segments.length === 0) {
      return group;
    }

    // Group segments by type
    const segmentsByType = new Map<'rapid' | 'feed' | 'arc', PlotSegment[]>();

    metadata.segments.forEach((segment) => {
      const type = segment.type || 'feed';
      if (!segmentsByType.has(type)) {
        segmentsByType.set(type, []);
      }
      segmentsByType.get(type)!.push(segment);
    });

    // Create separate geometry for each type
    segmentsByType.forEach((segments, type) => {
      const vertices: number[] = [];

      segments.forEach((segment) => {
        vertices.push(
          segment.startPoint.x,
          segment.startPoint.y,
          segment.startPoint.z,
          segment.endPoint.x,
          segment.endPoint.y,
          segment.endPoint.z,
        );
      });

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));

      const material = this.createPlotMaterial(type);
      const line = new THREE.LineSegments(geometry, material);

      group.add(line);
    });

    return group;
  }

  createMachineGeometry(): THREE.Group {
    const group = new THREE.Group();

    // Create a simple coordinate system for now
    const axisLength = 100;

    // X axis - Red
    const xGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(axisLength, 0, 0),
    ]);
    const xMaterial = new THREE.LineBasicMaterial({ color: 0xff0000 });
    group.add(new THREE.Line(xGeometry, xMaterial));

    // Y axis - Green
    const yGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, axisLength, 0),
    ]);
    const yMaterial = new THREE.LineBasicMaterial({ color: 0x00ff00 });
    group.add(new THREE.Line(yGeometry, yMaterial));

    // Z axis - Blue
    const zGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, axisLength),
    ]);
    const zMaterial = new THREE.LineBasicMaterial({ color: 0x0000ff });
    group.add(new THREE.Line(zGeometry, zMaterial));

    // TODO: Add machine-specific geometry (chuck, turret, etc.)
    return group;
  }

  getCachedPlot(channelId: ChannelId, machineName: MachineType): PlotCache | undefined {
    return this.plotCache.get(this.getCacheKey(channelId, machineName));
  }

  clearCache(channelId?: ChannelId): void {
    if (channelId) {
      // Clear specific channel
      Array.from(this.plotCache.keys())
        .filter((key) => key.startsWith(`${channelId}-`))
        .forEach((key) => this.plotCache.delete(key));
    } else {
      this.plotCache.clear();
    }
  }

  private getCacheKey(channelId: ChannelId, machineName: MachineType): string {
    return `${channelId}-${machineName}`;
  }

  dispose(): void {
    // Dispose of all geometries and materials
    this.plotCache.forEach((cache) => {
      cache.geometry.dispose();
      cache.material.dispose();
    });
    this.plotCache.clear();
  }
}
