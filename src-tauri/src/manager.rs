use crate::pcan::CanRxBatchEventDto;
use crate::pcan::PcanLib;
use serde::{Deserialize, Serialize};
use serialport::SerialPort;
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Serialize, Clone)]
pub struct PortInfoDto {
    pub name: String,
    pub label: String,
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

#[derive(Debug, Clone)]
pub enum TransportEvent {
    RxBatch(SerialRxBatchEventDto),
    CanRxBatch(CanRxBatchEventDto),
    ModemStatus(ModemStatusEventDto),
    NetServerStatus {
        session_id: String,
        client_count: usize,
        msg: String,
    },
    Error(SerialErrorEventDto),
    McpSessionOpened {
        session_id: String,
        port_name: String,
        conn_type: String,
        baud_rate: u32,
    },
    McpSessionClosed {
        session_id: String,
    },
    ExternalTx {
        session_id: String,
        data: Vec<u8>,
    },
    ExternalPcanTx {
        session_id: String,
        id: u32,
        extended: bool,
        rtr: bool,
        dlc: usize,
        data: Vec<u8>,
    },
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: TransportEvent);
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

impl ActivePort {
    pub fn write_bytes(
        &mut self,
        sink: &Arc<dyn EventSink>,
        session_id: &str,
        epoch: Instant,
        data: Vec<u8>,
    ) -> Result<usize, String> {
        match *self {
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
                let sink_clone = Arc::clone(sink);
                let sid = session_id.to_string();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(8));
                    let now_ms = epoch.elapsed().as_secs_f64() * 1000.0;
                    sink_clone.emit(TransportEvent::RxBatch(SerialRxBatchEventDto {
                        session_id: sid,
                        batch_now_ms: now_ms,
                        chunks: vec![RxChunkDto {
                            perf_ms: now_ms,
                            data,
                        }],
                    }));
                });
                Ok(len)
            }
            ActivePort::Pcan { .. } => {
                Err("PCAN 模式請使用 write_pcan_frame 指令發送 CAN 幀".to_string())
            }
        }
    }
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

pub fn write_serial_bytes_internal(
    sink: &Arc<dyn EventSink>,
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
    guard.write_bytes(sink, &session_id, epoch, data)
}

#[tauri::command]
pub fn close_serial_port(
    state: tauri::State<'_, Arc<SerialManager>>,
    session_id: String,
) -> Result<(), String> {
    close_session_internal(state.inner(), &session_id);
    Ok(())
}

#[tauri::command]
pub fn write_serial_bytes(
    sink: tauri::State<'_, Arc<dyn EventSink>>,
    state: tauri::State<'_, Arc<SerialManager>>,
    session_id: String,
    data: Vec<u8>,
) -> Result<usize, String> {
    write_serial_bytes_internal(sink.inner(), state.inner(), session_id, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serial::{open_serial_port_internal, SerialConfigDto};
    use std::sync::mpsc;

    struct ChannelSink(mpsc::Sender<TransportEvent>);

    impl EventSink for ChannelSink {
        fn emit(&self, event: TransportEvent) {
            let _ = self.0.send(event);
        }
    }

    fn loopback_config() -> SerialConfigDto {
        SerialConfigDto {
            port_name: "LOOPBACK".to_string(),
            baud_rate: 115200,
            parity: "None".to_string(),
            data_bits: 8,
            stop_bits: 1,
            flow_control: "None".to_string(),
        }
    }

    #[test]
    fn test_loopback_high_freq_writes_and_close_cleanup() {
        let mgr = SerialManager::default();
        let (tx, rx) = mpsc::channel();
        let sink: Arc<dyn EventSink> = Arc::new(ChannelSink(tx));

        open_serial_port_internal(&sink, &mgr, "s1".to_string(), loopback_config()).unwrap();

        // First event should be ModemStatus
        match rx.recv_timeout(Duration::from_millis(200)).unwrap() {
            TransportEvent::ModemStatus(st) => assert_eq!(st.session_id, "s1"),
            other => panic!("unexpected event: {:?}", other),
        }

        // Send 20 rapid packets (~100Hz+ burst)
        let packet_count = 20usize;
        for i in 0..packet_count {
            let written =
                write_serial_bytes_internal(&sink, &mgr, "s1".to_string(), vec![0xAA, i as u8])
                    .unwrap();
            assert_eq!(written, 2);
        }

        let mut received = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(2);
        while received.len() < packet_count && Instant::now() < deadline {
            if let Ok(TransportEvent::RxBatch(batch)) =
                rx.recv_timeout(Duration::from_millis(200))
            {
                for chunk in batch.chunks {
                    received.push(chunk.data);
                }
            }
        }
        assert_eq!(received.len(), packet_count);

        // Verify close_session_internal sets running = false and removes session
        let running_flag = {
            let map = mgr.sessions.lock().unwrap();
            Arc::clone(&map.get("s1").unwrap().running)
        };
        assert!(running_flag.load(Ordering::SeqCst));
        close_session_internal(&mgr, "s1");
        assert!(!running_flag.load(Ordering::SeqCst));
        assert!(mgr.sessions.lock().unwrap().is_empty());
    }
}
