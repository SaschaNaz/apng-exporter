"use strict";

namespace APNGExporter.CRC32 {
    "use strict";

    const table = new Uint32Array(256);

    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }

    /**
     *
     * @param {Uint8Array} bytes
     * @param {int} start
     * @param {int} length
     * @return {int}
     */
    export function generate(bytes: Uint8Array, start: number, length: number) {
        start = start || 0;
        length = length || (bytes.length - start);
        let crc = -1;
        for (let i = start, l = start + length; i < l; i++) {
            crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
        }
        return crc ^ (-1);
    }
}

namespace APNGExporter {
    class FrameDrawer {
        private _canvas: HTMLCanvasElement;
        private _context: CanvasRenderingContext2D;
        private _previousFrame: DependentFrame;
        private _previousRevertData: ImageData;

        constructor(width: number, height: number) {
            this._canvas = document.createElement("canvas");
            this._context = this._canvas.getContext("2d");
            this._canvas.width = width;
            this._canvas.height = height;
        }

        async draw(frame: DependentFrame, resultType?: "blob"): Promise<Blob>
        async draw(frame: DependentFrame, resultType: "imagedata"): Promise<ImageData>
        async draw(frame: DependentFrame, resultType?: "imagedata" | "blob"): Promise<ImageData | Blob>
        async draw(frame: DependentFrame, resultType?: "imagedata" | "blob"): Promise<ImageData | Blob> {
            const context = this._context;

            if (this._previousFrame) {
                const previous = this._previousFrame;
                if (previous.disposeOp == 1) {
                    context.clearRect(previous.left, previous.top, previous.width, previous.height);
                }
                else if (previous.disposeOp == 2 && this._previousRevertData) {
                    context.putImageData(this._previousRevertData, previous.left, previous.top);
                }
            }
            this._previousFrame = frame;
            this._previousRevertData = null;
            if (this._previousFrame.disposeOp == 2) {
                this._previousRevertData = context.getImageData(frame.left, frame.top, frame.width, frame.height);
            }
            if (frame.blendOp == 0) {
                context.clearRect(frame.left, frame.top, frame.width, frame.height);
            }
            context.drawImage(await this._toImageElement(frame.blob), frame.left, frame.top);
            if (resultType === "imagedata") {
                return context.getImageData(0, 0, this._canvas.width, this._canvas.height);
            }
            return this._toBlob(this._canvas);
        }

        private async _toBlob(canvas: HTMLCanvasElement) {
            if (canvas.toBlob) {
                return new Promise<Blob>((resolve, reject) => {
                    (canvas as any).toBlob((blob: Blob) => resolve(blob));
                });
            }
            else if (canvas.msToBlob) {
                return canvas.msToBlob();
            }
        }

        private _toImageElement(blob: Blob) {
            return new Promise<HTMLImageElement>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = err => reject(err);
                image.src = URL.createObjectURL(blob, { oneTimeOnly: true });
            });
        }
    }

    // "\x89PNG\x0d\x0a\x1a\x0a"
    const PNG_SIGNATURE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    export interface DependentFrame {
        width: number;
        height: number;
        left: number;
        top: number;
        dataParts: Uint8Array[];
        blob: Blob;

        delay: number;
        disposeOp: number;
        blendOp: number;
    }
    export interface DependentExportResult {
        width: number;
        height: number;
        loopCount: number;
        duration: number;
        frames: DependentFrame[];
    }
    /**
     * @param {ArrayBuffer} buffer
     * @return {Promise}
     */
    export async function getDependent(input: ArrayBuffer | Blob): Promise<DependentExportResult> {
        const buffer = input instanceof Blob ? await toArrayBuffer(input) : input;
        const bytes = new Uint8Array(buffer);

        for (let i = 0; i < PNG_SIGNATURE_BYTES.length; i++) {
            if (PNG_SIGNATURE_BYTES[i] != bytes[i]) {
                throw new Error("Not a PNG file (invalid file signature)");
            }
        }

        // fast animation test
        let isAnimated = false;
        parseChunks(bytes, type => {
            if (type == "acTL") {
                isAnimated = true;
                return false;
            }
            return true;
        });
        if (!isAnimated) {
            throw new Error("Not an animated PNG");
        }


        const preDataParts: Uint8Array[] = [];
        const postDataParts: Uint8Array[] = [];
        let headerDataBytes: Uint8Array = null;
        let width: number;
        let height: number;
        let loopCount: number;
        let duration = 0;

        let frame: DependentFrame = null;
        const frames: DependentFrame[] = [];

        parseChunks(bytes, (type, bytes, off, length) => {
            switch (type) {
                case "IHDR":
                    headerDataBytes = bytes.subarray(off + 8, off + 8 + length);
                    width = readDWord(bytes, off + 8);
                    height = readDWord(bytes, off + 12);
                    break;
                case "acTL":
                    loopCount = readDWord(bytes, off + 8 + 4);
                    break;
                case "fcTL":
                    if (frame) frames.push(frame);
                    frame = {} as DependentFrame;
                    frame.width = readDWord(bytes, off + 8 + 4);
                    frame.height = readDWord(bytes, off + 8 + 8);
                    frame.left = readDWord(bytes, off + 8 + 12);
                    frame.top = readDWord(bytes, off + 8 + 16);
                    const delayN = readWord(bytes, off + 8 + 20);
                    let delayD = readWord(bytes, off + 8 + 22);
                    if (delayD == 0) delayD = 100;
                    frame.delay = 1000 * delayN / delayD;
                    // see http://mxr.mozilla.org/mozilla/source/gfx/src/shared/gfxImageFrame.cpp#343
                    if (frame.delay <= 10) frame.delay = 100;
                    duration += frame.delay;
                    frame.disposeOp = readByte(bytes, off + 8 + 24);
                    frame.blendOp = readByte(bytes, off + 8 + 25);
                    frame.dataParts = [];
                    break;
                case "fdAT":
                    if (frame) frame.dataParts.push(bytes.subarray(off + 8 + 4, off + 8 + length));
                    break;
                case "IDAT":
                    if (frame) frame.dataParts.push(bytes.subarray(off + 8, off + 8 + length));
                    break;
                case "IEND":
                    postDataParts.push(subBuffer(bytes, off, 12 + length));
                    break;
                default:
                    preDataParts.push(subBuffer(bytes, off, 12 + length));
            }
        });

        if (frame) frames.push(frame);

        if (frames.length == 0) {
            throw new Error("Not an animated PNG");
        }

        // creating images
        const preBlob = new Blob(preDataParts);
        const postBlob = new Blob(postDataParts);
        for (let frame of frames) {
            const bb: any[] = [];
            bb.push(PNG_SIGNATURE_BYTES);
            headerDataBytes.set(makeDWordArray(frame.width), 0);
            headerDataBytes.set(makeDWordArray(frame.height), 4);
            bb.push(makeChunkBytes("IHDR", headerDataBytes));
            bb.push(preBlob);
            for (let part of frame.dataParts) {
                bb.push(makeChunkBytes("IDAT", part));
            }
            bb.push(postBlob);
            frame.blob = new Blob(bb, { "type": "image/png" });
            delete frame.dataParts;
        }

        return { width, height, loopCount, duration, frames };
    };

    function toArrayBuffer(blob: Blob) {
        return new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = err => reject(err);
            reader.onload = () => resolve(reader.result);
            reader.readAsArrayBuffer(blob);
        });
    }

    export interface IndependentFrame<T> {
        image: T;
        delay: number;
    }
    export interface IndependentExportResult<T> {
        width: number;
        height: number;
        loopCount: number;
        duration: number;
        frames: IndependentFrame<T>[];
    }

    export async function get(input: ArrayBuffer | Blob, resultType?: "blob"): Promise<IndependentExportResult<Blob>>;
    export async function get(input: ArrayBuffer | Blob, resultType: "imagedata"): Promise<IndependentExportResult<ImageData>>;
    export async function get(input: ArrayBuffer | Blob, resultType?: "imagedata" | "blob"): Promise<IndependentExportResult<ImageData | Blob>>;
    export async function get(input: ArrayBuffer | Blob, resultType?: "imagedata" | "blob"): Promise<IndependentExportResult<ImageData | Blob>> {
        const dependent = await getDependent(input);
        const drawer = new FrameDrawer(dependent.width, dependent.height);

        const frames: IndependentFrame<ImageData | Blob>[] = [];

        for (const frame of dependent.frames) {
            frames.push({
                image: await drawer.draw(frame, resultType),
                delay: frame.delay
            });
        }

        return {
            width: dependent.width,
            height: dependent.height,
            loopCount: dependent.loopCount,
            duration: dependent.duration,
            frames
        };
    }

    /**
     * @param {Uint8Array} bytes
     * @param {function(string, Uint8Array, int, int)} callback
     */
    function parseChunks(bytes: Uint8Array, callback: (type: string, bytes: Uint8Array, offset: number, length: number) => boolean | void) {
        let off = 8;
        let type: string;
        let res: boolean | void;
        do {
            const length = readDWord(bytes, off);
            type = readString(bytes, off + 4, 4);
            res = callback(type, bytes, off, length);
            off += 12 + length;
        } while (res !== false && type != "IEND" && off < bytes.length);
    };

    /**
     * @param {Uint8Array} bytes
     * @param {int} off
     * @return {int}
     */
    function readDWord(bytes: Uint8Array, offset: number) {
        let x = 0;
        // Force the most-significant byte to unsigned.
        x += ((bytes[0 + offset] << 24) >>> 0);
        for (let i = 1; i < 4; i++) x += ((bytes[i + offset] << ((3 - i) * 8)));
        return x;
    };

    /**
     * @param {Uint8Array} bytes
     * @param {int} off
     * @return {int}
     */
    function readWord(bytes: Uint8Array, offset: number) {
        let x = 0;
        for (let i = 0; i < 2; i++) x += (bytes[i + offset] << ((1 - i) * 8));
        return x;
    };

    /**
     * @param {Uint8Array} bytes
     * @param {int} off
     * @return {int}
     */
    function readByte(bytes: Uint8Array, offset: number) {
        return bytes[offset];
    };

    /**
     * @param {Uint8Array} bytes
     * @param {int} start
     * @param {int} length
     * @return {Uint8Array}
     */
    function subBuffer(bytes: Uint8Array, start: number, length: number) {
        const a = new Uint8Array(length);
        a.set(bytes.subarray(start, start + length));
        return a;
    };

    function readString(bytes: Uint8Array, offset: number, length: number) {
        const chars = Array.prototype.slice.call(bytes.subarray(offset, offset + length));
        return String.fromCharCode.apply(String, chars);
    };

    function makeDWordArray(x: number) {
        return [(x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff];
    };
    function makeStringArray(x: string) {
        const res: number[] = [];
        for (let i = 0; i < x.length; i++) res.push(x.charCodeAt(i));
        return res;
    };
    /**
     * @param {string} type
     * @param {Uint8Array} dataBytes
     * @return {Uint8Array}
     */
    function makeChunkBytes(type: string, dataBytes: Uint8Array) {
        const crcLen = type.length + dataBytes.length;
        const bytes = new Uint8Array(new ArrayBuffer(crcLen + 8));
        bytes.set(makeDWordArray(dataBytes.length), 0);
        bytes.set(makeStringArray(type), 4);
        bytes.set(dataBytes, 8);
        const crc = CRC32.generate(bytes, 4, crcLen);
        bytes.set(makeDWordArray(crc), crcLen + 4);
        return bytes;
    };
}