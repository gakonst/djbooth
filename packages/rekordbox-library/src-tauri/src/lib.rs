use std::sync::Mutex;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;

#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{ShellExt, process::CommandEvent};

#[derive(Default)]
struct BackendProcess(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess::default())
        .setup(|app| {
            #[cfg(debug_assertions)]
            create_main_window(app.handle(), "http://127.0.0.1:4179/")?;

            #[cfg(not(debug_assertions))]
            start_packaged_backend(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Rekordbox Library desktop application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit)
                && let Ok(mut backend) = app.state::<BackendProcess>().0.lock()
                && let Some(child) = backend.take()
            {
                let _ = child.kill();
            }
        });
}

fn create_main_window(app: &tauri::AppHandle, url: &str) -> Result<(), Box<dyn std::error::Error>> {
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
        .title("Rekordbox Library")
        .inner_size(1440.0, 920.0)
        .min_inner_size(1180.0, 700.0)
        .build()?;
    Ok(())
}

#[cfg(not(debug_assertions))]
fn start_packaged_backend(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?;
    let backend = resources.join("backend");
    let script = backend.join("dist/desktop-sidecar.js");
    let static_directory = backend.join("dist/client");
    let analyzer = resources.join("tools/rekordbox-analyzer");
    let uv = resources.join("tools/uv");
    let (mut events, child) = app
        .shell()
        .sidecar("rekordbox-library-node")?
        .args([
            script.to_string_lossy().as_ref(),
            "--static-directory",
            static_directory.to_string_lossy().as_ref(),
        ])
        .env("REKORDBOX_CLEAN_ANALYZER_BINARY", analyzer)
        .env("REKORDBOX_STEMS_UV_BINARY", uv)
        .spawn()?;
    *app.state::<BackendProcess>()
        .0
        .lock()
        .map_err(|_| "backend process lock poisoned")? = Some(child);

    let url = tauri::async_runtime::block_on(async {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                        if value.get("type").and_then(serde_json::Value::as_str) == Some("ready") {
                            if let Some(url) = value.get("url").and_then(serde_json::Value::as_str)
                            {
                                return Ok::<String, String>(url.to_owned());
                            }
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => eprint!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Error(error) => return Err(error),
                CommandEvent::Terminated(status) => {
                    return Err(format!("library backend exited before startup: {status:?}"));
                }
                _ => {}
            }
        }
        Err("library backend closed before reporting readiness".to_owned())
    })?;
    create_main_window(app.handle(), &url)?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if let CommandEvent::Stderr(bytes) = event {
                eprint!("{}", String::from_utf8_lossy(&bytes));
            }
        }
    });
    Ok(())
}
