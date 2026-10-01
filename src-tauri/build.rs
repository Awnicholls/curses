use tauri_build::{Attributes, DefaultPermissionRule, InlinedPlugin};

// The app's own plugins (src/services) live inside this crate. Tauri 2 requires
// every plugin command to be allowed by a permission, so generate a `default`
// permission for each that allows all of its commands. These are then granted
// in capabilities/default.json.
fn inlined(commands: &'static [&'static str]) -> InlinedPlugin {
    InlinedPlugin::new()
        .commands(commands)
        .default_permission(DefaultPermissionRule::AllowAllCommands)
}

fn main() {
    tauri_build::try_build(
        Attributes::new()
            .plugin("osc", inlined(&["send"]))
            .plugin("web", inlined(&["open_browser", "pubsub_broadcast", "config"]))
            .plugin("audio", inlined(&["play_async"]))
            .plugin("windows-tts", inlined(&["speak", "get_voices"]))
            .plugin("uberduck-tts", inlined(&["speak", "get_voices"]))
            .plugin("keyboard", inlined(&["start_tracking", "stop_tracking"]))
            .plugin("uwu", inlined(&["translate"])),
    )
    .expect("failed to run tauri-build");
}
