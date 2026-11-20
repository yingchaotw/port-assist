use crate::manager::SerialManager;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn win_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn win_toggle_maximize(window: tauri::Window) -> Result<bool, String> {
    let is_max = window.is_maximized().map_err(|e| e.to_string())?;
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
pub fn win_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn win_start_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn detach_tab_window(
    app: AppHandle,
    state: State<'_, Arc<SerialManager>>,
    label: String,
    title: String,
    payload_json: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    {
        let mut map = state.detached_payloads.lock().map_err(|e| e.to_string())?;
        map.insert(label.clone(), payload_json);
    }

    let url = format!("index.html?detached={}", label);
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(url.into()),
    )
    .title(title)
    .inner_size(1020.0, 700.0)
    .min_inner_size(760.0, 500.0);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position((px - 180.0).max(0.0), (py - 16.0).max(0.0));
    }

    eprintln!("[detach] creating window: {}", label);
    if let Err(e) = builder.build() {
        let msg = format!("建立獨立視窗失敗: {}", e);
        eprintln!("{}", msg);
        return Err(msg);
    }
    eprintln!("[detach] window created: {}", label);
    Ok(())
}

#[tauri::command]
pub fn take_detached_session(
    state: State<'_, Arc<SerialManager>>,
    key: String,
) -> Result<Option<String>, String> {
    let mut map = state.detached_payloads.lock().map_err(|e| e.to_string())?;
    Ok(map.remove(&key))
}

#[cfg(target_os = "macos")]
pub fn setup_macos_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::{Emitter, Manager};

    setup_macos_menu_with_lang(app, "zh-Hant")?;

    app.on_menu_event(|app_handle, event| {
        let id = event.id().as_ref();
        let target_win = app_handle
            .webview_windows()
            .into_values()
            .find(|w| w.is_focused().unwrap_or(false))
            .or_else(|| app_handle.get_webview_window("main"));
        if let Some(win) = target_win {
            let _ = win.emit("native-menu-action", id);
        }
    });

    Ok(())
}

#[cfg(target_os = "macos")]
pub fn setup_macos_menu_with_lang(app: &AppHandle, lang: &str) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let en = lang == "en";
    let tr = |zh: &'static str, en_str: &'static str| if en { en_str } else { zh };

    let app_menu = Submenu::with_items(
        app,
        "PortAssist",
        true,
        &[
            &MenuItem::with_id(app, "about", tr("關於 PortAssist", "About PortAssist"), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(tr("隱藏 PortAssist", "Hide PortAssist")))?,
            &PredefinedMenuItem::hide_others(app, Some(tr("隱藏其他", "Hide Others")))?,
            &PredefinedMenuItem::show_all(app, Some(tr("顯示全部", "Show All")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(tr("結束 PortAssist", "Quit PortAssist")))?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        tr("檔案", "File"),
        true,
        &[
            &MenuItem::with_id(app, "new-session", tr("新增串口分頁", "New Tab"), true, Some("CmdOrCtrl+T"))?,
            &MenuItem::with_id(app, "close-session", tr("關閉目前分頁", "Close Tab"), true, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "load-tx", tr("載入檔案至發送區...", "Load File to TX..."), true, None::<&str>)?,
            &MenuItem::with_id(app, "save-rx-bin", tr("匯出接收數據 (Binary/.bin)...", "Export RX Data (.bin)..."), true, None::<&str>)?,
            &MenuItem::with_id(app, "save-rx-txt", tr("匯出接收十六進位報表 (.txt)...", "Export RX Report (.txt)..."), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "clear-all", tr("全部清空 (RX & TX)", "Clear All (RX & TX)"), true, None::<&str>)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        tr("編輯", "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(tr("復原", "Undo")))?,
            &PredefinedMenuItem::redo(app, Some(tr("重做", "Redo")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(tr("剪下", "Cut")))?,
            &PredefinedMenuItem::copy(app, Some(tr("複製", "Copy")))?,
            &PredefinedMenuItem::paste(app, Some(tr("貼上", "Paste")))?,
            &PredefinedMenuItem::select_all(app, Some(tr("全選", "Select All")))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        tr("檢視", "View"),
        true,
        &[
            &MenuItem::with_id(app, "rx-mode-dual", tr("接收區：Hex + ASCII 並排 (經典)", "RX: Hex + ASCII Split"), true, None::<&str>)?,
            &MenuItem::with_id(app, "rx-mode-hex", tr("接收區：僅十六進位 (Hex)", "RX: Hex Only"), true, None::<&str>)?,
            &MenuItem::with_id(app, "rx-mode-text", tr("接收區：純文字模式 (ASCII/UTF-8)", "RX: Plain Text"), true, None::<&str>)?,
            &MenuItem::with_id(app, "rx-mode-packets", tr("接收區：分包日誌 (滾動模式)", "RX: Packet Log"), true, None::<&str>)?,
            &MenuItem::with_id(app, "rx-mode-fixed", tr("接收區：固定行模式 (PCAN-View 覆蓋)", "RX: Fixed Table (PCAN-View)"), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle-packets", tr("切換日誌 / 經典檢視", "Toggle Log / Classic"), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "font-12", tr("字體大小：小 (12px)", "Font Size: Small (12px)"), true, None::<&str>)?,
            &MenuItem::with_id(app, "font-14", tr("字體大小：中 (14px)", "Font Size: Medium (14px)"), true, None::<&str>)?,
            &MenuItem::with_id(app, "font-16", tr("字體大小：大 (16px)", "Font Size: Large (16px)"), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle-theme", tr("切換深色 / 明亮模式", "Toggle Dark / Light Theme"), true, None::<&str>)?,
            &MenuItem::with_id(app, "toggle-lang", tr("切換語言：English / 繁體中文", "Switch Language: 繁體中文 / English"), true, None::<&str>)?,
        ],
    )?;

    let op_menu = Submenu::with_items(
        app,
        tr("操作", "Action"),
        true,
        &[
            &MenuItem::with_id(app, "toggle-port", tr("開啟 / 關閉串口", "Open / Close Connection"), true, None::<&str>)?,
            &MenuItem::with_id(app, "send-now", tr("立即傳送數據", "Send Now"), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "reset-counters", tr("重置 RX/TX 計數器", "Reset RX/TX Counters"), true, None::<&str>)?,
        ],
    )?;

    let win_menu = Submenu::with_items(
        app,
        tr("視窗", "Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(tr("最小化", "Minimize")))?,
            &PredefinedMenuItem::maximize(app, Some(tr("縮放", "Zoom")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(tr("關閉視窗", "Close Window")))?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &op_menu, &win_menu],
    )?;
    app.set_menu(menu)?;

    Ok(())
}

#[tauri::command]
pub fn set_app_language(app: AppHandle, lang: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_clone = app.clone();
        app.run_on_main_thread(move || {
            if let Err(e) = setup_macos_menu_with_lang(&app_clone, &lang) {
                eprintln!("[menu] set_app_language error: {}", e);
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, lang);
    }
    Ok(())
}
