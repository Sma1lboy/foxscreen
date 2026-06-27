// cuttio Tauri shell. The heavy lifting (file IO, dialogs, platform) is done in
// the renderer via the official Tauri plugins (fs/dialog/os/shell) through the
// electronApi compatibility shim. This keeps the migration thin: this crate just
// registers plugins + a couple of helper commands.

mod pty;

/// Electron-style platform string ("darwin" | "win32" | "linux" | other) so the
/// shim's `getPlatform()` is a drop-in for `process.platform`.
#[tauri::command]
fn get_platform() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".to_string(),
        "windows" => "win32".to_string(),
        other => other.to_string(),
    }
}

/// Base URL for bundled caption-model assets. Empty in dev (the captioning code
/// then loads from the remote CDN); wired to the resource dir for packaged apps.
#[tauri::command]
fn get_asset_base_url() -> String {
    String::new()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::default())
        .invoke_handler(tauri::generate_handler![
            get_platform,
            get_asset_base_url,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running foxscreen");
}
