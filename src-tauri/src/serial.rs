use crate::manager::{
    close_session_internal, push_rx_record, ActivePort, EventSink, ModemStatusEventDto,
    PortInfoDto, PortSession, RxChunkDto, RxRecord, SerialErrorEventDto, SerialManager,
    SerialRxBatchEventDto, TransportEvent,
};
use serde::Deserialize;
use serialport::{DataBits, FlowControl, Parity, SerialPortType, StopBits};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<PortInfoDto>, String> {
    list_serial_ports_internal()
}

pub fn open_serial_port_internal(
    sink: &Arc<dyn EventSink>,
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
        sink.emit(TransportEvent::ModemStatus(ModemStatusEventDto {
            session_id,
            cts: true,
            dsr: true,
            cd: false,
            ri: false,
        }));
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

    let sink_clone = Arc::clone(sink);
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
                            sink_clone.emit(TransportEvent::Error(SerialErrorEventDto {
                                session_id: sid.clone(),
                                error: e.to_string(),
                            }));
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
                                sink_clone.emit(TransportEvent::Error(SerialErrorEventDto {
                                    session_id: sid.clone(),
                                    error: e.to_string(),
                                }));
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
                let hex = slice
                    .iter()
                    .map(|b| format!("{:02X}", b))
                    .collect::<Vec<_>>()
                    .join(" ");
                let txt = String::from_utf8_lossy(&slice).to_string();
                push_rx_record(
                    &rx_history_clone,
                    RxRecord {
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
                    },
                );
                batch.push(RxChunkDto {
                    perf_ms,
                    data: slice,
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
                    sink_clone.emit(TransportEvent::ModemStatus(status));
                }
            }

            if read_count == 0 && dedicated_reader.is_none() {
                thread::yield_now();
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn open_serial_port(
    sink: tauri::State<'_, Arc<dyn EventSink>>,
    state: tauri::State<'_, Arc<SerialManager>>,
    session_id: String,
    config: SerialConfigDto,
) -> Result<(), String> {
    open_serial_port_internal(sink.inner(), state.inner(), session_id, config)
}

pub fn set_control_lines_internal(
    sink: &Arc<dyn EventSink>,
    state: &SerialManager,
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
            sink.emit(TransportEvent::ModemStatus(ModemStatusEventDto {
                session_id,
                cts: rts,
                dsr: dtr,
                cd: dtr && rts,
                ri: false,
            }));
            Ok(())
        }
        ActivePort::TcpClient(_)
        | ActivePort::TcpServer(_)
        | ActivePort::Udp { .. }
        | ActivePort::Pcan { .. } => Ok(()),
    }
}

#[tauri::command]
pub fn set_control_lines(
    sink: tauri::State<'_, Arc<dyn EventSink>>,
    state: tauri::State<'_, Arc<SerialManager>>,
    session_id: String,
    dtr: bool,
    rts: bool,
) -> Result<(), String> {
    set_control_lines_internal(sink.inner(), state.inner(), session_id, dtr, rts)
}
