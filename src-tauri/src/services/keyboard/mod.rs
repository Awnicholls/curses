// Background keyboard input relies on a Win32 low-level keyboard hook, so it
// only exists on Windows. Other platforms register an empty plugin.

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::init;

#[cfg(not(windows))]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("keyboard").build()
}
