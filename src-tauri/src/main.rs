#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::Parser;
use serde::{Deserialize, Serialize};
use tauri::{command, Manager, State};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[cfg(windows)]
use windows::{
    core::PCSTR,
    s,
    Win32::UI::WindowsAndMessaging::{MessageBoxA, MB_ICONWARNING, MB_OK},
};

use crate::services::AppConfiguration;

mod services;

#[derive(Parser, Debug)]
struct InitArguments {
    #[arg(short, long, default_value_t = 3030)]
    port: u16,
}

#[derive(Serialize, Deserialize)]
struct NativeFeatures {
    background_input: bool,
}

#[command]
fn get_native_features() -> NativeFeatures {
    NativeFeatures {
        background_input: cfg!(all(windows, feature = "background_input"))
    }
}

#[command]
fn get_port(state: State<'_, InitArguments>) -> u16 {
    state.port
}

#[command]
fn app_close(app_handle: tauri::AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return app_handle.exit(0);
    };
    app_handle.save_window_state(StateFlags::all()).ok(); // don't really care if it saves it

    if let Err(_) = window.close() {
        return app_handle.exit(0);
    }
}

#[cfg(windows)]
fn show_port_error(port: u16) {
    // null-terminated, MessageBoxA expects a C string
    let msg = format!("Port {} is not available!\0", port);
    unsafe {
        MessageBoxA(
            None,
            PCSTR(msg.as_ptr()),
            s!("Curses error"),
            MB_OK | MB_ICONWARNING,
        );
    }
}

#[cfg(not(windows))]
fn show_port_error(port: u16) {
    eprintln!("Curses error: port {} is not available!", port);
}

fn main() {
    let args = InitArguments::parse();

    // crash if port is not available
    let port_availability = std::net::TcpListener::bind(format!("0.0.0.0:{}", args.port));
    match port_availability {
        Ok(l) => l.set_nonblocking(true).unwrap(),
        Err(_err) => {
            show_port_error(args.port);
            return;
        }
    };

    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // undecorated windows have no shadow by default on some platforms
                window.set_shadow(true).ok();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_port, get_native_features, app_close])
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppConfiguration { port: args.port })
        .plugin(services::osc::init())
        .plugin(services::web::init())
        .plugin(services::audio::init())
        .plugin(services::windows_tts::init())
        .plugin(services::uberduck_tts::init())
        .plugin(services::keyboard::init())
        .plugin(services::uwu::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
