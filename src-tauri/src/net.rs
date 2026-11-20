use crate::manager::{
    close_session_internal, ActivePort, EventSink, ModemStatusEventDto, PortSession, RxChunkDto,
    SerialErrorEventDto, SerialManager, SerialRxBatchEventDto, TransportEvent,
};
use serde::Deserialize;
use std::io::Read;
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetConfigDto {
    pub conn_type: String, // "tcp_client", "tcp_server", "udp"
    pub remote_host: Option<String>,
    pub remote_port: Option<u16>,
    pub local_host: Option<String>,
    pub local_port: Option<u16>,
}

pub fn open_network_socket_internal(
    sink: &Arc<dyn EventSink>,
    state: &SerialManager,
    session_id: String,
    config: NetConfigDto,
) -> Result<String, String> {
    close_session_internal(state, &session_id);

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

            let sink_clone = Arc::clone(sink);
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
                                sink_clone.emit(TransportEvent::Error(SerialErrorEventDto {
                                    session_id: sid.clone(),
                                    error: "遠端主機已關閉 TCP 連線".to_string(),
                                }));
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
                                sink_clone.emit(TransportEvent::Error(SerialErrorEventDto {
                                    session_id: sid.clone(),
                                    error: format!("TCP 連線錯誤: {}", e),
                                }));
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
                        sink_clone.emit(TransportEvent::RxBatch(SerialRxBatchEventDto {
                            session_id: sid.clone(),
                            batch_now_ms,
                            chunks: emit_chunks,
                        }));
                    }
                }
            });

            sink.emit(TransportEvent::ModemStatus(ModemStatusEventDto {
                session_id,
                cts: true,
                dsr: true,
                cd: true,
                ri: false,
            }));

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
            let active_port =
                Arc::new(Mutex::new(ActivePort::TcpServer(Arc::clone(&clients_list))));

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

            let sink_clone = Arc::clone(sink);
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
                            sink_clone.emit(TransportEvent::NetServerStatus {
                                session_id: sid.clone(),
                                client_count: count,
                                msg: format!(
                                    "客戶端 [{}] 已連線 (共 {} 個連線)",
                                    client_addr, count
                                ),
                            });
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
                            sink_clone.emit(TransportEvent::NetServerStatus {
                                session_id: sid.clone(),
                                client_count: count,
                                msg: format!("客戶端已離線 (剩餘 {} 個連線)", count),
                            });
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
                        sink_clone.emit(TransportEvent::RxBatch(SerialRxBatchEventDto {
                            session_id: sid.clone(),
                            batch_now_ms,
                            chunks: emit_chunks,
                        }));
                    }

                    if read_any == 0 {
                        thread::sleep(Duration::from_millis(3));
                    }
                }
            });

            sink.emit(TransportEvent::ModemStatus(ModemStatusEventDto {
                session_id,
                cts: true,
                dsr: true,
                cd: true,
                ri: false,
            }));

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

            let sink_clone = Arc::clone(sink);
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
                                sink_clone.emit(TransportEvent::Error(SerialErrorEventDto {
                                    session_id: sid.clone(),
                                    error: format!("UDP 接收錯誤: {}", e),
                                }));
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
                        sink_clone.emit(TransportEvent::RxBatch(SerialRxBatchEventDto {
                            session_id: sid.clone(),
                            batch_now_ms,
                            chunks: emit_chunks,
                        }));
                    }

                    if read_count == 0 {
                        thread::sleep(Duration::from_millis(3));
                    }
                }
            });

            sink.emit(TransportEvent::ModemStatus(ModemStatusEventDto {
                session_id,
                cts: true,
                dsr: true,
                cd: true,
                ri: false,
            }));

            Ok(format!("UDP 監聽於 {}", real_local_addr))
        }
        other => Err(format!("未知的網路通訊模式: {}", other)),
    }
}

#[tauri::command]
pub fn open_network_socket(
    sink: tauri::State<'_, Arc<dyn EventSink>>,
    state: tauri::State<'_, Arc<SerialManager>>,
    session_id: String,
    config: NetConfigDto,
) -> Result<String, String> {
    open_network_socket_internal(sink.inner(), state.inner(), session_id, config)
}

#[tauri::command]
pub fn set_udp_target(
    state: tauri::State<'_, Arc<SerialManager>>,
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
