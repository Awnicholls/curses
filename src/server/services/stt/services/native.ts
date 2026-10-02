import { isEmptyValue } from "@/utils";
import { toast } from "react-toastify";
import { STT_State } from "../schema";
import {
  ISTTReceiver,
  ISTTService
} from "../types";

// Errors that won't fix themselves by restarting - stop and tell the user.
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "language-not-supported", "bad-grammar"]);
// Warn the user after this many failed restarts in a row (it keeps retrying).
const WARN_AFTER_FAILED_RESTARTS = 10;
// Recycle a session that has produced nothing for this long. Chromium sessions
// can silently stop delivering results (e.g. after a network blip) without
// firing "end"; restarting during silence loses nothing.
const IDLE_RECYCLE_MS = 120_000;
// Also recycle very long sessions so the results list doesn't grow forever.
const MAX_SESSION_MS = 10 * 60_000;
// Shown when the engine fails over and over without ever recognising anything
// (e.g. macOS WebKit, or Windows with online speech recognition turned off).
const NOT_AVAILABLE_MESSAGE = navigator.userAgent.includes("Mac")
  ? "Native speech recognition isn't available in the app on macOS. Use Whisper (local) or Browser instead."
  : "Native speech recognition couldn't connect. Check that \"Online speech recognition\" is on in Windows Settings > Privacy & security > Speech, or use Whisper (local) / Browser.";

export class STT_NativeService implements ISTTService {
  constructor(private bindings: ISTTReceiver) {}

  #instance?: SpeechRecognition;
  #running = false;
  #started = false;            // onStart reported to the app
  #failedRestarts = 0;
  #restartTimer?: ReturnType<typeof setTimeout>;
  #watchdog?: ReturnType<typeof setInterval>;
  #lastActivity = 0;
  #sessionStart = 0;
  #pendingInterim = "";
  #lastError = "";
  #lang = "";
  #everResult = false;         // the engine has recognised anything at all


  dispose(): void {
    this.stop();
  }

  #processResults = (event: SpeechRecognitionEvent) => {
    this.#everResult = true;
    this.#lastActivity = Date.now();
    this.#failedRestarts = 0;
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      if (result.isFinal) {
        // send each final result once (not concatenated with earlier ones)
        this.#pendingInterim = "";
        this.bindings.onFinal(result[0].transcript);
      } else {
        interim += result[0].transcript;
      }
    }
    if (interim) {
      this.#pendingInterim = interim;
      this.bindings.onInterim(interim);
    }
  };

  async start(state: STT_State) {
    if (Object.values(state.native).some(isEmptyValue))
      return this.bindings.onStop("Options missing");

    const sp = window.webkitSpeechRecognition || window.SpeechRecognition;
    if (!sp)
      return this.bindings.onStop(NOT_AVAILABLE_MESSAGE);

    // ask for the microphone up front: the speech engine doesn't always
    // trigger the permission prompt itself and then just hears nothing
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch (error) {
      return this.bindings.onStop(`Microphone unavailable: ${(error as Error)?.message ?? error}`);
    }

    this.#lang = state.native.language;
    this.#running = true;
    this.#failedRestarts = 0;
    this.#everResult = false;
    this.#spawn();

    this.#watchdog = setInterval(() => this.#checkHealth(), 10_000);
    window.addEventListener("beforeunload", this.#handleUnload);
  }

  stop(error?: string): void {
    if (!this.#running)
      return;
    this.#running = false;
    clearTimeout(this.#restartTimer);
    clearInterval(this.#watchdog);
    window.removeEventListener("beforeunload", this.#handleUnload);
    this.#flushInterim();
    this.#destroyInstance();
    this.bindings.onStop(error);
  }

  #handleUnload = () => this.#destroyInstance();

  // a fresh recognition object per session avoids reusing one Chromium has
  // left in a bad state
  #spawn() {
    if (!this.#running)
      return;
    this.#destroyInstance();

    const sp = window.webkitSpeechRecognition || window.SpeechRecognition;
    const instance = new sp();
    instance.lang = this.#lang;
    instance.continuous = true;
    instance.interimResults = true;

    instance.onstart = () => {
      if (instance !== this.#instance) return;
      this.#sessionStart = this.#lastActivity = Date.now();
      if (!this.#started) {
        this.#started = true;
        this.bindings.onStart();
      }
    };
    instance.onresult = (event) => {
      if (instance === this.#instance) this.#processResults(event);
    };
    instance.onspeechstart = () => {
      if (instance === this.#instance) this.#lastActivity = Date.now();
    };
    instance.onerror = (event) => {
      if (instance !== this.#instance) return; // late event from an old session
      if (FATAL_ERRORS.has(event.error))
        return this.stop(event.error);
      // "no-speech", "aborted", "network", "audio-capture": restart from onend
      this.#lastError = event.error;
      if (event.error !== "no-speech")
        console.warn("[Native STT]", event.error, event.message);
    };
    instance.onend = () => {
      if (instance !== this.#instance) return;
      this.#flushInterim();
      // a session ending after silence is normal; one that errors or dies
      // straight away is a failure and backs off
      const quickDeath = Date.now() - this.#sessionStart < 2000;
      const failed = quickDeath || (this.#lastError !== "" && this.#lastError !== "no-speech");
      this.#scheduleRestart(failed);
    };

    this.#instance = instance;
    this.#lastError = "";
    this.#sessionStart = this.#lastActivity = Date.now();
    try {
      instance.start();
    } catch (error) {
      console.warn("[Native STT] start failed", error);
      this.#scheduleRestart(true);
    }
  }

  #scheduleRestart(failed: boolean) {
    if (!this.#running)
      return;
    clearTimeout(this.#restartTimer);
    this.#failedRestarts = failed ? this.#failedRestarts + 1 : 0;
    // failing from the very start (e.g. WebView2 has no speech service and
    // reports "network") means it will never work here
    if (!this.#everResult && this.#failedRestarts >= 3 && this.#lastError && this.#lastError !== "no-speech")
      return this.stop(NOT_AVAILABLE_MESSAGE);
    if (this.#failedRestarts === WARN_AFTER_FAILED_RESTARTS)
      toast.warn("Speech recognition keeps disconnecting - still retrying. Check your microphone and internet connection.");
    // quick restart normally, back off when it keeps failing
    const delay = this.#failedRestarts <= 1 ? 100 : Math.min(10_000, 500 * 2 ** (this.#failedRestarts - 2));
    this.#restartTimer = setTimeout(() => this.#spawn(), delay);
  }

  #checkHealth() {
    if (!this.#running || !this.#instance || this.#pendingInterim)
      return;
    const now = Date.now();
    if (now - this.#lastActivity > IDLE_RECYCLE_MS || now - this.#sessionStart > MAX_SESSION_MS) {
      // a recycle is not a failure
      this.#failedRestarts = 0;
      this.#spawn();
    }
  }

  // if a session ends mid-sentence the interim text would otherwise be stuck on screen
  #flushInterim() {
    if (this.#pendingInterim) {
      const text = this.#pendingInterim;
      this.#pendingInterim = "";
      this.bindings.onFinal(text);
    }
  }

  #destroyInstance() {
    const instance = this.#instance;
    this.#instance = undefined;
    if (!instance)
      return;
    instance.onstart = instance.onresult = instance.onspeechstart = instance.onerror = instance.onend = null;
    try {
      instance.abort();
    } catch {}
  }
}
