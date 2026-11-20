// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api_server;
mod main_helpers;
mod pcan;

use pcan::{
    baud_to_btr0btr1, format_pcan_error, parse_channel_handle, CanRxBatchEventDto, CanRxFrameDto,
    PcanConfigDto, PcanLib, PcanTxFrameDto, TPCANMsg, PCAN_CHANNEL_AVAILABLE,
    PCAN_CHANNEL_OCCUPIED, PCAN_CHANNEL_PCANVIEW, PCAN_ERROR_OK, PCAN_MESSAGE_EXTENDED, PCAN_MESSAGE_RTR,
    PCAN_MESSAGE_STANDARD, PCAN_MESSAGE_STATUS, PCAN_USB_CHANNELS,
};
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Serialize, Clone)]
pub struct PortInfoDto {
    pub name: String,
    pub label: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfigDto {
    pub port_name: String,
    pub baud_rate: u32,
    pub parity: String,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub flow_control: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RxChunkDto {
    pub perf_ms: f64,
    pub data: Vec<u8>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialRxBatchEventDto {
    pub session_id: String,
    pub batch_now_ms: f64,
    pub chunks: Vec<RxChunkDto>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModemStatusEventDto {
    pub session_id: String,
    pub cts: bool,
    pub dsr: bool,
    pub cd: bool,
    pub ri: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialErrorEventDto {
    pub session_id: String,
    pub error: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetConfigDto {
    pub conn_type: String, // "tcp_client", "tcp_server", "udp"
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    pub local_host: Option<String>,
    pub local_port: Option<u16>,
}

pub enum ActivePort {
    Physical(Box<dyn SerialPort>),
    Loopback,
    TcpClient(Arc<Mutex<TcpStream>>),
    TcpServer(Arc<Mutex<Vec<Arc<Mutex<TcpStream>>>>>),
    Udp {
        socket: Arc<UdpSocket>,
        target: Arc<Mutex<Option<SocketAddr>>>,
    },
    Pcan {
        lib: Arc<PcanLib>,
        channel: u16,
    },
}

pub struct PortSession {
    pub port_name: String,
    pub active_port: Arc<Mutex<ActivePort>>,
    pub running: Arc<AtomicBool>,
    pub epoch: Instant,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RxRecord {
    pub time_ms: f64,
    pub session_id: String,
    pub kind: String, // "serial", "pcan", "net"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extended: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rtr: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dlc: Option<u8>,
    pub data: Vec<u8>,
    pub data_hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

pub fn push_rx_record(history: &Arc<Mutex<VecDeque<RxRecord>>>, record: RxRecord) {
    if let Ok(mut guard) = history.lock() {
        if guard.len() >= 2048 {
            guard.pop_front();
        }
        guard.push_back(record);
    }
}

pub struct SerialManager {
    pub sessions: Mutex<HashMap<String, PortSession>>,
    pub detached_payloads: Mutex<HashMap<String, String>>,
    pub rx_history: Arc<Mutex<VecDeque<RxRecord>>>,
}

impl Default for SerialManager {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            detached_payloads: Mutex::new(HashMap::new()),
            rx_history: Arc::new(Mutex::new(VecDeque::with_capacity(2048))),
        }
    }
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<PortInfoDto>, String> {
    list_serial_ports_internal()
}

pub fn list_serial_ports_internal() -> Result<Vec<PortInfoDto>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    let mut list = Vec::with_capacity(ports.len());

    for p in ports {
        let detail = match p.port_type {
            SerialPortType::UsbPort(info) => {
                let prod = info.product.unwrap_or_else(|| "USB Serial".to_string());
                format!("{} ({})", p.port_name, prod)
            }
            SerialPortType::PciPort => format!("{} (PCI Serial)", p.port_name),
            SerialPortType::BluetoothPort => format!("{} (Bluetooth)", p.port_name),
            SerialPortType::Unknown => p.port_name.clone(),
        };
        list.push(PortInfoDto {
            name: p.port_name,
            label: detail,
        });
    }

    Ok(list)
}

pub fn close_session_internal(state: &SerialManager, session_id: &str) {
    if let Ok(mut map) = state.sessions.lock() {
        if let Some(session) = map.remove(session_id) {
            session.running.store(false, Ordering::SeqCst);
            if let Ok(guard) = session.active_port.lock() {
                if let ActivePort::Pcan { ref lib, channel } = *guard {
                    let _ = lib.uninitialize(channel);
                }
            }
        }
    }
}

#[tauri::command]
fn open_serial_port(
    app: AppHandle,
    state: State<'_, SerialManager>,
    session_id: String,
    config: SerialConfigDto,
) -> Result<(), String> {
    open_serial_port_internal(&app, &state, session_id, config)
}

pub fn open_serial_port_internal(
    app: &AppHandle,
    state: &SerialManager,
    session_id: String,
    config: SerialConfigDto,
) -> Result<(), String> {
    close_session_internal(state, &session_id);

    if config.port_name != "LOOPBACK" {
        let map = state.sessions.lock().map_err(|e| e.to_string())?;
        for (other_id, sess) in map.iter() {
            if other_id != &session_id && sess.port_name.eq_ignore_ascii_case(&config.port_name) {
                return Err(format!(
                    "串口 {} 已經在其他分頁中開啟，請先關閉該分頁的連線或選擇其他串口。",
                    config.port_name
                ));
            }
        }
    }

    let epoch = Instant::now();

    if config.port_name == "LOOPBACK" {
        let running = Arc::new(AtomicBool::new(true));
        let session = PortSession {
            port_name: config.port_name.clone(),
            active_port: Arc::new(Mutex::new(ActivePort::Loopback)),
            running,
            epoch,
        };
        {
            let mut map = state.sessions.lock().map_err(|e| e.to_string())?;
            map.insert(session_id.clone(), session);
        }
        let _ = app.emit(
            "serial-modem-status",
            ModemStatusEventDto {
                session_id,
                cts: true,
                dsr: true,
                cd: false,
                ri: false,
            },
        );
        return Ok(());
    }

    let parity = match config.parity.as_str() {
        "Odd" => Parity::Odd,
        "Even" => Parity::Even,
        _ => Parity::None,
    };

    let data_bits = match config.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    };

    let stop_bits = match config.stop_bits {
        2 => StopBits::Two,
        _ => StopBits::One,
    };

    let flow_control = match config.flow_control.as_str() {
        "Software" => FlowControl::Software,
        "Hardware" => FlowControl::Hardware,
        _ => FlowControl::None,
    };

    let mut port = serialport::new(&config.port_name, config.baud_rate)
        .parity(parity)
        .data_bits(data_bits)
        .stop_bits(stop_bits)
        .flow_control(flow_control)
        .timeout(Duration::from_millis(1))
        .open()
        .map_err(|e| format!("無法開啟 {}: {}", config.port_name, e))?;

    let _ = port.write_data_terminal_ready(true);
    let _ = port.write_request_to_send(true);

    // Clone a dedicated handle for the reader thread so reading is 100% lock-free!
    let reader_port = port.try_clone().ok();

    let active_port = Arc::new(Mutex::new(ActivePort::Physical(port)));
    let running = Arc::new(AtomicBool::new(true));

    {
        let mut map = state.sessions.lock().map_err(|e| e.to_string())?;
        map.insert(
            session_id.clone(),
            PortSession {
                port_name: config.port_name.clone(),
                active_port: Arc::clone(&active_port),
                running: Arc::clone(&running),
                epoch,
            },
        );
    }

    let app_handle = app.clone();
    let sid = session_id.clone();
    let rx_history_clone = Arc::clone(&state.rx_history);

    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut batch: Vec<RxChunkDto> = Vec::with_capacity(32);
        let mut batch_bytes: usize = 0;
        let mut last_emit = Instant::now() - Duration::from_millis(10);
        let mut last_modem_poll = Instant::now();
        let mut dedicated_reader = reader_port;

        while running.load(Ordering::Relaxed) {
            let mut read_count = 0usize;

            if let Some(ref mut rp) = dedicated_reader {
                // Non-blocking drain of all currently available bytes, or wake up on the very 1st byte!
                // On Windows, `rp.read(&mut buf[..8192])` with ReadIntervalTimeout=0 waits for all 8192 bytes or timeout.
                // Reading `avail` (or `..1` when empty, then draining `extra`) returns in <1us the instant any byte arrives!
                let avail = rp.bytes_to_read().unwrap_or(0) as usize;
                if avail > 0 {
                    let to_read = avail.min(buf.len());
                    if let Ok(n) = rp.read(&mut buf[..to_read]) {
                        read_count = n;
                    }
                } else {
                    match rp.read(&mut buf[..1]) {
                        Ok(1) => {
                            read_count = 1;
                            let extra = rp.bytes_to_read().unwrap_or(0) as usize;
                            if extra > 0 {
                                 let max_extra = extra.min(buf.len() - 1);
                                if let Ok(n2) = rp.read(&mut buf[1..1 + max_extra]) {
                                    read_count += n2;
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(e) => {
                            let _ = app_handle.emit(
                                "serial-error",
                                SerialErrorEventDto {
                                    session_id: sid.clone(),
                                    error: e.to_string(),
                                },
                            );
                            thread::sleep(Duration::from_millis(10));
                        }
                    }
                }
            } else {
                // Fallback if driver doesn't support try_clone()
                if let Ok(mut guard) = active_port.lock() {
                    if let ActivePort::Physical(ref mut sp) = *guard {
                        let avail = sp.bytes_to_read().unwrap_or(0) as usize;
                        let to_read = if avail > 0 { avail.min(buf.len()) } else { 1 };
                        match sp.read(&mut buf[..to_read]) {
                            Ok(n) if n > 0 => {
                                read_count = n;
                            }
                            Ok(_) => {}
                            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                            Err(e) => {
                                let _ = app_handle.emit(
                                    "serial-error",
                                    SerialErrorEventDto {
                                        session_id: sid.clone(),
                                        error: e.to_string(),
                                    },
                                );
                            }
                        }
                    } else {
                        break;
                    }
                }
            }

            if read_count > 0 {
                let perf_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                let slice = buf[..read_count].to_vec();
                let hex = slice.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
                let txt = String::from_utf8_lossy(&slice).to_string();
                push_rx_record(&rx_history_clone, RxRecord {
                    time_ms: perf_ms,
                    session_id: sid.clone(),
                    kind: "serial".to_string(),
                    id: None,
                    id_hex: None,
                    extended: None,
                    rtr: None,
                    dlc: None,
                    data: slice.clone(),
                    data_hex: hex,
                    text: Some(txt),
                });
                batch.push(RxChunkDto {
                    perf_ms,
                    data: slice,
                });
                batch_bytes += read_count;
            }

            // Emit immediately on arrival (0ms wait if >= 2ms since last emit),
            // or as soon as the burst pauses (`read_count == 0`), or when batch >= 8 KB
            let now = Instant::now();
            if !batch.is_empty()
                && (read_count == 0
                    || batch_bytes >= 8192
                    || now.duration_since(last_emit) >= Duration::from_millis(2))
            {
                let emit_chunks = std::mem::take(&mut batch);
                batch_bytes = 0;
                last_emit = now;
                let batch_now_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                let _ = app_handle.emit(
                    "serial-rx-batch",
                    SerialRxBatchEventDto {
                        session_id: sid.clone(),
                        batch_now_ms,
                        chunks: emit_chunks,
                    },
                );
            }

            // Poll modem status lines only every 250ms and only when idle
            if read_count == 0 && now.duration_since(last_modem_poll) >= Duration::from_millis(250)
            {
                last_modem_poll = now;
                if let Some(ref mut rp) = dedicated_reader {
                    let status = ModemStatusEventDto {
                        session_id: sid.clone(),
                        cts: rp.read_clear_to_send().unwrap_or(false),
                        dsr: rp.read_data_set_ready().unwrap_or(false),
                        cd: rp.read_carrier_detect().unwrap_or(false),
                        ri: rp.read_ring_indicator().unwrap_or(false),
                    };
                    let _ = app_handle.emit("serial-modem-status", status);
                }
            }

            // Note: Do NOT call thread::sleep(1ms) here when dedicated_reader is used!
            // Windows thread::sleep(1ms) actually sleeps for ~15.6ms (1 OS tick), which delayed 120Hz packets!
            // `rp.read(&mut buf)` already blocks in kernel COMMTIMEOUTS for 1ms and wakes up in microseconds when bytes arrive.
            if read_count == 0 && dedicated_reader.is_none() {
                thread::yield_now();
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn open_network_socket(
    app: AppHandle,
    state: State<'_, SerialManager>,
    session_id: String,
    config: NetConfigDto,
) -> Result<String, String> {
    close_session_internal(&state, &session_id);

    let epoch = Instant::now();
    let running = Arc::new(AtomicBool::new(true));

    match config.conn_type.as_str() {
        "tcp_client" => {
            let host = config.remote_host.unwrap_or_else(|| "127.0.0.1".to_string());
            let port = config.remote_port.unwrap_or(8080);
            let addr_str = format!("{}:{}", host, port);
            let socket_addrs: Vec<SocketAddr> = addr_str
                .to_socket_addrs()
                .map_err(|e| format!("無法解析主機位址 {}: {}", addr_str, e))?
                .collect();
            if socket_addrs.is_empty() {
                return Err(format!("找不到有效的 IP 位址: {}", addr_str));
            }
            let target_addr = socket_addrs[0];

            let stream = TcpStream::connect_timeout(&target_addr, Duration::from_secs(4))
                .map_err(|e| format!("TCP 連線失敗至 {}: {}", addr_str, e))?;
            let _ = stream.set_nodelay(true);
            let stream_read = stream.try_clone().map_err(|e| e.to_string())?;
            let _ = stream_read.set_read_timeout(Some(Duration::from_millis(50)));

            let stream_arc = Arc::new(Mutex::new(stream));
            let active_port = Arc::new(Mutex::new(ActivePort::TcpClient(Arc::clone(&stream_arc))));

            {
                let mut map = state.sessions.lock().map_err(|e| e.to_string())?;
                map.insert(
                    session_id.clone(),
                    PortSession {
                        port_name: format!("TCP:{}", addr_str),
                        active_port,
                        running: Arc::clone(&running),
                        epoch,
                    },
                );
            }

            let app_handle = app.clone();
            let sid = session_id.clone();
            let running_clone = Arc::clone(&running);

            thread::spawn(move || {
                let mut reader = stream_read;
                let mut buf = [0u8; 8192];
                let mut batch: Vec<RxChunkDto> = Vec::with_capacity(32);
                let mut batch_bytes: usize = 0;
                let mut last_emit = Instant::now();

                while running_clone.load(Ordering::Relaxed) {
                    let mut read_count = 0;
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            if running_clone.load(Ordering::Relaxed) {
                                let _ = app_handle.emit(
                                    "serial-error",
                                    SerialErrorEventDto {
                                        session_id: sid.clone(),
                                        error: "遠端主機已關閉 TCP 連線".to_string(),
                                    },
                                );
                            }
                            break;
                        }
                        Ok(n) => {
                            read_count = n;
                        }
                        Err(ref e)
                            if e.kind() == std::io::ErrorKind::TimedOut
                                || e.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(e) => {
                            if running_clone.load(Ordering::Relaxed) {
                                let _ = app_handle.emit(
                                    "serial-error",
                                    SerialErrorEventDto {
                                        session_id: sid.clone(),
                                        error: format!("TCP 連線錯誤: {}", e),
                                    },
                                );
                            }
                            break;
                        }
                    }

                    if read_count > 0 {
                        let perf_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                        batch.push(RxChunkDto {
                            perf_ms,
                            data: buf[..read_count].to_vec(),
                        });
                        batch_bytes += read_count;
                    }

                    let now = Instant::now();
                    if !batch.is_empty()
                        && (read_count == 0
                            || batch_bytes >= 8192
                            || now.duration_since(last_emit) >= Duration::from_millis(2))
                    {
                        let emit_chunks = std::mem::take(&mut batch);
                        batch_bytes = 0;
                        last_emit = now;
                        let batch_now_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                        let _ = app_handle.emit(
                            "serial-rx-batch",
                            SerialRxBatchEventDto {
                                session_id: sid.clone(),
                                batch_now_ms,
                                chunks: emit_chunks,
                            },
                        );
                    }
                }
            });

            let _ = app.emit(
                "serial-modem-status",
                ModemStatusEventDto {
                    session_id,
                    cts: true,
                    dsr: true,
                    cd: true,
                    ri: false,
                },
            );

            Ok(format!("已連線至 {}", addr_str))
        }
        "tcp_server" => {
            let host = config.local_host.unwrap_or_else(|| "0.0.0.0".to_string());
            let port = config.local_port.unwrap_or(8080);
            let bind_str = format!("{}:{}", host, port);
            let listener = TcpListener::bind(&bind_str)
                .map_err(|e| format!("無法綁定 TCP 監聽通訊埠 {}: {}", bind_str, e))?;
            let _ = listener.set_nonblocking(true);

            let clients_list = Arc::new(Mutex::new(Vec::<Arc<Mutex<TcpStream>>>::new()));
            let active_port = Arc::new(Mutex::new(ActivePort::TcpServer(Arc::clone(&clients_list))));

            {
                let mut map = state.sessions.lock().map_err(|e| e.to_string())?;
                map.insert(
                    session_id.clone(),
                    PortSession {
                        port_name: format!("TCP-S:{}", bind_str),
                        active_port,
                        running: Arc::clone(&running),
                        epoch,
                    },
                );
            }

            let app_handle = app.clone();
            let sid = session_id.clone();
            let running_clone = Arc::clone(&running);
            let clients_clone = Arc::clone(&clients_list);

            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                let mut batch: Vec<RxChunkDto> = Vec::with_capacity(32);
                let mut batch_bytes: usize = 0;
                let mut last_emit = Instant::now();

                while running_clone.load(Ordering::Relaxed) {
                    if let Ok((stream, client_addr)) = listener.accept() {
                        let _ = stream.set_nodelay(true);
                        let _ = stream.set_nonblocking(true);
                        if let Ok(mut c_guard) = clients_clone.lock() {
                            c_guard.push(Arc::new(Mutex::new(stream)));
                            let count = c_guard.len();
                            let _ = app_handle.emit(
                                "net-server-status",
                                serde_json::json!({
                                    "sessionId": sid.clone(),
                                    "clientCount": count,
                                    "msg": format!("客戶端 [{}] 已連線 (共 {} 個連線)", client_addr, count)
                                }),
                            );
                        }
                    }

                    let mut read_any = 0;
                    let mut dead_indices = Vec::new();

                    if let Ok(clients) = clients_clone.lock() {
                        for (idx, client_arc) in clients.iter().enumerate() {
                            if let Ok(mut c) = client_arc.lock() {
                                match c.read(&mut buf) {
                                    Ok(0) => {
                                        dead_indices.push(idx);
                                    }
                                    Ok(n) => {
                                        read_any += n;
                                        let perf_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                                        batch.push(RxChunkDto {
                                            perf_ms,
                                            data: buf[..n].to_vec(),
                                        });
                                        batch_bytes += n;
                                    }
                                    Err(ref e)
                                        if e.kind() == std::io::ErrorKind::WouldBlock
                                            || e.kind() == std::io::ErrorKind::TimedOut => {}
                                    Err(_) => {
                                        dead_indices.push(idx);
                                    }
                                }
                            }
                        }
                    }

                    if !dead_indices.is_empty() {
                        if let Ok(mut c_guard) = clients_clone.lock() {
                            for &idx in dead_indices.iter().rev() {
                                if idx < c_guard.len() {
                                    c_guard.remove(idx);
                                }
                            }
                            let count = c_guard.len();
                            let _ = app_handle.emit(
                                "net-server-status",
                                serde_json::json!({
                                    "sessionId": sid.clone(),
                                    "clientCount": count,
                                    "msg": format!("客戶端已離線 (剩餘 {} 個連線)", count)
                                }),
                            );
                        }
                    }

                    let now = Instant::now();
                    if !batch.is_empty()
                        && (read_any == 0
                            || batch_bytes >= 8192
                            || now.duration_since(last_emit) >= Duration::from_millis(2))
                    {
                        let emit_chunks = std::mem::take(&mut batch);
                        batch_bytes = 0;
                        last_emit = now;
                        let batch_now_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                        let _ = app_handle.emit(
                            "serial-rx-batch",
                            SerialRxBatchEventDto {
                                session_id: sid.clone(),
                                batch_now_ms,
                                chunks: emit_chunks,
                            },
                        );
                    }

                    if read_any == 0 {
                        thread::sleep(Duration::from_millis(3));
                    }
                }
            });

            let _ = app.emit(
                "serial-modem-status",
                ModemStatusEventDto {
                    session_id,
                    cts: true,
                    dsr: true,
                    cd: true,
                    ri: false,
                },
            );

            Ok(format!("TCP 伺服器監聽於 {}", bind_str))
        }
        "udp" => {
            let local_port = config.local_port.unwrap_or(0);
            let local_bind = format!("0.0.0.0:{}", local_port);
            let socket = UdpSocket::bind(&local_bind)
                .map_err(|e| format!("無法綁定 UDP 通訊埠 {}: {}", local_bind, e))?;
            let _ = socket.set_nonblocking(true);
            let _ = socket.set_broadcast(true);

            let real_local_addr = socket
                .local_addr()
                .map(|a| a.to_string())
                .unwrap_or_else(|_| local_bind.clone());

            let target_addr: Option<SocketAddr> = match (config.remote_host, config.remote_port) {
                (Some(h), Some(p)) => {
                    let addr_str = format!("{}:{}", h, p);
                    addr_str.to_socket_addrs().ok().and_then(|mut it| it.next())
                }
                _ => None,
            };

            let socket_arc = Arc::new(socket);
            let target_arc = Arc::new(Mutex::new(target_addr));
            let active_port = Arc::new(Mutex::new(ActivePort::Udp {
                socket: Arc::clone(&socket_arc),
                target: Arc::clone(&target_arc),
            }));

            {
                let mut map = state.sessions.lock().map_err(|e| e.to_string())?;
                map.insert(
                    session_id.clone(),
                    PortSession {
                        port_name: format!("UDP:{}", real_local_addr),
                        active_port,
                        running: Arc::clone(&running),
                        epoch,
                    },
                );
            }

            let app_handle = app.clone();
            let sid = session_id.clone();
            let running_clone = Arc::clone(&running);
            let socket_recv = Arc::clone(&socket_arc);

            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                let mut batch: Vec<RxChunkDto> = Vec::with_capacity(32);
                let mut batch_bytes: usize = 0;
                let mut last_emit = Instant::now();

                while running_clone.load(Ordering::Relaxed) {
                    let mut read_count = 0;
                    match socket_recv.recv_from(&mut buf) {
                        Ok((n, _src_addr)) => {
                            read_count = n;
                        }
                        Err(ref e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                || e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(e) => {
                            if running_clone.load(Ordering::Relaxed) {
                                let _ = app_handle.emit(
                                    "serial-error",
                                    SerialErrorEventDto {
                                        session_id: sid.clone(),
                                        error: format!("UDP 接收錯誤: {}", e),
                                    },
                                );
                            }
                        }
                    }

                    if read_count > 0 {
                        let perf_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                        batch.push(RxChunkDto {
                            perf_ms,
                            data: buf[..read_count].to_vec(),
                        });
                        batch_bytes += read_count;
                    }

                    let now = Instant::now();
                    if !batch.is_empty()
                        && (read_count == 0
                            || batch_bytes >= 8192
                            || now.duration_since(last_emit) >= Duration::from_millis(2))
                    {
                        let emit_chunks = std::mem::take(&mut batch);
                        batch_bytes = 0;
                        last_emit = now;
                        let batch_now_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                        let _ = app_handle.emit(
                            "serial-rx-batch",
                            SerialRxBatchEventDto {
                                session_id: sid.clone(),
                                batch_now_ms,
                                chunks: emit_chunks,
                            },
                        );
                    }

                    if read_count == 0 {
                        thread::sleep(Duration::from_millis(3));
                    }
                }
            });

            let _ = app.emit(
                "serial-modem-status",
                ModemStatusEventDto {
                    session_id,
                    cts: true,
                    dsr: true,
                    cd: true,
                    ri: false,
                },
            );

            Ok(format!("UDP 監聽於 {}", real_local_addr))
        }
        other => Err(format!("未知的網路通訊模式: {}", other)),
    }
}

#[tauri::command]
fn set_udp_target(
    state: State<'_, SerialManager>,
    session_id: String,
    remote_host: String,
    remote_port: u16,
) -> Result<(), String> {
    let map = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(sess) = map.get(&session_id) {
        if let Ok(guard) = sess.active_port.lock() {
            if let ActivePort::Udp { ref target, .. } = *guard {
                let addr_str = format!("{}:{}", remote_host, remote_port);
                let socket_addr = addr_str
                    .to_socket_addrs()
                    .map_err(|e| format!("無法解析主機 {}: {}", addr_str, e))?
                    .next()
                    .ok_or_else(|| "找不到有效的目標 IP".to_string())?;
                if let Ok(mut t) = target.lock() {
                    *t = Some(socket_addr);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn close_serial_port(state: State<'_, SerialManager>, session_id: String) -> Result<(), String> {
    close_session_internal(&state, &session_id);
    Ok(())
}

#[tauri::command]
fn write_serial_bytes(
    app: AppHandle,
    state: State<'_, SerialManager>,
    session_id: String,
    data: Vec<u8>,
) -> Result<usize, String> {
    write_serial_bytes_internal(&app, &state, session_id, data)
}

pub fn write_serial_bytes_internal(
    app: &AppHandle,
    state: &SerialManager,
    session_id: String,
    data: Vec<u8>,
) -> Result<usize, String> {
    let (active_port, epoch) = {
        let map = state.sessions.lock().map_err(|e| e.to_string())?;
        let sess = map
            .get(&session_id)
            .ok_or_else(|| "此分頁的通訊連線尚未開啟".to_string())?;
        (Arc::clone(&sess.active_port), sess.epoch)
    };

    let mut guard = active_port.lock().map_err(|e| e.to_string())?;
    match *guard {
        ActivePort::Physical(ref mut sp) => {
            let written = sp.write(&data).map_err(|e| e.to_string())?;
            let _ = sp.flush();
            Ok(written)
        }
        ActivePort::TcpClient(ref stream_mutex) => {
            let mut s = stream_mutex.lock().map_err(|e| e.to_string())?;
            s.write_all(&data)
                .map_err(|e| format!("TCP 發送失敗: {}", e))?;
            let _ = s.flush();
            Ok(data.len())
        }
        ActivePort::TcpServer(ref clients_mutex) => {
            let mut clients = clients_mutex.lock().map_err(|e| e.to_string())?;
            if clients.is_empty() {
                return Err("目前尚無客戶端連入 TCP 伺服器".to_string());
            }
            let mut sent_any = false;
            let mut dead_indices = Vec::new();
            for (idx, client_arc) in clients.iter().enumerate() {
                if let Ok(mut c) = client_arc.lock() {
                    if c.write_all(&data).is_ok() {
                        let _ = c.flush();
                        sent_any = true;
                    } else {
                        dead_indices.push(idx);
                    }
                }
            }
            for &idx in dead_indices.iter().rev() {
                clients.remove(idx);
            }
            if !sent_any {
                return Err("無法發送至任何已連線的 TCP 客戶端".to_string());
            }
            Ok(data.len())
        }
        ActivePort::Udp {
            ref socket,
            ref target,
        } => {
            let addr_guard = target.lock().map_err(|e| e.to_string())?;
            let addr = addr_guard
                .ok_or_else(|| "未指定 UDP 目標 IP:Port，無法發送".to_string())?;
            let written = socket
                .send_to(&data, addr)
                .map_err(|e| format!("UDP 發送失敗: {}", e))?;
            Ok(written)
        }
        ActivePort::Loopback => {
            let len = data.len();
            let app_clone = app.clone();
            let sid = session_id.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(8));
                let now_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                let _ = app_clone.emit(
                    "serial-rx-batch",
                    SerialRxBatchEventDto {
                        session_id: sid,
                        batch_now_ms: now_ms,
                        chunks: vec![RxChunkDto {
                            perf_ms: now_ms,
                            data,
                        }],
                    },
                );
            });
            Ok(len)
        }
        ActivePort::Pcan { .. } => {
            Err("PCAN 模式請使用 write_pcan_frame 指令發送 CAN 幀".to_string())
        }
    }
}

#[tauri::command]
fn list_pcan_channels() -> Result<Vec<PortInfoDto>, String> {
    list_pcan_channels_internal()
}

pub fn list_pcan_channels_internal() -> Result<Vec<PortInfoDto>, String> {
    let lib = PcanLib::load()?;
    let mut channels = Vec::new();

    if let Ok(attached) = lib.get_attached_channels() {
        for info in attached {
            let handle = info.channel_handle;
            let ch_name = PCAN_USB_CHANNELS
                .iter()
                .find(|&&(h, _)| h == handle)
                .map(|&(_, n)| n.to_string())
                .unwrap_or_else(|| format!("PCAN_CHANNEL_0x{:02X}", handle));

            let dev_name_str = String::from_utf8_lossy(&info.device_name);
            let dev_name = dev_name_str.trim_end_matches('\0').trim();
            let label = match info.channel_condition {
                PCAN_CHANNEL_AVAILABLE => format!("{} - {} (可用)", ch_name, dev_name),
                PCAN_CHANNEL_OCCUPIED => format!("{} - {} (已被佔用/需重插USB)", ch_name, dev_name),
                PCAN_CHANNEL_PCANVIEW => format!("{} - {} (PCAN-View連線中)", ch_name, dev_name),
                _ => format!("{} - {} (狀態: {})", ch_name, dev_name, info.channel_condition),
            };
            channels.push(PortInfoDto {
                name: ch_name,
                label,
            });
        }
    }

    if channels.is_empty() {
        for &(handle, name) in PCAN_USB_CHANNELS {
            if let Ok(cond) = lib.get_channel_condition(handle) {
                if cond == PCAN_CHANNEL_AVAILABLE {
                    channels.push(PortInfoDto {
                        name: name.to_string(),
                        label: format!("{} (可用)", name),
                    });
                } else if cond == PCAN_CHANNEL_OCCUPIED {
                    channels.push(PortInfoDto {
                        name: name.to_string(),
                        label: format!("{} (已被佔用/需重插USB)", name),
                    });
                } else if cond == PCAN_CHANNEL_PCANVIEW {
                    channels.push(PortInfoDto {
                        name: name.to_string(),
                        label: format!("{} (PCAN-View連線中)", name),
                    });
                }
            }
        }
    }

    if channels.is_empty() {
        for &(_, name) in PCAN_USB_CHANNELS {
            channels.push(PortInfoDto {
                name: name.to_string(),
                label: format!("{} (未偵測到硬體)", name),
            });
        }
    }
    Ok(channels)
}

#[tauri::command]
fn open_pcan_channel(
    app: AppHandle,
    state: State<'_, SerialManager>,
    session_id: String,
    config: PcanConfigDto,
) -> Result<String, String> {
    open_pcan_channel_internal(&app, &state, session_id, config)
}

pub fn open_pcan_channel_internal(
    app: &AppHandle,
    state: &SerialManager,
    session_id: String,
    config: PcanConfigDto,
) -> Result<String, String> {
    close_session_internal(state, &session_id);

    let lib = PcanLib::load()?;
    let channel = parse_channel_handle(&config.channel)?;
    let btr0btr1 = baud_to_btr0btr1(config.baud_rate)?;

    let status = lib.initialize(channel, btr0btr1);
    if status != PCAN_ERROR_OK {
        if status == 0x80000 {
            return Err("PCAN 初始化失敗 (0x80000)：硬體通道目前仍被系統鎖定（因先前曾被 PCAN-View 連線過）。請將 PCAN-USB 實體傳輸線拔除並重新插上即可正常連線！".to_string());
        }
        return Err(format!("PCAN 初始化失敗: {}", format_pcan_error(status)));
    }

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = Arc::clone(&running);
    let epoch = Instant::now();
    let lib_reader = Arc::clone(&lib);
    let active_port = Arc::new(Mutex::new(ActivePort::Pcan {
        lib: Arc::clone(&lib),
        channel,
    }));

    {
        let mut map = state.sessions.lock().map_err(|e| e.to_string())?;
        map.insert(
            session_id.clone(),
            PortSession {
                port_name: config.channel.clone(),
                active_port,
                running,
                epoch,
            },
        );
    }

    let sid = session_id.clone();
    let app_handle = app.clone();
    let rx_history_clone = Arc::clone(&state.rx_history);

    thread::spawn(move || {
        while running_clone.load(Ordering::SeqCst) {
            let mut batch = Vec::new();
            for _ in 0..64 {
                match lib_reader.read(channel) {
                    Ok(Some(msg)) => {
                        if (msg.msg_type & PCAN_MESSAGE_STATUS) != 0 {
                            continue;
                        }
                        let dlc = msg.len.min(8);
                        let is_rtr = (msg.msg_type & PCAN_MESSAGE_RTR) != 0;
                        let is_ext = (msg.msg_type & PCAN_MESSAGE_EXTENDED) != 0;
                        let data = if is_rtr {
                            Vec::new()
                        } else {
                            msg.data[..dlc as usize].to_vec()
                        };
                        let perf_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                        let hex = data.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ");
                        let id_hex = if is_ext { format!("{:08X}", msg.id) } else { format!("{:03X}", msg.id) };

                        push_rx_record(&rx_history_clone, RxRecord {
                            time_ms: perf_ms,
                            session_id: sid.clone(),
                            kind: "pcan".to_string(),
                            id: Some(msg.id),
                            id_hex: Some(id_hex),
                            extended: Some(is_ext),
                            rtr: Some(is_rtr),
                            dlc: Some(dlc),
                            data: data.clone(),
                            data_hex: hex,
                            text: None,
                        });

                        batch.push(CanRxFrameDto {
                            perf_ms,
                            id: msg.id,
                            extended: is_ext,
                            rtr: is_rtr,
                            dlc,
                            data,
                        });
                    }
                    Ok(None) => break,
                    Err(err_code) => {
                        let _ = app_handle.emit(
                            "serial-error",
                            SerialErrorEventDto {
                                session_id: sid.clone(),
                                error: format_pcan_error(err_code),
                            },
                        );
                        break;
                    }
                }
            }

            if !batch.is_empty() {
                let _ = app_handle.emit(
                    "pcan-rx-batch",
                    CanRxBatchEventDto {
                        session_id: sid.clone(),
                        batch_now_ms: epoch.elapsed().as_secs_f64() * 1000.0,
                        frames: batch,
                    },
                );
            } else {
                thread::sleep(Duration::from_millis(2));
            }
        }
    });

    Ok(format!("{} @ {} bps", config.channel, config.baud_rate))
}

#[tauri::command]
fn write_pcan_frame(
    state: State<'_, SerialManager>,
    session_id: String,
    frame: PcanTxFrameDto,
) -> Result<usize, String> {
    write_pcan_frame_internal(&state, session_id, frame)
}

pub fn write_pcan_frame_internal(
    state: &SerialManager,
    session_id: String,
    frame: PcanTxFrameDto,
) -> Result<usize, String> {
    let max_id = if frame.extended { 0x1FFF_FFFF } else { 0x7FF };
    if frame.id > max_id {
        return Err(format!(
            "CAN ID 0x{:X} 超出{}範圍 (最大 0x{:X})",
            frame.id,
            if frame.extended { "擴展幀 29-bit" } else { "標準幀 11-bit" },
            max_id
        ));
    }
    if frame.data.len() > 8 {
        return Err(format!(
            "Classic CAN 單幀最多 8 Bytes（目前 {} Bytes）",
            frame.data.len()
        ));
    }

    let (lib, channel) = {
        let map = state.sessions.lock().map_err(|e| e.to_string())?;
        let sess = map
            .get(&session_id)
            .ok_or_else(|| "此分頁的 PCAN 連線尚未開啟".to_string())?;
        let guard = sess.active_port.lock().map_err(|e| e.to_string())?;
        match *guard {
            ActivePort::Pcan { ref lib, channel } => (Arc::clone(lib), channel),
            _ => return Err("目前分頁不是 PCAN 模式".to_string()),
        }
    };

    let mut msg_type = if frame.extended {
        PCAN_MESSAGE_EXTENDED
    } else {
        PCAN_MESSAGE_STANDARD
    };
    if frame.rtr {
        msg_type |= PCAN_MESSAGE_RTR;
    }

    let mut raw_data = [0u8; 8];
    let dlc = frame.data.len() as u8;
    raw_data[..frame.data.len()].copy_from_slice(&frame.data);

    let mut msg = TPCANMsg {
        id: frame.id,
        msg_type,
        len: dlc,
        data: raw_data,
    };

    let status = lib.write(channel, &mut msg);
    if status != PCAN_ERROR_OK {
        return Err(format!("PCAN 發送失敗: {}", format_pcan_error(status)));
    }
    Ok(frame.data.len())
}

#[tauri::command]
fn set_control_lines(
    app: AppHandle,
    state: State<'_, SerialManager>,
    session_id: String,
    dtr: bool,
    rts: bool,
) -> Result<(), String> {
    let active_port = {
        let map = state.sessions.lock().map_err(|e| e.to_string())?;
        map.get(&session_id)
            .map(|s| Arc::clone(&s.active_port))
            .ok_or_else(|| "此分頁的通訊連線尚未開啟".to_string())?
    };

    let mut guard = active_port.lock().map_err(|e| e.to_string())?;
    match *guard {
        ActivePort::Physical(ref mut sp) => {
            sp.write_data_terminal_ready(dtr)
                .map_err(|e| format!("設定 DTR 失敗: {}", e))?;
            sp.write_request_to_send(rts)
                .map_err(|e| format!("設定 RTS 失敗: {}", e))?;
            Ok(())
        }
        ActivePort::Loopback => {
            let _ = app.emit(
                "serial-modem-status",
                ModemStatusEventDto {
                    session_id,
                    cts: rts,
                    dsr: dtr,
                    cd: dtr && rts,
                    ri: false,
                },
            );
            Ok(())
        }
        ActivePort::TcpClient(_)
        | ActivePort::TcpServer(_)
        | ActivePort::Udp { .. }
        | ActivePort::Pcan { .. } => Ok(()),
    }
}

#[tauri::command]
fn win_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_toggle_maximize(window: tauri::Window) -> Result<bool, String> {
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
fn win_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_start_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
async fn detach_tab_window(
    app: AppHandle,
    state: State<'_, SerialManager>,
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
    .min_inner_size(760.0, 500.0)
    .decorations(false);

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
fn take_detached_session(
    state: State<'_, SerialManager>,
    key: String,
) -> Result<Option<String>, String> {
    let mut map = state.detached_payloads.lock().map_err(|e| e.to_string())?;
    Ok(map.remove(&key))
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

    tauri::Builder::default()
        .manage(SerialManager::default())
        .setup(move |app| {
            let server_running = Arc::new(AtomicBool::new(true));
            api_server::start_api_server(app.handle().clone(), server_running);

            let _ = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("PortAssist - RS232/422/485 + TCP/UDP + PCAN Debugger")
            .inner_size(1080.0, 740.0)
            .min_inner_size(820.0, 540.0)
            .decorations(false)
            .data_directory(data_dir.clone())
            .additional_browser_args("--no-sandbox")
            .build();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            open_serial_port,
            open_network_socket,
            set_udp_target,
            close_serial_port,
            write_serial_bytes,
            set_control_lines,
            list_pcan_channels,
            open_pcan_channel,
            write_pcan_frame,
            win_minimize,
            win_toggle_maximize,
            win_close,
            win_start_drag,
            detach_tab_window,
            take_detached_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PortAssist application");
}
