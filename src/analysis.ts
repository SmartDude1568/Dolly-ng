import * as fs from "node:fs";
import * as path from "node:path";

export interface AudioAnalysisResult {
    peakLevel: number;
    peakLevelDb: number;
    rmsLevel: number;
    rmsLevelDb: number;
    meanVolume: number;
    meanVolumeDb: number;
    bpm: number | null;
    duration: number;
    sampleRate: number;
    channels: number;
    bitDepth: number;
}

interface WavHeader {
    sampleRate: number;
    channels: number;
    bitDepth: number;
    dataOffset: number;
    dataSize: number;
}

export class AudioAnalyzer {
    private filePath: string;
    private samples: Float32Array | null = null;
    private header: WavHeader | null = null;

    constructor(filePath: string) {
        this.filePath = path.resolve(filePath);
    }

    async analyze(): Promise<AudioAnalysisResult> {
        await this.loadAudioFile();

        if (!this.samples || !this.header) {
            throw new Error("Failed to load audio file");
        }

        const peakLevel = this.calculatePeakLevel();
        const rmsLevel = this.calculateRmsLevel();
        const meanVolume = this.calculateMeanVolume();
        const bpm = this.detectBpm();
        const duration = this.samples.length / this.header.sampleRate;

        return {
            peakLevel,
            peakLevelDb: this.toDecibels(peakLevel),
            rmsLevel,
            rmsLevelDb: this.toDecibels(rmsLevel),
            meanVolume,
            meanVolumeDb: this.toDecibels(meanVolume),
            bpm,
            duration,
            sampleRate: this.header.sampleRate,
            channels: this.header.channels,
            bitDepth: this.header.bitDepth,
        };
    }

    private async loadAudioFile(): Promise<void> {
        const buffer = await fs.promises.readFile(this.filePath);
        this.header = this.parseWavHeader(buffer);
        this.samples = this.extractSamples(buffer, this.header);
    }

    private parseWavHeader(buffer: Buffer): WavHeader {
        const riff = buffer.toString("ascii", 0, 4);
        if (riff !== "RIFF") {
            throw new Error("Invalid WAV file: missing RIFF header");
        }

        const wave = buffer.toString("ascii", 8, 12);
        if (wave !== "WAVE") {
            throw new Error("Invalid WAV file: missing WAVE format");
        }

        let offset = 12;
        let fmtFound = false;
        let dataOffset = 0;
        let dataSize = 0;
        let sampleRate = 0;
        let channels = 0;
        let bitDepth = 0;

        while (offset < buffer.length - 8) {
            const chunkId = buffer.toString("ascii", offset, offset + 4);
            const chunkSize = buffer.readUInt32LE(offset + 4);

            if (chunkId === "fmt ") {
                const audioFormat = buffer.readUInt16LE(offset + 8);
                if (audioFormat !== 1 && audioFormat !== 3) {
                    throw new Error(
                        "Unsupported audio format: only PCM and IEEE float are supported"
                    );
                }
                channels = buffer.readUInt16LE(offset + 10);
                sampleRate = buffer.readUInt32LE(offset + 12);
                bitDepth = buffer.readUInt16LE(offset + 22);
                fmtFound = true;
            } else if (chunkId === "data") {
                dataOffset = offset + 8;
                dataSize = chunkSize;
                break;
            }

            offset += 8 + chunkSize;
        }

        if (!fmtFound) {
            throw new Error("Invalid WAV file: missing fmt chunk");
        }

        if (dataOffset === 0) {
            throw new Error("Invalid WAV file: missing data chunk");
        }

        return { sampleRate, channels, bitDepth, dataOffset, dataSize };
    }

    private extractSamples(buffer: Buffer, header: WavHeader): Float32Array {
        const { dataOffset, dataSize, bitDepth, channels } = header;
        const bytesPerSample = bitDepth / 8;
        const numSamples = Math.floor(dataSize / bytesPerSample / channels);

        // Convert to mono by averaging channels
        const monoSamples = new Float32Array(numSamples);

        for (let i = 0; i < numSamples; i++) {
            let sum = 0;
            for (let ch = 0; ch < channels; ch++) {
                const sampleOffset = dataOffset + (i * channels + ch) * bytesPerSample;
                sum += this.readSample(buffer, sampleOffset, bitDepth);
            }
            monoSamples[i] = sum / channels;
        }

        return monoSamples;
    }

    private readSample(buffer: Buffer, offset: number, bitDepth: number): number {
        switch (bitDepth) {
            case 8:
                // 8-bit samples are unsigned
                return (buffer.readUInt8(offset) - 128) / 128;
            case 16:
                return buffer.readInt16LE(offset) / 32768;
            case 24:
                // Read 24-bit as 3 bytes, convert to signed
                const b0 = buffer.readUInt8(offset);
                const b1 = buffer.readUInt8(offset + 1);
                const b2 = buffer.readInt8(offset + 2);
                return ((b2 << 16) | (b1 << 8) | b0) / 8388608;
            case 32:
                // Could be int32 or float32, assuming float32 for simplicity
                return buffer.readFloatLE(offset);
            default:
                throw new Error(`Unsupported bit depth: ${bitDepth}`);
        }
    }

    private calculatePeakLevel(): number {
        if (!this.samples) return 0;

        let peak = 0;
        for (const sample of this.samples) {
            const abs = Math.abs(sample);
            if (abs > peak) {
                peak = abs;
            }
        }
        return peak;
    }

    private calculateRmsLevel(): number {
        if (!this.samples) return 0;

        let sumSquares = 0;
        for (const sample of this.samples) {
            sumSquares += sample * sample;
        }
        return Math.sqrt(sumSquares / this.samples.length);
    }

    private calculateMeanVolume(): number {
        if (!this.samples) return 0;

        let sum = 0;
        for (const sample of this.samples) {
            sum += Math.abs(sample);
        }
        return sum / this.samples.length;
    }

    private detectBpm(): number | null {
        if (!this.samples || !this.header) return null;

        const sampleRate = this.header.sampleRate;

        // Use onset detection with energy-based approach
        const windowSize = Math.floor(sampleRate * 0.01); // 10ms windows
        const hopSize = Math.floor(windowSize / 2);
        const numWindows = Math.floor((this.samples.length - windowSize) / hopSize);

        if (numWindows < 10) return null;

        // Calculate energy for each window
        const energies = new Float32Array(numWindows);
        for (let i = 0; i < numWindows; i++) {
            let energy = 0;
            const start = i * hopSize;
            for (let j = 0; j < windowSize; j++) {
                const sample = this.samples[start + j]!;
                energy += sample * sample;
            }
            energies[i] = energy;
        }

        // Calculate onset detection function (spectral flux approximation)
        const onsets = new Float32Array(numWindows - 1);
        for (let i = 1; i < numWindows; i++) {
            onsets[i - 1] = Math.max(0, energies[i]! - energies[i - 1]!);
        }

        // Normalize onsets
        const maxOnset = Math.max(...onsets);
        if (maxOnset === 0) return null;
        for (let i = 0; i < onsets.length; i++) {
            onsets[i]! /= maxOnset;
        }

        // Use autocorrelation to find periodicity
        const minBpm = 60;
        const maxBpm = 200;
        const windowsPerSecond = sampleRate / hopSize;
        const minLag = Math.floor((60 / maxBpm) * windowsPerSecond);
        const maxLag = Math.floor((60 / minBpm) * windowsPerSecond);

        let bestLag = minLag;
        let bestCorrelation = -Infinity;

        for (let lag = minLag; lag <= maxLag && lag < onsets.length / 2; lag++) {
            let correlation = 0;
            let count = 0;
            for (let i = 0; i < onsets.length - lag; i++) {
                correlation += onsets[i]! * onsets[i + lag]!;
                count++;
            }
            correlation /= count;

            if (correlation > bestCorrelation) {
                bestCorrelation = correlation;
                bestLag = lag;
            }
        }

        // Convert lag to BPM
        const secondsPerBeat = bestLag / windowsPerSecond;
        const bpm = 60 / secondsPerBeat;

        // Round to nearest integer
        return Math.round(bpm);
    }

    private toDecibels(level: number): number {
        if (level <= 0) return -Infinity;
        return 20 * Math.log10(level);
    }
}
