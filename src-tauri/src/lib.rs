use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

const STATE_FILE: &str = "tasks.json";

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录：{error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory.join(STATE_FILE))
}

#[tauri::command]
fn load_app_state(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = state_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }

    let content =
        fs::read_to_string(path).map_err(|error| format!("无法读取任务文件：{error}"))?;
    let tasks =
        serde_json::from_str(&content).map_err(|error| format!("任务文件格式无效：{error}"))?;
    Ok(Some(tasks))
}

#[tauri::command]
fn save_app_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    let path = state_path(&app)?;
    let content = serde_json::to_string_pretty(&state)
        .map_err(|error| format!("无法序列化应用状态：{error}"))?;
    fs::write(path, content).map_err(|error| format!("无法保存应用状态：{error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_app_state, save_app_state])
        .run(tauri::generate_context!())
        .expect("启动 Mori 日程管理器失败");
}
