// Interactive PTY backend for the in-editor terminal (xterm.js front end).
//
// Spawns a real pseudo-terminal via `portable-pty`, streams its output to the
// renderer over the `pty://output` event, and accepts keystrokes / resizes /
// kills through the commands below. Used by the "terminal" tab in the settings
// panel to run an interactive `claude` session in an isolated working dir.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager(Mutex<HashMap<String, PtySession>>);

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct PtyExit {
    id: String,
}

#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
    cwd: String,
    command: Vec<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = if command.is_empty() {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let mut c = CommandBuilder::new(shell);
        c.arg("-l");
        c
    } else {
        let mut c = CommandBuilder::new(&command[0]);
        for a in &command[1..] {
            c.arg(a);
        }
        c
    };

    let workdir = if cwd.is_empty() {
        let d = std::env::temp_dir().join("foxscreen-claude-sandbox");
        let _ = std::fs::create_dir_all(&d);
        d.to_string_lossy().to_string()
    } else {
        cwd
    };
    cmd.cwd(workdir);
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let (app2, id2) = (app.clone(), id.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app2.emit(
                        "pty://output",
                        PtyOutput {
                            id: id2.clone(),
                            data: String::from_utf8_lossy(&buf[..n]).to_string(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app2.emit("pty://exit", PtyExit { id: id2.clone() });
    });

    manager.0.lock().unwrap().insert(
        id,
        PtySession {
            writer,
            master: pair.master,
            child,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    if let Some(s) = manager.0.lock().unwrap().get_mut(&id) {
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if let Some(s) = manager.0.lock().unwrap().get(&id) {
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    if let Some(mut s) = manager.0.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}
