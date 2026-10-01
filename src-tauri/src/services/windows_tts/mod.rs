// Windows TTS uses the SAPI COM interfaces, so the real implementation only
// exists on Windows. Other platforms get a stub plugin with the same commands
// that returns a clear error, so the frontend keeps working.

#[cfg(windows)]
mod intf;
#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::init;

#[cfg(not(windows))]
mod stub {
    use tauri::{
        command,
        plugin::{Builder, TauriPlugin},
        Runtime,
    };

    const UNSUPPORTED: &str = "Windows TTS is only available on Windows";

    #[command]
    fn get_voices() -> Result<(), &'static str> {
        Err(UNSUPPORTED)
    }

    #[command]
    fn speak() -> Result<(), &'static str> {
        Err(UNSUPPORTED)
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("windows-tts")
            .invoke_handler(tauri::generate_handler![speak, get_voices])
            .build()
    }
}
#[cfg(not(windows))]
pub use stub::init;
