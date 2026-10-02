//! Local speech-to-text with whisper.cpp (via whisper-rs).
//!
//! The frontend detects phrases (voice activity) and sends audio as raw
//! 16 kHz mono f32 PCM: repeatedly while a phrase is being spoken (live
//! interim text) and once more when it ends (final text). Models are small
//! English-only ggml files downloaded on demand into the app data directory.

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use tauri::{
    command,
    ipc::{InvokeBody, Request},
    plugin::{Builder, TauriPlugin},
    AppHandle, Emitter, Manager, Runtime, State,
};
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// English-only models light enough for live transcription.
/// (id, label, approximate download size in MB)
const MODELS: &[(&str, &str, u32)] = &[
    ("tiny.en", "Tiny - fastest", 75),
    ("base.en-q5_1", "Base, compressed - fast", 57),
    ("base.en", "Base - recommended", 142),
    ("small.en-q5_1", "Small, compressed - more accurate", 181),
    ("small.en", "Small - most accurate, slower", 466),
];

struct WhisperPlugin(Arc<Inner>);

/// A loaded model plus a reusable inference state. Creating a state allocates
/// large buffers, so it's done once per model rather than per phrase.
struct LoadedModel {
    id: String,
    // keeps the model alive for the state (the state also holds a reference)
    _ctx: Arc<WhisperContext>,
    state: Arc<Mutex<WhisperState>>,
}

struct Inner {
    models_dir: PathBuf,
    /// currently loaded model, kept so it isn't reloaded for every phrase
    loaded: Mutex<Option<LoadedModel>>,
    downloading: Mutex<HashSet<String>>,
}

impl Inner {
    fn model_path(&self, id: &str) -> Result<PathBuf, String> {
        if !MODELS.iter().any(|(m, _, _)| *m == id) {
            return Err(format!("Unknown model \"{id}\""));
        }
        Ok(self.models_dir.join(format!("ggml-{id}.bin")))
    }

    /// Returns the inference state for a model, loading the model if needed.
    fn state(&self, id: &str) -> Result<Arc<Mutex<WhisperState>>, String> {
        let mut loaded = self.loaded.lock().map_err(|e| e.to_string())?;
        if let Some(model) = loaded.as_ref() {
            if model.id == id {
                return Ok(model.state.clone());
            }
        }
        // free the previous model before loading another one
        *loaded = None;

        let path = self.model_path(id)?;
        if !path.exists() {
            return Err("Model is not downloaded".into());
        }
        let mut params = WhisperContextParameters::default();
        // faster attention, noticeably so on CPU
        params.flash_attn(true);
        let ctx = WhisperContext::new_with_params(&path, params)
            .map_err(|e| format!("Failed to load model: {e}"))?;
        let ctx = Arc::new(ctx);
        let state = Arc::new(Mutex::new(ctx.create_state().map_err(|e| e.to_string())?));
        *loaded = Some(LoadedModel { id: id.to_string(), _ctx: ctx, state: state.clone() });
        Ok(state)
    }
}

#[derive(Serialize)]
struct ModelInfo {
    id: String,
    label: String,
    size_mb: u32,
    downloaded: bool,
}

#[command]
fn list_models(state: State<'_, WhisperPlugin>) -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|(id, label, size_mb)| ModelInfo {
            id: id.to_string(),
            label: label.to_string(),
            size_mb: *size_mb,
            downloaded: state.0.models_dir.join(format!("ggml-{id}.bin")).exists(),
        })
        .collect()
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    id: String,
    downloaded: u64,
    total: u64,
}

#[command]
async fn download_model<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, WhisperPlugin>,
    id: String,
) -> Result<(), String> {
    let path = state.0.model_path(&id)?;
    if path.exists() {
        return Ok(());
    }
    if !state.0.downloading.lock().map_err(|e| e.to_string())?.insert(id.clone()) {
        return Err("Already downloading".into());
    }
    let result = download(&app, &id, &path).await;
    state.0.downloading.lock().map_err(|e| e.to_string())?.remove(&id);
    result
}

async fn download<R: Runtime>(app: &AppHandle<R>, id: &str, path: &PathBuf) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
    }
    let url = format!("{MODEL_BASE_URL}/ggml-{id}.bin");
    let mut resp = reqwest::get(&url).await.map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    // download to a temp file so a cancelled download never looks complete
    let tmp = path.with_extension("bin.part");
    let mut file = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download failed: {e}"))? {
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit > 1_000_000 || downloaded == total {
            last_emit = downloaded;
            app.emit("whisper-download", DownloadProgress { id: id.to_string(), downloaded, total }).ok();
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&tmp, path).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn delete_model(state: State<'_, WhisperPlugin>, id: String) -> Result<(), String> {
    let path = state.0.model_path(&id)?;
    if let Ok(mut loaded) = state.0.loaded.lock() {
        if loaded.as_ref().is_some_and(|model| model.id == id) {
            *loaded = None;
        }
    }
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Loads a model ahead of time so the first phrase isn't delayed by it.
#[command]
async fn load_model(state: State<'_, WhisperPlugin>, id: String) -> Result<(), String> {
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || inner.state(&id).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
struct TranscribeOptions {
    model: String,
    #[serde(default)]
    prompt: String,
}

/// Body layout: [u32 LE json length][json options][f32 LE samples, 16 kHz mono]
/// (raw bytes avoid serialising hundreds of thousands of floats as JSON)
fn parse_body(body: &InvokeBody) -> Result<(TranscribeOptions, Vec<f32>), String> {
    let bytes: Vec<u8> = match body {
        InvokeBody::Raw(bytes) => bytes.clone(),
        // fallback IPC sends typed arrays as a JSON number array
        InvokeBody::Json(serde_json::Value::Array(values)) => {
            values.iter().map(|v| v.as_u64().unwrap_or(0) as u8).collect()
        }
        _ => return Err("Invalid request body".into()),
    };
    if bytes.len() < 4 {
        return Err("Invalid request body".into());
    }
    let json_len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let json_end = 4 + json_len;
    if bytes.len() < json_end {
        return Err("Invalid request body".into());
    }
    let options: TranscribeOptions =
        serde_json::from_slice(&bytes[4..json_end]).map_err(|e| e.to_string())?;
    let samples = bytes[json_end..]
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    Ok((options, samples))
}

#[command]
async fn transcribe(request: Request<'_>, state: State<'_, WhisperPlugin>) -> Result<String, String> {
    let (options, samples) = parse_body(request.body())?;
    if samples.is_empty() {
        return Ok(String::new());
    }
    let prompt = options.prompt.replace('\0', "");

    // loading the model and inference are CPU/GPU heavy - keep them off the async runtime
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let state = inner.state(&options.model)?;
        let mut wstate = state.lock().map_err(|e| e.to_string())?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        // roughly the physical core count: hyper-threads don't help whisper
        let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        params.set_n_threads((logical / 2).clamp(2, 8) as i32);
        // Whisper normally always encodes a 30 s window, even for a 2 s phrase.
        // Shrinking the audio context to the phrase length (50 frames per second
        // plus headroom) makes short phrases many times faster.
        let seconds = samples.len() as f32 / 16_000.0;
        params.set_audio_ctx(((seconds * 50.0).ceil() as i32 + 100).clamp(256, 1500));
        params.set_language(Some("en"));
        if !prompt.trim().is_empty() {
            params.set_initial_prompt(&prompt);
        }
        params.set_no_context(true);
        // speed matters for live text: one segment, no timestamps, and no
        // temperature-fallback retries (which can stall for seconds)
        params.set_single_segment(true);
        params.set_no_timestamps(true);
        params.set_temperature_inc(0.0);
        params.set_suppress_blank(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        wstate.full(params, &samples).map_err(|e| format!("Transcription failed: {e}"))?;
        let text: String = wstate
            .as_iter()
            .map(|segment| segment.to_str_lossy().map(|s| s.into_owned()).unwrap_or_default())
            .collect();
        Ok(text.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("whisper")
        .invoke_handler(tauri::generate_handler![list_models, download_model, delete_model, load_model, transcribe])
        .setup(|app, _api| {
            // route whisper.cpp's console output into the (unused) log crate
            whisper_rs::install_logging_hooks();
            let models_dir = app
                .path()
                .app_data_dir()
                .map(|dir| dir.join("whisper-models"))
                .unwrap_or_else(|_| PathBuf::from("whisper-models"));
            app.manage(WhisperPlugin(Arc::new(Inner {
                models_dir,
                loaded: Mutex::new(None),
                downloading: Mutex::new(HashSet::new()),
            })));
            Ok(())
        })
        .build()
}
