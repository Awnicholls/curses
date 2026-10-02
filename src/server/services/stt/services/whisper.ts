import { invoke } from "@tauri-apps/api/core";
import { STT_State } from "../schema";
import { ISTTReceiver, ISTTService } from "../types";

// Local Whisper speech-to-text (whisper.cpp running in the Tauri backend),
// English only, with live text.
//
// The microphone is split into phrases with a simple energy-based voice
// activity detector. While a phrase is being spoken, the audio so far is
// re-transcribed every INTERIM_INTERVAL_MS and shown as interim (live) text.
// When the speaker pauses, the whole phrase is transcribed once more and sent
// as the final text.

const TARGET_RATE = 16000;
const PRE_ROLL_MS = 300;          // audio kept from before speech starts
const MIN_SPEECH_MS = 300;        // shorter blips are ignored (reduces hallucinations)
const MAX_PHRASE_MS = 10000;      // long monologues are cut so live updates stay quick
const MIN_THRESHOLD = 0.01;       // RMS floor for "speech"
const PROMPT_CONTEXT_CHARS = 200;
const INTERIM_INTERVAL_MS = 600;  // how often live text is refreshed
const MIN_INTERIM_AUDIO_MS = 800; // don't guess from less audio than this

// Text Whisper is known to invent on near-silent audio.
const HALLUCINATIONS = [
  /^thank(s| you)( so much)? for watching[.!]?$/i,
  /^(please )?subscribe[.!]?$/i,
  /^you\.?$/i,
  /^\.+$/,
  /^[\[(][^\])]*[\])]$/,  // "[BLANK_AUDIO]", "(music)", ...
];

export class STT_WhisperService implements ISTTService {
  constructor(private bindings: ISTTReceiver) {}

  #stream?: MediaStream;
  #context?: AudioContext;
  #source?: MediaStreamAudioSourceNode;
  #processor?: ScriptProcessorNode;
  #running = false;
  #sampleRate = 48000;

  // VAD state
  #preRoll: Float32Array[] = [];
  #phrase: Float32Array[] = [];
  #inSpeech = false;
  #speechMs = 0;
  #silenceMs = 0;
  #phraseMs = 0;
  #noiseFloor = 0.005;

  // phrase bookkeeping for live text
  #phraseId = 0;          // increments when a new phrase starts
  #finalizedId = 0;       // last phrase whose final text was queued
  #lastInterimAt = 0;
  #interimShown = false;  // live text currently on screen for the active phrase
  #lastInterim = "";

  // transcriptions run one at a time, in order (finals are never skipped;
  // live updates are only started when nothing else is waiting)
  #queue: Promise<void> = Promise.resolve();
  #pendingJobs = 0;
  #lastText = "";

  get state() {
    return window.ApiServer.state.services.stt.data.whisper;
  }

  dispose(): void {
    this.stop();
  }

  async start(state: STT_State) {
    const { model } = state.whisper;
    if (!model.trim())
      return this.bindings.onStop("Options missing");

    try {
      const models = await invoke<{ id: string, downloaded: boolean }[]>("plugin:whisper|list_models");
      if (!models.find(m => m.id === model)?.downloaded)
        return this.bindings.onStop("[Whisper] Download the selected model first");
      // load the model now so the first phrase isn't delayed by it
      await invoke("plugin:whisper|load_model", { id: model });
    } catch (error) {
      return this.bindings.onStop(`[Whisper] ${error}`);
    }

    try {
      const device = state.whisper.device;
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: device && device !== "default" ? { deviceId: { exact: device } } : true,
      });
    } catch (error) {
      return this.bindings.onStop(`[Whisper] Microphone unavailable: ${(error as Error)?.message ?? error}`);
    }

    this.#context = new AudioContext();
    this.#sampleRate = this.#context.sampleRate;
    this.#source = this.#context.createMediaStreamSource(this.#stream);
    this.#processor = this.#context.createScriptProcessor(4096, 1, 1);
    this.#processor.onaudioprocess = (e) => this.#process(e.inputBuffer);
    this.#source.connect(this.#processor);
    // ScriptProcessor only runs while connected to the destination; it outputs silence
    this.#processor.connect(this.#context.destination);

    this.#resetVad();
    this.#lastText = "";
    this.#running = true;
    this.bindings.onStart();
  }

  stop(): void {
    this.#shutdown();
  }

  #fail(message: string) {
    if (this.#running)
      this.#shutdown(message);
  }

  #shutdown(error?: string) {
    const wasRunning = this.#running;
    this.#running = false;
    this.#processor?.disconnect();
    this.#source?.disconnect();
    this.#stream?.getTracks().forEach(t => t.stop());
    this.#context?.close().catch(() => {});
    this.#processor = this.#source = this.#stream = this.#context = undefined;
    this.#resetVad();
    if (wasRunning)
      this.bindings.onStop(error);
  }

  #resetVad() {
    this.#preRoll = [];
    this.#phrase = [];
    this.#inSpeech = false;
    this.#speechMs = this.#silenceMs = this.#phraseMs = 0;
  }

  #process(buffer: AudioBuffer) {
    if (!this.#running)
      return;
    const chunk = new Float32Array(buffer.getChannelData(0));
    const chunkMs = (chunk.length / buffer.sampleRate) * 1000;

    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    const threshold = Math.max(MIN_THRESHOLD, this.#noiseFloor * 3);
    const isSpeech = rms > threshold;
    const pauseMs = Math.max(200, Number(this.state.pause) || 700);

    if (!this.#inSpeech) {
      // track background noise while nobody is talking
      this.#noiseFloor = this.#noiseFloor * 0.95 + rms * 0.05;
      this.#preRoll.push(chunk);
      while (this.#preRoll.length > 1 && this.#preRoll.length * chunkMs > PRE_ROLL_MS)
        this.#preRoll.shift();
      if (isSpeech) {
        this.#inSpeech = true;
        this.#phraseId++;
        this.#phrase = [...this.#preRoll];
        this.#preRoll = [];
        this.#phraseMs = this.#phrase.length * chunkMs;
        this.#speechMs = chunkMs;
        this.#silenceMs = 0;
        this.#lastInterimAt = Date.now();
      }
      return;
    }

    this.#phrase.push(chunk);
    this.#phraseMs += chunkMs;
    if (isSpeech) {
      this.#speechMs += chunkMs;
      this.#silenceMs = 0;
    } else {
      this.#silenceMs += chunkMs;
    }

    if (this.#silenceMs >= pauseMs || this.#phraseMs >= MAX_PHRASE_MS) {
      const phrase = this.#phrase;
      const speechMs = this.#speechMs;
      const id = this.#phraseId;
      this.#resetVad();
      this.#finalizedId = id;
      if (speechMs >= MIN_SPEECH_MS)
        this.#enqueueFinal(phrase);
      else
        this.#clearInterim();
      return;
    }

    this.#maybeEnqueueInterim();
  }

  #maybeEnqueueInterim() {
    if (this.#pendingJobs > 0
      || this.#phraseMs < MIN_INTERIM_AUDIO_MS
      || this.#speechMs < MIN_SPEECH_MS
      || Date.now() - this.#lastInterimAt < INTERIM_INTERVAL_MS)
      return;
    this.#lastInterimAt = Date.now();
    const id = this.#phraseId;
    const samples = downsample(concat(this.#phrase), this.#sampleRate, TARGET_RATE);
    this.#run(async () => {
      // the phrase may have finished while this was waiting
      if (id <= this.#finalizedId)
        return;
      const text = await this.#transcribe(samples);
      if (!this.#running || id <= this.#finalizedId || !text || text === this.#lastInterim)
        return;
      this.#interimShown = true;
      this.#lastInterim = text;
      this.bindings.onInterim(text);
    });
  }

  #enqueueFinal(chunks: Float32Array[]) {
    const samples = downsample(concat(chunks), this.#sampleRate, TARGET_RATE);
    this.#run(async () => {
      const text = await this.#transcribe(samples);
      if (!this.#running)
        return;
      if (!text) {
        // nothing usable was said - remove any live text left on screen
        this.#clearInterim();
        return;
      }
      this.#interimShown = false;
      this.#lastInterim = "";
      this.#lastText = text;
      this.bindings.onFinal(text);
    });
  }

  #clearInterim() {
    this.#lastInterim = "";
    if (this.#interimShown) {
      this.#interimShown = false;
      this.bindings.onInterim("");
    }
  }

  #run(job: () => Promise<void>) {
    this.#pendingJobs++;
    this.#queue = this.#queue
      .then(() => this.#running ? job() : undefined)
      .catch(error => console.warn("[Whisper]", error))
      .finally(() => { this.#pendingJobs--; });
  }

  async #transcribe(samples: Float32Array): Promise<string> {
    const { model, prompt } = this.state;
    // previous text helps keep names/spelling consistent between phrases
    const context = [prompt.trim(), this.#lastText.slice(-PROMPT_CONTEXT_CHARS)].filter(Boolean).join(" ");
    const options = { model, prompt: context };

    try {
      const text = (await invoke<string>("plugin:whisper|transcribe", packRequest(options, samples))).trim();
      return HALLUCINATIONS.some(r => r.test(text)) ? "" : text;
    } catch (error) {
      // model load failures won't fix themselves
      this.#fail(`[Whisper] ${error}`);
      return "";
    }
  }
}

// [u32 LE json length][json options][f32 LE samples] - matches the Rust side
function packRequest(options: object, samples: Float32Array) {
  const json = new TextEncoder().encode(JSON.stringify(options));
  const out = new Uint8Array(4 + json.length + samples.length * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, json.length, true);
  out.set(json, 4);
  const offset = 4 + json.length;
  for (let i = 0; i < samples.length; i++)
    view.setFloat32(offset + i * 4, samples[i], true);
  return out;
}

function concat(chunks: Float32Array[]) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// averages samples into the lower rate (cheap low-pass, fine for speech)
function downsample(input: Float32Array, fromRate: number, toRate: number) {
  if (toRate >= fromRate)
    return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}
