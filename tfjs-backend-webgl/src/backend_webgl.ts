/**
 * @license
 * Copyright 2017 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

// Import webgl flags.
import './flags_webgl';

import * as tf from '@tensorflow/tfjs-core';
import {backend_util, buffer, DataId, DataStorage, DataType, DataValues, engine, env, kernel_impls, KernelBackend, MemoryInfo, NumericDataType, range, Rank, RecursiveArray, scalar, ShapeMap, slice_util, tensor, Tensor, Tensor1D, Tensor2D, Tensor3D, TensorBuffer, TensorInfo, tidy, TimingInfo, transpose, TypedArray, upcastType, util} from '@tensorflow/tfjs-core';

import {ceilImplCPU, expm1ImplCPU, gatherV2ImplCPU, logImplCPU, negImplCPU, rsqrtImplCPU, simpleAbsImplCPU, stridedSliceImplCPU, topKImplCPU} from './kernel_utils/shared';

const {segment_util} = backend_util;
const split = kernel_impls.split;
const whereImpl = kernel_impls.whereImpl;

import {AddNProgram} from './addn_gpu';
import {AddNPackedProgram} from './addn_packed_gpu';
import {ArgMinMaxProgram} from './argminmax_gpu';
import {ArgMinMaxPackedProgram} from './argminmax_packed_gpu';
import {getWebGLContext} from './canvas_util';
import {ClipProgram} from './clip_gpu';
import {ClipPackedProgram} from './clip_packed_gpu';
import {ComplexAbsProgram} from './complex_abs_gpu';
import {DecodeMatrixProgram} from './decode_matrix_gpu';
import {DecodeMatrixPackedProgram} from './decode_matrix_packed_gpu';
import {EncodeFloatProgram} from './encode_float_gpu';
import {EncodeFloatPackedProgram} from './encode_float_packed_gpu';
import {EncodeMatrixProgram} from './encode_matrix_gpu';
import {EncodeMatrixPackedProgram} from './encode_matrix_packed_gpu';
import {GatherProgram} from './gather_gpu';
import {GPGPUContext} from './gpgpu_context';
import * as gpgpu_math from './gpgpu_math';
import {GPGPUBinary, GPGPUProgram, TensorData} from './gpgpu_math';
import {MatMulPackedProgram} from './mulmat_packed_gpu';
import {PackProgram} from './pack_gpu';
import {ReshapePackedProgram} from './reshape_packed_gpu';
import {ReverseProgram} from './reverse_gpu';
import {ReversePackedProgram} from './reverse_packed_gpu';
import {SegmentOpProgram} from './segment_gpu';
import {SelectProgram} from './select_gpu';
import {StridedSliceProgram} from './strided_slice_gpu';
import * as tex_util from './tex_util';
import {TextureData, TextureUsage} from './tex_util';
import {TextureManager} from './texture_manager';
import * as unary_op from './unaryop_gpu';
import {UnaryOpProgram} from './unaryop_gpu';
import * as unary_packed_op from './unaryop_packed_gpu';
import {UnaryOpPackedProgram} from './unaryop_packed_gpu';
import {UnpackProgram} from './unpack_gpu';
import * as webgl_util from './webgl_util';
import {BackendValues} from '@tensorflow/tfjs-core';

export const EPSILON_FLOAT32 = 1e-7;
export const EPSILON_FLOAT16 = 1e-4;

type KernelInfo = {
  name: string; query: Promise<number>;
};

export type TimerNode = RecursiveArray<KernelInfo>|KernelInfo;
export interface CPUTimerQuery {
  startMs: number;
  endMs?: number;
}

export interface WebGLMemoryInfo extends MemoryInfo {
  numBytesInGPU: number;
  // Tracks the total number of bytes allocated on the GPU, accounting for the
  // physical texture type.
  numBytesInGPUAllocated: number;
  // Tracks byte size of textures that were created and then made available for
  // reuse (disposed).
  numBytesInGPUFree: number;
  unreliable: boolean;
}

export interface WebGLTimingInfo extends TimingInfo {
  uploadWaitMs: number;
  downloadWaitMs: number;
}

const binaryCaches: {[webGLVersion: string]: {[key: string]: GPGPUBinary}} = {};

export function getBinaryCache(webGLVersion: number) {
  if (webGLVersion in binaryCaches) {
    return binaryCaches[webGLVersion];
  }
  binaryCaches[webGLVersion] = {};
  return binaryCaches[webGLVersion];
}

// Empirically determined constant used to determine size threshold for handing
// off execution to the CPU.
const CPU_HANDOFF_SIZE_THRESHOLD = 128;

// Empirically determined constant used to decide the number of MB on GPU
// before we warn about high memory use. The MB are this constant * screen area
// * dpi / 1024 / 1024.
const BEFORE_PAGING_CONSTANT = 600;
function numMBBeforeWarning(): number {
  if (env().global.screen == null) {
    return 1024;  // 1 GB.
  }
  return (env().global.screen.height * env().global.screen.width *
          window.devicePixelRatio) *
      BEFORE_PAGING_CONSTANT / 1024 / 1024;
}

// TODO(yassogba) remove this once the backend has been modularized
// a copy is needed here to break a circular dependency.
function mapActivationToShaderProgram(
    activation: backend_util.Activation, packed = false): string {
  if (activation === 'linear') {
    if (packed) {
      return unary_packed_op.LINEAR;
    }
    return unary_op.LINEAR;
  } else if (activation === 'relu') {
    if (packed) {
      return unary_packed_op.RELU;
    }
    return unary_op.RELU;
  } else if (activation === 'elu') {
    if (packed) {
      return unary_packed_op.ELU;
    }
    return unary_op.ELU;
  } else if (activation === 'relu6') {
    if (packed) {
      return unary_packed_op.RELU6;
    }
    return unary_op.RELU6;
  } else if (activation === 'prelu') {
    // Duplicated to avoid a circular dependency
    const PRELU = `return (a < 0.) ? b * a : a;`;
    const PRELU_PACKED = `
  vec4 aLessThanZero = vec4(lessThan(a, vec4(0.)));
  return (aLessThanZero * (b * a)) + ((vec4(1.0) - aLessThanZero) * a);
`;
    if (packed) {
      return PRELU_PACKED;
    }
    return PRELU;
  }
  throw new Error(`Activation ${
      activation} has not been implemented for the WebGL backend.`);
}

export class MathBackendWebGL extends KernelBackend {
  texData: DataStorage<TextureData>;
  gpgpu: GPGPUContext;

  // Maps data ids that have a pending read operation, to list of subscribers.
  private pendingRead = new WeakMap<DataId, Array<(arr: TypedArray) => void>>();
  // List of data ids that are scheduled for disposal, but are waiting on a
  // pending read operation.
  private pendingDisposal = new WeakSet<DataId>();

  // Used to count the number of 'shallow' sliced tensors that point to the
  // same data id.
  dataRefCount = new WeakMap<DataId, number>();
  private numBytesInGPU = 0;

  private canvas: HTMLCanvasElement|OffscreenCanvas;

  private programTimersStack: TimerNode[];
  private activeTimers: TimerNode[];
  // Accumulated time spent (including blocking) in uploading data to webgl.
  private uploadWaitMs = 0;
  // Accumulated time spent (including blocking in downloading data from webgl.
  private downloadWaitMs = 0;
  private cpuBackend: KernelBackend;

  // Number of bits of precision of this backend.
  private floatPrecisionValue: 32|16;

  private textureManager: TextureManager;
  private binaryCache: {[key: string]: GPGPUBinary};
  private gpgpuCreatedLocally: boolean;
  private numMBBeforeWarning: number;
  private warnedAboutMemory = false;
  private warnedAboutCPUBackend = false;

  constructor(gpgpu?: GPGPUContext) {
    super();
    if (!env().getBool('HAS_WEBGL')) {
      throw new Error('WebGL is not supported on this device');
    }

    if (gpgpu == null) {
      const gl = getWebGLContext(env().getNumber('WEBGL_VERSION'));
      this.binaryCache = getBinaryCache(env().getNumber('WEBGL_VERSION'));
      this.gpgpu = new GPGPUContext(gl);
      this.canvas = gl.canvas;
      this.gpgpuCreatedLocally = true;
    } else {
      this.gpgpu = gpgpu;
      this.binaryCache = {};
      this.gpgpuCreatedLocally = false;
      this.canvas = gpgpu.gl.canvas;
    }
    this.textureManager = new TextureManager(this.gpgpu);
    this.numMBBeforeWarning = numMBBeforeWarning();

    this.texData = new DataStorage(this, engine());
  }

  numDataIds() {
    return this.texData.numDataIds() +
        (this.cpuBackend ? this.cpuBackend.numDataIds() : 0) -
        this.pendingDeletes;
  }

  write(values: BackendValues, shape: number[], dtype: DataType): DataId {
    if (env().getBool('WEBGL_CHECK_NUMERICAL_PROBLEMS') ||
        env().getBool('DEBUG')) {
      this.checkNumericalProblems(values);
    }
    if (dtype === 'complex64' && values != null) {
      throw new Error(
          `Cannot write to a complex64 dtype. ` +
          `Please use tf.complex(real, imag).`);
    }
    const dataId = {};
    this.texData.set(dataId, {
      shape,
      dtype,
      values,
      usage: TextureUsage.UPLOAD,
      refCount: 1,
      complexParentRefCount: 0
    });
    return dataId;
  }

  /** Increase refCount of a `TextureData`. */
  incRef(dataId: DataId): void {
    const texData = this.texData.get(dataId);
    texData.refCount++;
  }

  /** Decrease refCount of a `TextureData`. */
  decRef(dataId: DataId): void {
    if (this.texData.has(dataId)) {
      const texData = this.texData.get(dataId);
      texData.refCount--;
    }
  }

  move(dataId: DataId, values: BackendValues, shape: number[], dtype: DataType):
      void {
    if (env().getBool('DEBUG')) {
      this.checkNumericalProblems(values);
    }
    if (dtype === 'complex64') {
      throw new Error(
          `Cannot write to a complex64 dtype. ` +
          `Please use tf.complex(real, imag).`);
    }
    this.texData.set(dataId, {
      shape,
      dtype,
      values,
      usage: TextureUsage.UPLOAD,
      refCount: 1,
      complexParentRefCount: 0
    });
  }

  disposeIntermediateTensorInfo(tensorInfo: TensorInfo): void {
    const dataId = tensorInfo.dataId;

    if (this.texData.has(dataId)) {
      const textureData = this.texData.get(dataId);

      textureData.refCount--;

      if (textureData.refCount < 1) {
        this.disposeData(dataId);
      }
    }
  }

  readSync(dataId: DataId): BackendValues {
    const texData = this.texData.get(dataId);
    const {values, dtype, complexTensorInfos, slice, shape, isPacked} = texData;

    // The presence of `slice` indicates this tensor is a shallow slice of a
    // different tensor, and is using that original tensor's texture. Run
    // `clone` in order to copy that texture and read from it.
    if (slice != null) {
      let program;
      if (isPacked) {
        program = new UnaryOpPackedProgram(shape, unary_op.CLONE);
      } else {
        program = new UnaryOpProgram(shape, unary_op.CLONE);
      }
      const res =
          this.runWebGLProgram(program, [{dataId, shape, dtype}], dtype);
      const data = this.readSync(res.dataId);
      this.disposeIntermediateTensorInfo(res);
      return data;
    }
    if (values != null) {
      return this.convertAndCacheOnCPU(dataId);
    }
    if (dtype === 'string') {
      return values;
    }
    const shouldTimeProgram = this.activeTimers != null;
    let start: number;
    if (shouldTimeProgram) {
      start = util.now();
    }

    let result: Float32Array;
    if (dtype === 'complex64') {
      const realValues =
          this.readSync(complexTensorInfos.real.dataId) as Float32Array;
      const imagValues =
          this.readSync(complexTensorInfos.imag.dataId) as Float32Array;
      result = backend_util.mergeRealAndImagArrays(realValues, imagValues);
    } else {
      result = this.getValuesFromTexture(dataId);
    }

    if (shouldTimeProgram) {
      this.downloadWaitMs += util.now() - start;
    }
    return this.convertAndCacheOnCPU(dataId, result);
  }

  async read(dataId: DataId): Promise<BackendValues> {
    if (this.pendingRead.has(dataId)) {
      const subscribers = this.pendingRead.get(dataId);
      return new Promise<TypedArray>(resolve => subscribers.push(resolve));
    }
    const texData = this.texData.get(dataId);
    const {values, shape, slice, dtype, complexTensorInfos, isPacked} = texData;

    // The presence of `slice` indicates this tensor is a shallow slice of a
    // different tensor, and is using that original tensor's texture. Run
    // `clone` in order to copy that texture and read from it.
    if (slice != null) {
      let program;
      if (isPacked) {
        program = new UnaryOpPackedProgram(shape, unary_op.CLONE);
      } else {
        program = new UnaryOpProgram(shape, unary_op.CLONE);
      }
      const res =
          this.runWebGLProgram(program, [{dataId, shape, dtype}], dtype);
      const data = this.read(res.dataId);
      this.disposeIntermediateTensorInfo(res);
      return data;
    }

    if (values != null) {
      return this.convertAndCacheOnCPU(dataId);
    }

    if (!env().getBool('WEBGL_DOWNLOAD_FLOAT_ENABLED') &&
        env().getNumber('WEBGL_VERSION') === 2) {
      throw new Error(
          `tensor.data() with WEBGL_DOWNLOAD_FLOAT_ENABLED=false and ` +
          `WEBGL_VERSION=2 not yet supported.`);
    }

    let buffer = null;
    let tmpDownloadTarget: TensorInfo;

    if (dtype !== 'complex64' && env().get('WEBGL_BUFFER_SUPPORTED')) {
      // Possibly copy the texture into a buffer before inserting a fence.
      tmpDownloadTarget = this.decode(dataId);
      const tmpData = this.texData.get(tmpDownloadTarget.dataId);

      buffer = this.gpgpu.createBufferFromTexture(
          tmpData.texture, ...tex_util.getDenseTexShape(shape));
    }

    this.pendingRead.set(dataId, []);

    if (dtype !== 'complex64') {
      // Create a fence and wait for it to resolve.
      await this.gpgpu.createAndWaitForFence();
    }

    // Download the values from the GPU.
    let vals: Float32Array;
    if (dtype === 'complex64') {
      const ps = await Promise.all([
        this.read(complexTensorInfos.real.dataId),
        this.read(complexTensorInfos.imag.dataId)
      ]);

      const realValues = ps[0];
      const imagValues = ps[1];
      vals = backend_util.mergeRealAndImagArrays(
          realValues as Float32Array, imagValues as Float32Array);
    } else if (buffer == null) {
      vals = this.getValuesFromTexture(dataId);
    } else {
      const size = util.sizeFromShape(shape);
      vals = this.gpgpu.downloadFloat32MatrixFromBuffer(buffer, size);
    }
    if (tmpDownloadTarget != null) {
      this.disposeIntermediateTensorInfo(tmpDownloadTarget);
    }
    const dTypeVals = this.convertAndCacheOnCPU(dataId, vals);

    const subscribers = this.pendingRead.get(dataId);
    this.pendingRead.delete(dataId);

    // Notify all pending reads.
    subscribers.forEach(resolve => resolve(dTypeVals));
    if (this.pendingDisposal.has(dataId)) {
      this.pendingDisposal.delete(dataId);
      this.disposeData(dataId);
      this.pendingDeletes--;
    }
    return dTypeVals;
  }

  bufferSync<R extends Rank>(t: TensorInfo): TensorBuffer<R> {
    const data = this.readSync(t.dataId);
    let decodedData = data as DataValues;
    if (t.dtype === 'string') {
      try {
        // Decode the bytes into string.
        decodedData = (data as Uint8Array[]).map(d => util.decodeString(d));
      } catch {
        throw new Error('Failed to decode encoded string bytes into utf-8');
      }
    }
    return buffer(t.shape as ShapeMap[R], t.dtype, decodedData) as
        TensorBuffer<R>;
  }

  private checkNumericalProblems(values: BackendValues): void {
    if (values == null) {
      return;
    }
    for (let i = 0; i < values.length; i++) {
      const num = values[i] as number;
      if (!webgl_util.canBeRepresented(num)) {
        if (env().getBool('WEBGL_RENDER_FLOAT32_CAPABLE')) {
          throw Error(
              `The value ${num} cannot be represented with your ` +
              `current settings. Consider enabling float32 rendering: ` +
              `'tf.env().set('WEBGL_RENDER_FLOAT32_ENABLED', true);'`);
        }
        throw Error(`The value ${num} cannot be represented on this device.`);
      }
    }
  }

  private getValuesFromTexture(dataId: DataId): Float32Array {
    const {shape, dtype, isPacked} = this.texData.get(dataId);
    const size = util.sizeFromShape(shape);
    if (env().getBool('WEBGL_DOWNLOAD_FLOAT_ENABLED')) {
      const tmpTarget = this.decode(dataId);
      const tmpData = this.texData.get(tmpTarget.dataId);
      const vals = this.gpgpu
                       .downloadMatrixFromPackedTexture(
                           tmpData.texture, ...tex_util.getDenseTexShape(shape))
                       .subarray(0, size);

      this.disposeIntermediateTensorInfo(tmpTarget);

      return vals;
    }

    const shouldUsePackedProgram =
        env().getBool('WEBGL_PACK') && isPacked === true;
    const outputShape =
        shouldUsePackedProgram ? webgl_util.getShapeAs3D(shape) : shape;
    const program = shouldUsePackedProgram ?
        new EncodeFloatPackedProgram(outputShape as [number, number, number]) :
        new EncodeFloatProgram(outputShape);
    const output = this.runWebGLProgram(
        program, [{shape: outputShape, dtype, dataId}], 'float32');
    const tmpData = this.texData.get(output.dataId);
    const vals =
        this.gpgpu
            .downloadByteEncodedFloatMatrixFromOutputTexture(
                tmpData.texture, tmpData.texShape[0], tmpData.texShape[1])
            .subarray(0, size);
    this.disposeIntermediateTensorInfo(output);

    return vals;
  }

  async time(f: () => void): Promise<WebGLTimingInfo> {
    const oldActiveTimers = this.activeTimers;
    const newActiveTimers: TimerNode[] = [];

    let outerMostTime = false;
    if (this.programTimersStack == null) {
      this.programTimersStack = newActiveTimers;
      outerMostTime = true;
    } else {
      this.activeTimers.push(newActiveTimers);
    }
    this.activeTimers = newActiveTimers;

    f();

    // needing to split these up because util.flatten only accepts certain types
    const flattenedActiveTimerQueries =
        util.flatten(this.activeTimers.map((d: KernelInfo) => d.query))
            .filter(d => d != null);
    const flattenedActiveTimerNames =
        util.flatten(this.activeTimers.map((d: KernelInfo) => d.name))
            .filter(d => d != null);

    this.activeTimers = oldActiveTimers;

    if (outerMostTime) {
      this.programTimersStack = null;
    }

    const res: WebGLTimingInfo = {
      uploadWaitMs: this.uploadWaitMs,
      downloadWaitMs: this.downloadWaitMs,
      kernelMs: null,
      wallMs: null  // will be filled by the engine
    };

    if (env().getNumber('WEBGL_DISJOINT_QUERY_TIMER_EXTENSION_RELIABLE') > 0) {
      const kernelMs = await Promise.all(flattenedActiveTimerQueries);

      res['kernelMs'] = util.sum(kernelMs);
      res['getExtraProfileInfo'] = () =>
          kernelMs.map((d, i) => ({name: flattenedActiveTimerNames[i], ms: d}))
              .map(d => `${d.name}: ${d.ms}`)
              .join(', ');
    } else {
      res['kernelMs'] = {
        error: 'WebGL query timers are not supported in this environment.'
      };
    }

    this.uploadWaitMs = 0;
    this.downloadWaitMs = 0;
    return res;
  }
  memory(): WebGLMemoryInfo {
    return {
      unreliable: false,
      numBytesInGPU: this.numBytesInGPU,
      numBytesInGPUAllocated: this.textureManager.numBytesAllocated,
      numBytesInGPUFree: this.textureManager.numBytesFree
    } as WebGLMemoryInfo;
  }

  private startTimer(): WebGLQuery|CPUTimerQuery {
    if (env().getNumber('WEBGL_DISJOINT_QUERY_TIMER_EXTENSION_RELIABLE') > 0) {
      return this.gpgpu.beginQuery();
    }
    return {startMs: util.now(), endMs: null};
  }

  private endTimer(query: WebGLQuery|CPUTimerQuery): WebGLQuery|CPUTimerQuery {
    if (env().getNumber('WEBGL_DISJOINT_QUERY_TIMER_EXTENSION_RELIABLE') > 0) {
      this.gpgpu.endQuery();
      return query;
    }
    (query as CPUTimerQuery).endMs = util.now();
    return query;
  }

  private async getQueryTime(query: WebGLQuery|CPUTimerQuery): Promise<number> {
    if (env().getNumber('WEBGL_DISJOINT_QUERY_TIMER_EXTENSION_RELIABLE') > 0) {
      return this.gpgpu.waitForQueryAndGetTime(query as WebGLQuery);
    }
    const timerQuery = query as CPUTimerQuery;
    return timerQuery.endMs - timerQuery.startMs;
  }

  private pendingDeletes = 0;

  disposeData(dataId: DataId): void {
    if (this.pendingDisposal.has(dataId)) {
      return;
    }
    if (this.pendingRead.has(dataId)) {
      this.pendingDisposal.add(dataId);
      this.pendingDeletes++;
      return;
    }
    // No-op if already disposed.
    if (!this.texData.has(dataId)) {
      return;
    }

    // Trying to dispose a textureData that has a 'kept' refCount, e.g. trying
    // to dispose a tensor whose data bucket is shared with a complex tensor. In
    // this case we are removing a reference to the textureData, but we
    // shouldn't actually dispose the texture.
    if (this.texData.get(dataId).complexParentRefCount > 0) {
      this.texData.get(dataId).refCount--;
      return;
    }

    this.releaseGPUData(dataId);
    const {complexTensorInfos} = this.texData.get(dataId);
    if (complexTensorInfos != null) {
      this.texData.get(complexTensorInfos.real.dataId).complexParentRefCount--;
      this.disposeIntermediateTensorInfo(complexTensorInfos.real);

      this.texData.get(complexTensorInfos.imag.dataId).complexParentRefCount--;
      this.disposeIntermediateTensorInfo(complexTensorInfos.imag);
    }
    this.texData.delete(dataId);
  }

  private releaseGPUData(dataId: DataId): void {
    const {texture, dtype, texShape, usage, isPacked, slice} =
        this.texData.get(dataId);
    const key = slice && slice.origDataId || dataId;
    const refCount = this.dataRefCount.get(key);

    if (refCount > 1) {
      this.dataRefCount.set(key, refCount - 1);
    } else {
      this.dataRefCount.delete(key);
      if (texture != null) {
        this.numBytesInGPU -= this.computeBytes(texShape, dtype);
        this.textureManager.releaseTexture(texture, texShape, usage, isPacked);
      }
    }

    const texData = this.texData.get(dataId);
    texData.texture = null;
    texData.texShape = null;
    texData.isPacked = false;
    texData.slice = null;
  }

  getTexture(dataId: DataId): WebGLTexture {
    this.uploadToGPU(dataId);
    return this.texData.get(dataId).texture;
  }

  /**
   * Returns internal information for the specific data bucket. Used in unit
   * tests.
   */
  getDataInfo(dataId: DataId): TextureData {
    return this.texData.get(dataId);
  }

  private getCPUBackend(): KernelBackend|null {
    if (!env().getBool('WEBGL_CPU_FORWARD')) {
      return null;
    }

    if (this.cpuBackend == null) {
      this.cpuBackend = engine().findBackend('cpu');
    }

    return this.cpuBackend;
  }

  /*
  Tests whether all the inputs to an op are small and on the CPU. This heuristic
  determines when it would be faster to execute a kernel on the CPU. WebGL
  kernels opt into running this check and forwarding when appropriate.
  TODO(https://github.com/tensorflow/tfjs/issues/872): Develop a more
  sustainable strategy for optimizing backend execution of ops.
   */
  shouldExecuteOnCPU(
      inputs: TensorInfo[],
      sizeThreshold = CPU_HANDOFF_SIZE_THRESHOLD): boolean {
    const cpuBackend = this.getCPUBackend();
    if (!env().getBool('IS_TEST') && !this.warnedAboutCPUBackend &&
        cpuBackend == null) {
      console.warn(
          'Your application contains ops that are small enough to be ' +
          'executed on the CPU backend, however the CPU backend cannot ' +
          'be found. Consider importing the CPU backend ' +
          '(@tensorflow/tfjs-backend-cpu) for better performance.');

      this.warnedAboutCPUBackend = true;
    }

    return cpuBackend != null &&
        inputs.every(
            input => this.texData.get(input.dataId).texture == null &&
                util.sizeFromShape(input.shape) < sizeThreshold);
  }

  getGPGPUContext(): GPGPUContext {
    return this.gpgpu;
  }

  stridedSlice<T extends Tensor>(
      x: T, begin: number[], end: number[], strides: number[]): T {
    if (this.shouldExecuteOnCPU([x])) {
      const outShape = slice_util.computeOutShape(begin, end, strides);
      if (outShape.some(axis => axis === 0)) {
        return this.makeOutput(outShape, x.dtype, []);
      }

      const xBuf = this.bufferSync(x);
      const outBuf = stridedSliceImplCPU(outShape, xBuf, strides, begin);

      return this.makeOutput(outBuf.shape, outBuf.dtype, outBuf.values);
    }

    const outShape = slice_util.computeOutShape(begin, end, strides);

    if (outShape.some(axis => axis === 0)) {
      return tensor([], outShape) as T;
    }

    const program = new StridedSliceProgram(begin, strides, outShape);
    return this.compileAndRun(program, [x]);
  }

  reverse<T extends Tensor>(x: T, axis: number[]): T {
    const program = env().getBool('WEBGL_PACK_ARRAY_OPERATIONS') ?
        new ReversePackedProgram(x.shape, axis) :
        new ReverseProgram(x.shape, axis);
    return this.compileAndRun(program, [x]);
  }

  neg<T extends Tensor>(x: T): T {
    if (this.shouldExecuteOnCPU([x])) {
      const [outVals, newShape] = negImplCPU(
          this.texData.get(x.dataId).values as TypedArray, x.shape, x.dtype);
      return this.makeOutput(newShape, x.dtype, outVals);
    }

    if (env().getBool('WEBGL_PACK_UNARY_OPERATIONS')) {
      return this.packedUnaryOp(x, unary_op.NEG, x.dtype) as T;
    }
    const program = new UnaryOpProgram(x.shape, unary_op.NEG);
    return this.compileAndRun(program, [x]);
  }

  fusedBatchMatMul(
      {a, b, transposeA, transposeB, bias, activation, preluActivationWeights}:
          backend_util.FusedBatchMatMulConfig): Tensor3D {
    const outerShapeA = transposeA ? a.shape[2] : a.shape[1];
    const outerShapeB = transposeB ? b.shape[1] : b.shape[2];
    const batch = Math.max(a.shape[0], b.shape[0]);

    const dtype = upcastType(a.dtype, b.dtype);

    const hasBias = bias != null;
    const hasPreluActivationWeights = preluActivationWeights != null;
    const fusedActivation =
        activation ? mapActivationToShaderProgram(activation, true) : null;
    const program = new MatMulPackedProgram(
        a.shape, b.shape, [batch, outerShapeA, outerShapeB], transposeA,
        transposeB, hasBias, fusedActivation, hasPreluActivationWeights);
    const inputs: TensorInfo[] = [a, b];
    if (bias) {
      inputs.push(bias);
    }
    if (preluActivationWeights) {
      inputs.push(preluActivationWeights);
    }
    return this.compileAndRun<Tensor3D>(program, inputs, dtype);
  }

  gather<T extends Tensor>(
      x: T, indices: Tensor1D, axis: number, batchDims = 0): T {
    const parsedAxis = util.parseAxisParam(axis, x.shape)[0];
    const shapeInfo = segment_util.collectGatherOpShapeInfo(
        x, indices, parsedAxis, batchDims);

    const flattenX = x.reshape([
      shapeInfo.batchSize, shapeInfo.outerSize, shapeInfo.dimSize,
      shapeInfo.sliceSize
    ]);
    const flattenIndex = indices.reshape(
        [shapeInfo.batchSize, indices.size / shapeInfo.batchSize]);
    const flattenOutputShape = [
      shapeInfo.batchSize, shapeInfo.outerSize,
      indices.size / shapeInfo.batchSize, shapeInfo.sliceSize
    ];

    if (this.shouldExecuteOnCPU([x, indices]) || x.dtype === 'string') {
      const indicesBuf = this.bufferSync(flattenIndex);
      const xBuf = this.bufferSync(flattenX);
      const outBuf = gatherV2ImplCPU(xBuf, indicesBuf, flattenOutputShape);

      return this.makeOutput(
          shapeInfo.outputShape, outBuf.dtype, outBuf.values as TypedArray);
    }

    const program = new GatherProgram(flattenX.shape, flattenOutputShape);
    const res: Tensor = this.compileAndRun(program, [flattenX, flattenIndex]);
    return res.reshape(shapeInfo.outputShape);
  }

  private argReduce(
      x: Tensor2D, reduceType: 'max'|'min',
      bestIndicesA: Tensor2D = null): Tensor2D {
    let batchSize = x.shape[0];
    let inSize = x.shape[1];
    if (bestIndicesA != null) {
      batchSize = bestIndicesA.shape[0];
      inSize = bestIndicesA.shape[1];
    }
    const windowSize = backend_util.computeOptimalWindowSize(inSize);
    const reduceInfo = {
      windowSize,
      inSize,
      batchSize,
      outSize: Math.ceil(inSize / windowSize)
    };
    const program =
        new ArgMinMaxProgram(reduceInfo, reduceType, bestIndicesA == null);
    const inputs = [x];
    if (bestIndicesA != null) {
      inputs.push(bestIndicesA);
    }
    const output = this.compileAndRun<Tensor2D>(program, inputs, 'int32');
    // No need to run another GPGPU program.
    if (output.shape[1] === 1) {
      return output;
    }
    return this.argReduce(x, reduceType, output);
  }

  private argReducePacked(
      x: Tensor, reduceType: 'max'|'min', bestIndicesA: Tensor = null): Tensor {
    const inShape = bestIndicesA != null ? bestIndicesA.shape : x.shape;
    const inSize = inShape[inShape.length - 1];
    const windowSize = backend_util.computeOptimalWindowSize(inSize);
    const program = new ArgMinMaxPackedProgram(
        inShape, windowSize, reduceType, bestIndicesA == null);
    const inputs = bestIndicesA == null ? [x] : [x, bestIndicesA];
    const output = this.compileAndRun<Tensor>(program, inputs, 'int32');
    if (output.rank === x.rank) {
      return this.argReducePacked(x, reduceType, output);
    }
    return output;
  }

  unsortedSegmentSum<T extends Tensor>(
      x: T, segmentIds: Tensor1D, numSegments: number): Tensor {
    let axis = 0;
    const permutation = backend_util.getAxesPermutation([axis], x.rank);
    let permutedX = x;
    if (permutation != null) {
      permutedX = transpose(x, permutation);
      axis = backend_util.getInnerMostAxes(1, x.rank)[0];
    }

    const outShape =
        segment_util.computeOutShape(permutedX.shape, axis, numSegments);
    const inSize = util.sizeFromShape([permutedX.shape[axis]]);
    const a2D = permutedX.as2D(-1, inSize);
    const outputDType = tf.sumOutType(x.dtype);
    let result =
        this.segOpCompute(
                a2D, 'unsortedSegmentSum', segmentIds, outputDType, numSegments)
            .reshape(outShape);
    if (permutation != null) {
      result =
          transpose(result, backend_util.getUndoAxesPermutation(permutation));
    }
    return result;
  }

  private segOpCompute(
      x: Tensor2D, segOpType: 'unsortedSegmentSum', segmentIds: Tensor1D,
      dtype: DataType, numSegments: number): Tensor2D {
    const batchSize = x.shape[0];
    const inSize = x.shape[1];
    const windowSize =
        segment_util.segOpComputeOptimalWindowSize(inSize, numSegments);
    const segOpInfo = {windowSize, inSize, batchSize, numSegments};
    const program = new SegmentOpProgram(segOpInfo, segOpType);
    const output =
        this.compileAndRun<Tensor2D>(program, [x, segmentIds], dtype);
    // No need to run another GPGPU program.
    if (output.shape[1] === numSegments) {
      return output;
    }
    segmentIds = range(0, numSegments).tile([inSize / windowSize]);
    return this.segOpCompute(output, segOpType, segmentIds, dtype, numSegments);
  }

  private argMinMaxReduce(x: Tensor, axis: number, reduceType: 'min'|'max'):
      Tensor {
    const axes = [axis];
    backend_util.assertAxesAreInnerMostDims(
        'arg' + reduceType.charAt(0).toUpperCase() + reduceType.slice(1), axes,
        x.rank);
    if (!env().getBool('WEBGL_PACK_REDUCE') || x.rank <= 2) {
      const [outShape, reduceShape] =
          backend_util.computeOutAndReduceShapes(x.shape, axes);
      const inSize = util.sizeFromShape(reduceShape);
      const a2D = x.as2D(-1, inSize);
      return this.argReduce(a2D, reduceType).reshape(outShape);
    }
    return this.argReducePacked(x, reduceType);
  }

  argMin(x: Tensor, axis: number): Tensor {
    return this.argMinMaxReduce(x, axis, 'min');
  }

  argMax(x: Tensor, axis: number): Tensor {
    return this.argMinMaxReduce(x, axis, 'max');
  }

  select(condition: Tensor, a: Tensor, b: Tensor): Tensor {
    const program = new SelectProgram(condition.rank, a.shape, a.rank);
    return this.compileAndRun(
        program, [condition, a, b], upcastType(a.dtype, b.dtype));
  }

  where(condition: Tensor): Tensor2D {
    backend_util.warn(
        'tf.where() in webgl locks the UI thread. ' +
        'Call tf.whereAsync() instead');
    const condVals = condition.dataSync();
    return whereImpl(condition.shape, condVals);
  }

  topk<T extends Tensor>(x: T, k: number, sorted: boolean): [T, T] {
    const xVals = x.dataSync();
    const [allTopKVals, allTopKIndices] =
        topKImplCPU(xVals, x.shape, x.dtype as NumericDataType, k, sorted);

    return [
      this.makeOutput(allTopKVals.shape, allTopKVals.dtype, allTopKVals.values),
      this.makeOutput(
          allTopKIndices.shape, allTopKIndices.dtype, allTopKIndices.values)
    ];
  }

  private packedUnaryOp(x: TensorInfo, op: string, dtype: DataType) {
    const program = new UnaryOpPackedProgram(x.shape, op);
    return this.compileAndRun<Tensor>(program, [x], dtype);
  }

  // Returns a TensorInfo with the complex shape and the dataId of the
  // underlying part. We need to do this because a reshaped complex tensor is
  // not reflected in its parts.
  private makeComplexComponentTensorInfo(
      complexTensor: Tensor, complexPart: TensorInfo): TensorInfo {
    return {
      dataId: complexPart.dataId,
      dtype: complexPart.dtype,
      shape: complexTensor.shape
    };
  }

  addN<T extends Tensor>(tensors: T[]): T {
    if (tensors.length === 1) {
      return tensors[0];
    }

    // Limit the number of uploaded textures for optimization.
    if (tensors.length > env().get('WEBGL_MAX_TEXTURES_IN_SHADER')) {
      const midIndex = Math.floor(tensors.length / 2);
      const leftSide = this.addN(tensors.slice(0, midIndex));
      const rightSide = this.addN(tensors.slice(midIndex));
      return this.addN([leftSide, rightSide]);
    }

    const dtype =
        tensors.map(t => t.dtype).reduce((d1, d2) => upcastType(d1, d2));
    const shapes = tensors.map(t => t.shape);
    // We can make sure shapes are identical in op level.
    const usePackedOp = env().getBool('WEBGL_PACK');
    const program = usePackedOp ?
        new AddNPackedProgram(tensors[0].shape, shapes) :
        new AddNProgram(tensors[0].shape, shapes);
    return this.compileAndRun<T>(program, tensors, dtype);
  }

  ceil<T extends Tensor>(x: T): T {
    if (this.shouldExecuteOnCPU([x])) {
      const outValues =
          ceilImplCPU(this.texData.get(x.dataId).values as TypedArray, x.dtype);
      return this.makeOutput(x.shape, x.dtype, outValues);
    }

    if (env().getBool('WEBGL_PACK_UNARY_OPERATIONS')) {
      return this.packedUnaryOp(x, unary_op.CEIL, x.dtype) as T;
    }

    const program = new UnaryOpProgram(x.shape, unary_op.CEIL);
    return this.compileAndRun(program, [x]);
  }

  expm1<T extends Tensor>(x: T): T {
    if (this.shouldExecuteOnCPU([x])) {
      const outValues = expm1ImplCPU(
          this.texData.get(x.dataId).values as TypedArray, x.dtype);
      return this.makeOutput(x.shape, x.dtype, outValues);
    }

    if (env().getBool('WEBGL_PACK_UNARY_OPERATIONS')) {
      return this.packedUnaryOp(x, unary_op.EXPM1, x.dtype) as T;
    }

    const program = new UnaryOpProgram(x.shape, unary_op.EXPM1);
    return this.compileAndRun(program, [x]);
  }

  log<T extends Tensor>(x: T): T {
    if (this.shouldExecuteOnCPU([x])) {
      const outValues =
          logImplCPU(this.texData.get(x.dataId).values as TypedArray, x.dtype);
      return this.makeOutput(x.shape, x.dtype, outValues);
    }

    if (env().getBool('WEBGL_PACK_UNARY_OPERATIONS')) {
      return this.packedUnaryOp(x, unary_packed_op.LOG, x.dtype) as T;
    }

    const program = new UnaryOpProgram(x.shape, unary_op.LOG);
    return this.compileAndRun(program, [x]);
  }

  sqrt<T extends Tensor>(x: T): T {
    const program = new UnaryOpProgram(x.shape, unary_op.SQRT);
    return this.compileAndRun(program, [x]);
  }

  rsqrt<T extends Tensor>(x: T): T {
    if (this.shouldExecuteOnCPU([x])) {
      const outValues = rsqrtImplCPU(
          this.texData.get(x.dataId).values as TypedArray, x.dtype);
      return this.makeOutput(x.shape, x.dtype, outValues);
    }
    const program = new UnaryOpProgram(x.shape, unary_op.RSQRT);
    return this.compileAndRun(program, [x]);
  }

  relu<T extends Tensor>(x: T): T {
    let program: UnaryOpProgram|UnaryOpPackedProgram;
    if (env().getBool('WEBGL_PACK')) {
      program = new UnaryOpPackedProgram(x.shape, unary_packed_op.RELU);
    } else {
      program = new UnaryOpProgram(x.shape, unary_op.RELU);
    }
    return this.compileAndRun(program, [x]);
  }

  relu6<T extends Tensor>(x: T): T {
    let program: UnaryOpProgram|UnaryOpPackedProgram;
    if (env().getBool('WEBGL_PACK')) {
      program = new UnaryOpPackedProgram(x.shape, unary_packed_op.RELU6);
    } else {
      program = new UnaryOpProgram(x.shape, unary_op.RELU6);
    }
    return this.compileAndRun(program, [x]);
  }

  elu<T extends Tensor>(x: T): T {
    if (env().getBool('WEBGL_PACK_UNARY_OPERATIONS')) {
      return this.packedUnaryOp(x, unary_packed_op.ELU, x.dtype) as T;
    }
    const program = new UnaryOpProgram(x.shape, unary_op.ELU);
    return this.compileAndRun(program, [x]);
  }

  clip<T extends Tensor>(x: T, min: number, max: number): T {
    let program;
    if (env().getBool('WEBGL_PACK_CLIP')) {
      program = new ClipPackedProgram(x.shape);
    } else {
      program = new ClipProgram(x.shape);
    }
    const customSetup = program.getCustomSetupFunc(min, max);
    return this.compileAndRun(program, [x], null, customSetup);
  }

  abs<T extends Tensor>(x: T): T {
    // TODO: handle cases when x is complex.
    if (this.shouldExecuteOnCPU([x]) && x.dtype !== 'complex64') {
      const outValues =
          simpleAbsImplCPU(this.texData.get(x.dataId).values as TypedArray);
      return this.makeOutput(x.shape, x.dtype, outValues);
    }

    if (env().getBool('WEBGL_PACK_UNARY_OPERATIONS')) {
      return this.packedUnaryOp(x, unary_op.ABS, x.dtype) as T;
    }

    const program = new UnaryOpProgram(x.shape, unary_op.ABS);
    return this.compileAndRun(program, [x]);
  }

  complexAbs<T extends Tensor>(x: T): T {
    const xData = this.texData.get(x.dataId);

    const program = new ComplexAbsProgram(x.shape);
    const inputs = [
      this.makeComplexComponentTensorInfo(x, xData.complexTensorInfos.real),
      this.makeComplexComponentTensorInfo(x, xData.complexTensorInfos.imag),
    ];

    return this.compileAndRun<Tensor>(program, inputs) as T;
  }

  unstack(x: Tensor, axis: number): Tensor[] {
    const num = x.shape[axis];
    const outShape: number[] = new Array(x.rank - 1);
    let outIndex = 0;
    for (let i = 0; i < x.rank; i++) {
      if (i !== axis) {
        outShape[outIndex++] = x.shape[i];
      }
    }

    const begin = new Array(x.rank).fill(0);
    const size = x.shape.slice();
    size[axis] = 1;
    const res = new Array(num);
    for (let i = 0; i < res.length; i++) {
      begin[axis] = i;
      res[i] = x.slice(begin, size).reshape(outShape);
    }
    return res;
  }

  split<T extends Tensor>(x: T, sizeSplits: number[], axis: number): T[] {
    return split(x, sizeSplits, axis);
  }

  makeTensorInfo(
      shape: number[], dtype: DataType,
      values?: BackendValues|string[]): TensorInfo {
    let dataId;
    if (dtype === 'string' && values != null && values.length > 0 &&
        util.isString(values[0])) {
      const encodedValues =
          (values as {} as string[]).map(d => util.encodeString(d));

      dataId = this.write(encodedValues, shape, dtype);
    } else {
      dataId = this.write(values as TypedArray, shape, dtype);
    }

    this.texData.get(dataId).usage = null;
    return {dataId, shape, dtype};
  }

  private makeOutput<T extends Tensor>(
      shape: number[], dtype: DataType, values?: BackendValues): T {
    const {dataId} = this.makeTensorInfo(shape, dtype, values);
    return engine().makeTensorFromDataId(dataId, shape, dtype, this) as T;
  }

  private unpackTensor(input: TensorInfo): TensorInfo {
    const program = new UnpackProgram(input.shape);
    return this.runWebGLProgram(program, [input], input.dtype);
  }

  private packTensor(input: TensorInfo): TensorInfo {
    const program = new PackProgram(input.shape);
    const preventEagerUnpackingOutput = true;
    return this.runWebGLProgram(
        program, [input], input.dtype, null /* customSetup */,
        preventEagerUnpackingOutput);
  }

  private packedReshape(input: TensorInfo, afterShape: number[]): TensorInfo {
    const input3DShape = [
      webgl_util.getBatchDim(input.shape),
      ...webgl_util.getRowsCols(input.shape)
    ] as [number, number, number];
    const input3D: TensorInfo = {
      dtype: input.dtype,
      shape: input3DShape,
      dataId: input.dataId
    };
    const afterShapeAs3D = [
      webgl_util.getBatchDim(afterShape), ...webgl_util.getRowsCols(afterShape)
    ] as [number, number, number];

    const program = new ReshapePackedProgram(afterShapeAs3D, input3DShape);
    const preventEagerUnpackingOfOutput = true;
    const output = this.runWebGLProgram(
        program, [input3D], input.dtype, null /* customSetup */,
        preventEagerUnpackingOfOutput);
    return {dataId: output.dataId, shape: afterShape, dtype: output.dtype};
  }

  private decode(dataId: DataId): TensorInfo {
    const texData = this.texData.get(dataId);
    const {isPacked, shape, dtype} = texData;
    const shapeAs3D =
        webgl_util.getShapeAs3D(shape) as [number, number, number];
    let program;
    if (isPacked) {
      program = new DecodeMatrixPackedProgram(shapeAs3D);
    } else {
      program = new DecodeMatrixProgram(shapeAs3D);
    }
    const preventEagerUnpackingOfOutput = true;
    const out = this.runWebGLProgram(
        program, [{shape: shapeAs3D, dtype, dataId}], dtype,
        null /* customSetup */, preventEagerUnpackingOfOutput);
    return {dtype, shape, dataId: out.dataId};
  }

  runWebGLProgram(
      program: GPGPUProgram, inputs: TensorInfo[], outputDtype: DataType,
      customSetup?: (gpgpu: GPGPUContext, webGLProgram: WebGLProgram) => void,
      preventEagerUnpackingOfOutput = false): TensorInfo {
    const output = this.makeTensorInfo(program.outputShape, outputDtype);
    const outData = this.texData.get(output.dataId);
    if (program.packedOutput) {
      outData.isPacked = true;
    }
    if (program.outPackingScheme === tex_util.PackingScheme.DENSE) {
      const texelShape = tex_util.getDenseTexShape(program.outputShape);
      // For a densely packed output, we explicitly set texShape
      // so it doesn't get assigned later according to our typical packing
      // scheme wherein a single texel can only contain values from adjacent
      // rows/cols.
      outData.texShape = texelShape.map(d => d * 2) as [number, number];
    }
    if (program.outTexUsage != null) {
      outData.usage = program.outTexUsage;
    }
    if (util.sizeFromShape(output.shape) === 0) {
      // Short-circuit the computation since the result is empty (has 0 in its
      // shape).
      outData.values =
          util.getTypedArrayFromDType(output.dtype as 'float32', 0);
      return output;
    }

    const dataToDispose: TensorInfo[] = [];
    const inputsData: TensorData[] = inputs.map(input => {
      if (input.dtype === 'complex64') {
        throw new Error(
            `GPGPUProgram does not support complex64 input. For complex64 ` +
            `dtypes, please separate the program into real and imaginary ` +
            `parts.`);
      }

      let texData = this.texData.get(input.dataId);

      if (texData.texture == null) {
        if (!program.packedInputs &&
            util.sizeFromShape(input.shape) <=
                env().getNumber('WEBGL_SIZE_UPLOAD_UNIFORM')) {
          // Upload small tensors that live on the CPU as uniforms, not as
          // textures. Do this only when the environment supports 32bit floats
          // due to problems when comparing 16bit floats with 32bit floats.
          // TODO(https://github.com/tensorflow/tfjs/issues/821): Make it
          // possible for packed shaders to sample from uniforms.
          return {
            shape: input.shape,
            texData: null,
            isUniform: true,
            uniformValues: texData.values as TypedArray
          };
        }

        // This ensures that if a packed program's inputs have not yet been
        // uploaded to the GPU, they get uploaded as packed right off the bat.
        if (program.packedInputs) {
          texData.isPacked = true;
          texData.shape = input.shape;
        }
      } else if (!!texData.isPacked !== !!program.packedInputs) {
        input = texData.isPacked ? this.unpackTensor(input) :
                                   this.packTensor(input);
        dataToDispose.push(input);
        texData = this.texData.get(input.dataId);
      } else if (
          texData.isPacked &&
          !webgl_util.isReshapeFree(texData.shape, input.shape)) {
        // This is a special case where a texture exists for a tensor
        // but the shapes are incompatible (due to packing constraints) because
        // the tensor did not have a chance to go through the packed reshape
        // shader. This only happens when we reshape the *same* tensor to form
        // *distinct* inputs to an op, e.g. dotting a vector with itself. This
        // case will disappear once packed uploading is the default.

        const savedInput = input;
        const targetShape = input.shape;

        input.shape = texData.shape;
        input = this.packedReshape(input as Tensor, targetShape);
        dataToDispose.push(input);
        texData = this.texData.get(input.dataId);

        savedInput.shape = targetShape;
      }

      this.uploadToGPU(input.dataId);
      return {shape: input.shape, texData, isUniform: false};
    });

    this.uploadToGPU(output.dataId);
    const outputData:
        TensorData = {shape: output.shape, texData: outData, isUniform: false};
    const key = gpgpu_math.makeShaderKey(program, inputsData, outputData);
    const binary = this.getAndSaveBinary(key, () => {
      return gpgpu_math.compileProgram(
          this.gpgpu, program, inputsData, outputData);
    });
    const shouldTimeProgram = this.activeTimers != null;
    let query: WebGLQuery|CPUTimerQuery;
    if (shouldTimeProgram) {
      query = this.startTimer();
    }

    gpgpu_math.runProgram(
        this.gpgpu, binary, inputsData, outputData, customSetup);

    dataToDispose.forEach(info => this.disposeIntermediateTensorInfo(info));

    if (shouldTimeProgram) {
      query = this.endTimer(query);
      this.activeTimers.push(
          {name: program.constructor.name, query: this.getQueryTime(query)});
    }

    if (!env().getBool('WEBGL_LAZILY_UNPACK') && outData.isPacked &&
        preventEagerUnpackingOfOutput === false) {
      const unpacked = this.unpackTensor(output);
      this.disposeIntermediateTensorInfo(output);
      return unpacked;
    }
    return output;
  }

  compileAndRun<K extends TensorInfo>(
      program: GPGPUProgram, inputs: TensorInfo[], outputDtype?: DataType,
      customSetup?: (gpgpu: GPGPUContext, webGLProgram: WebGLProgram) => void,
      preventEagerUnpackingOfOutput = false): K {
    outputDtype = outputDtype || inputs[0].dtype;
    const outInfo = this.runWebGLProgram(
        program, inputs, outputDtype, customSetup,
        preventEagerUnpackingOfOutput);
    return engine().makeTensorFromDataId(
               outInfo.dataId, outInfo.shape, outInfo.dtype) as {} as K;
  }

  private getAndSaveBinary(key: string, getBinary: () => GPGPUBinary):
      GPGPUBinary {
    if (!(key in this.binaryCache)) {
      this.binaryCache[key] = getBinary();
    }
    return this.binaryCache[key];
  }

  getTextureManager(): TextureManager {
    return this.textureManager;
  }

  private disposed = false;

  dispose() {
    if (this.disposed) {
      return;
    }
    // Avoid disposing the compiled webgl programs during unit testing because
    // it slows down test execution.
    if (!env().getBool('IS_TEST')) {
      const allKeys = Object.keys(this.binaryCache);
      allKeys.forEach(key => {
        this.gpgpu.deleteProgram(this.binaryCache[key].webGLProgram);
        delete this.binaryCache[key];
      });
    }
    this.textureManager.dispose();
    if (this.canvas != null &&
        (typeof (HTMLCanvasElement) !== 'undefined' &&
         this.canvas instanceof HTMLCanvasElement)) {
      this.canvas.remove();
    } else {
      this.canvas = null;
    }
    if (this.gpgpuCreatedLocally) {
      this.gpgpu.program = null;
      this.gpgpu.dispose();
    }
    this.disposed = true;
  }

  floatPrecision(): 16|32 {
    if (this.floatPrecisionValue == null) {
      this.floatPrecisionValue = tidy(() => {
        if (!env().get('WEBGL_RENDER_FLOAT32_ENABLED')) {
          // Momentarily switching DEBUG flag to false so we don't throw an
          // error trying to upload a small value.
          const debugFlag = env().getBool('DEBUG');
          env().set('DEBUG', false);
          const underflowCheckValue = this.abs(scalar(1e-8)).dataSync()[0];
          env().set('DEBUG', debugFlag);

          if (underflowCheckValue > 0) {
            return 32;
          }
        }
        return 16;
      });
    }
    return this.floatPrecisionValue;
  }
  /** Returns the smallest representable number.  */
  epsilon(): number {
    return this.floatPrecision() === 32 ? EPSILON_FLOAT32 : EPSILON_FLOAT16;
  }

  uploadToGPU(dataId: DataId): void {
    const texData = this.texData.get(dataId);
    const {shape, dtype, values, texture, usage, isPacked} = texData;

    if (texture != null) {
      // Array is already on GPU. No-op.
      return;
    }
    const shouldTimeProgram = this.activeTimers != null;
    let start: number;
    if (shouldTimeProgram) {
      start = util.now();
    }

    let texShape = texData.texShape;
    if (texShape == null) {
      texShape = webgl_util.getTextureShapeFromLogicalShape(shape, isPacked);
      texData.texShape = texShape;
    }

    if (values != null) {
      const shapeAs3D = webgl_util.getShapeAs3D(shape);

      let program;
      let width = texShape[1], height = texShape[0];
      const isByteArray = values instanceof Uint8Array;

      if (isPacked) {
        [width, height] = tex_util.getPackedMatrixTextureShapeWidthHeight(
            texShape[0], texShape[1]);
        program = new EncodeMatrixPackedProgram(
            shapeAs3D, [height, width], isByteArray);
      } else {
        program =
            new EncodeMatrixProgram(shapeAs3D, [height, width], isByteArray);
      }

      const tempDenseInputHandle = this.makeTensorInfo([height, width], dtype);
      if (isByteArray) {
        this.texData.get(tempDenseInputHandle.dataId).usage =
            TextureUsage.PIXELS;
      } else {
        this.texData.get(tempDenseInputHandle.dataId).usage =
            TextureUsage.UPLOAD;
      }
      this.gpgpu.uploadDenseMatrixToTexture(
          this.getTexture(tempDenseInputHandle.dataId), width, height,
          values as TypedArray);

      // We want the output to remain packed regardless of the value of
      // WEBGL_PACK.
      const preventEagerUnpacking = true;
      const encodedOutputTarget = this.runWebGLProgram(
          program, [tempDenseInputHandle], dtype, null, preventEagerUnpacking);

      // Have the original texture assume the identity of the encoded output.
      const outputTexData = this.texData.get(encodedOutputTarget.dataId);
      texData.texture = outputTexData.texture;
      texData.texShape = outputTexData.texShape;
      texData.isPacked = outputTexData.isPacked;
      texData.usage = outputTexData.usage;

      this.disposeIntermediateTensorInfo(tempDenseInputHandle);
      this.texData.delete(encodedOutputTarget.dataId);

      // Once uploaded, don't store the values on cpu.
      texData.values = null;
      if (shouldTimeProgram) {
        this.uploadWaitMs += util.now() - start;
      }
    } else {
      const newTexture = this.acquireTexture(texShape, usage, dtype, isPacked);
      texData.texture = newTexture;
    }
  }

  private convertAndCacheOnCPU(dataId: DataId, float32Values?: Float32Array):
      TypedArray {
    const texData = this.texData.get(dataId);
    const {dtype} = texData;

    this.releaseGPUData(dataId);

    if (float32Values != null) {
      texData.values = float32ToTypedArray(float32Values, dtype as 'float32');
    }
    return texData.values as TypedArray;
  }

  private acquireTexture(
      texShape: [number, number], texType: TextureUsage, dtype: DataType,
      isPacked: boolean): WebGLTexture {
    this.numBytesInGPU += this.computeBytes(texShape, dtype);
    if (!this.warnedAboutMemory &&
        this.numBytesInGPU > this.numMBBeforeWarning * 1024 * 1024) {
      const mb = (this.numBytesInGPU / 1024 / 1024).toFixed(2);
      this.warnedAboutMemory = true;
      console.warn(
          `High memory usage in GPU: ${mb} MB, ` +
          `most likely due to a memory leak`);
    }
    return this.textureManager.acquireTexture(texShape, texType, isPacked);
  }

  private computeBytes(shape: [number, number], dtype: DataType) {
    return shape[0] * shape[1] * util.bytesPerElement(dtype);
  }
}

function float32ToTypedArray<D extends NumericDataType>(
    a: Float32Array, dtype: D): tf.DataTypeMap[D] {
  if (dtype === 'float32' || dtype === 'complex64') {
    return a as tf.DataTypeMap[D];
  } else if (dtype === 'int32' || dtype === 'bool') {
    const result = (dtype === 'int32') ? new Int32Array(a.length) :
                                         new Uint8Array(a.length);
    for (let i = 0; i < result.length; ++i) {
      result[i] = Math.round(a[i]);
    }
    return result as tf.DataTypeMap[D];
  } else {
    throw new Error(`Unknown dtype ${dtype}`);
  }
}
