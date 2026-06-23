import { TransferProgram } from '@core/types';

export interface ITransferProtocol {
  ping(ip: string): Promise<boolean>;
  connect(ip: string, port?: number): Promise<void>;
  listPrograms(ip: string, pathNo: number, port?: number): Promise<TransferProgram[]>;
  uploadProgram(ip: string, pathNo: number, progNum: number, port?: number): Promise<string>;
  /** fileExtension: machine-config-derived extension (e.g. ".P1", ".p-2", ".PA", ""). Optional — backends use a fallback when omitted. */
  downloadProgram(ip: string, pathNo: number, programText: string, port?: number, fileExtension?: string): Promise<void>;
}
