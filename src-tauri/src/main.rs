// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api_server;
mod main_helpers;
mod manager;
mod net;
mod pcan;
mod serial;
mod window;

use manager::{EventSink, SerialManager, TransportEvent};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

struct TauriEventSink(AppHandle);

impl EventSink for TauriEventSink {
    fn emit(&self, event: TransportEvent) {
        match event {
            TransportEvent::RxBatch(dto) => {
                let _ = self.0.emit("serial-rx-batch", dto);
            }
            TransportEvent::CanRxBatch(dto) => {
                let _ = self.0.emit("pcan-rx-batch", dto);
            }
            TransportEvent::ModemStatus(dto) => {
                let _ = self.0.emit("serial-modem-status", dto);
            }
            TransportEvent::NetServerStatus {
                session_id,
                client_count,
                msg,
            } => {
                let _ = self.0.emit(
                    "net-server-status",
                    serde_json::json!({
                        "sessionId": session_id,
                        "clientCount": client_count,
                        "msg": msg,
                    }),
                );
            }
            TransportEvent::Error(dto) => {
                let _ = self.0.emit("serial-error", dto);
            }
            TransportEvent::McpSessionOpened {
                session_id,
                port_name,
                conn_type,
                baud_rate,
            } => {
                let _ = self.0.emit(
                    "mcp-session-opened",
                    serde_json::json!({
                        "sessionId": session_id,
                        "portName": port_name,
                        "connType": conn_type,
                        "baudRate": baud_rate,
                    }),
                );
            }
            TransportEvent::McpSessionClosed { session_id } => {
                let _ = self.0.emit(
                    "mcp-session-closed",
                    serde_json::json!({
                        "sessionId": session_id,
                    }),
                );
            }
            TransportEvent::ExternalTx { session_id, data } => {
                let _ = self.0.emit(
                    "external-tx",
                    serde_json::json!({
                        "sessionId": session_id,
                        "data": data,
                    }),
                );
            }
            TransportEvent::ExternalPcanTx {
                session_id,
                id,
                extended,
                rtr,
                dlc,
                data,
            } => {
                let _ = self.0.emit(
                    "external-pcan-tx",
                    serde_json::json!({
                        "sessionId": session_id,
                        "frame": {
                            "id": id,
                            "extended": extended,
                            "rtr": rtr,
                            "dlc": dlc,
                            "data": data,
                        }
                    }),
                );
            }
        }
    }
}

fn main() {
    let data_dir = std::env::current_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(".webview2-data");
    let _ = std::fs::create_dir_all(&data_dir);
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &data_dir);
    }
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--no-sandbox");
    }

    let serial_manager = Arc::new(SerialManager::default());

    tauri::Builder::default()
        .manage(Arc::clone(&serial_manager))
        .setup(move |app| {
            let sink: Arc<dyn EventSink> = Arc::new(TauriEventSink(app.handle().clone()));
            app.manage(Arc::clone(&sink));

            let server_running = Arc::new(AtomicBool::new(true));
            api_server::start_api_server(
                Arc::clone(&serial_manager),
                Arc::clone(&sink),
                server_running,
            );

            #[cfg(target_os = "macos")]
            let _ = window::setup_macos_menu(app.handle());

            let mut builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("PortAssist - RS232/422/485 + TCP/UDP + PCAN Debugger")
            .inner_size(1080.0, 740.0)
            .min_inner_size(820.0, 540.0)
            .data_directory(data_dir.clone())
            .additional_browser_args("--no-sandbox");

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

            let _ = builder.build();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            serial::list_serial_ports,
            serial::open_serial_port,
            serial::set_control_lines,
            net::open_network_socket,
            net::set_udp_target,
            manager::close_serial_port,
            manager::write_serial_bytes,
            pcan::list_pcan_channels,
            pcan::open_pcan_channel,
            pcan::write_pcan_frame,
            window::win_minimize,
            window::win_toggle_maximize,
            window::win_close,
            window::win_start_drag,
            window::detach_tab_window,
            window::take_detached_session,
            window::set_app_language,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PortAssist application");
}
