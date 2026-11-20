use crate::manager::{
    close_session_internal, write_serial_bytes_internal, EventSink, SerialManager, TransportEvent,
};
use crate::pcan::{
    list_pcan_channels_internal, open_pcan_channel_internal, write_pcan_frame_internal,
    PcanConfigDto, PcanTxFrameDto,
};
use crate::serial::{list_serial_ports_internal, open_serial_port_internal, SerialConfigDto};
use serde::Deserialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSerialOpenReq {
    pub session_id: Option<String>,
    pub port_name: String,
    pub baud_rate: Option<u32>,
    pub parity: Option<String>,
    pub data_bits: Option<u8>,
    pub stop_bits: Option<u8>,
    pub flow_control: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiPcanOpenReq {
    pub session_id: Option<String>,
    pub channel: Option<String>,
    pub baud_rate: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSerialSendReq {
    pub session_id: Option<String>,
    pub text: Option<String>,
    pub data_hex: Option<String>,
    pub data: Option<Vec<u8>>,
    pub append_crlf: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiPcanSendReq {
    pub session_id: Option<String>,
    pub id: u32,
    pub data_hex: Option<String>,
    pub data: Option<Vec<u8>>,
    pub extended: Option<bool>,
    pub rtr: Option<bool>,
}

pub fn get_active_sessions_summary(state: &SerialManager) -> Vec<serde_json::Value> {
    let mut list = Vec::new();
    if let Ok(map) = state.sessions.lock() {
        for (sid, sess) in map.iter() {
            let is_open = sess.running.load(Ordering::Relaxed);
            list.push(serde_json::json!({
                "sessionId": sid,
                "portName": sess.port_name,
                "isOpen": is_open
            }));
        }
    }
    list
}

pub fn list_all_devices() -> serde_json::Value {
    let serials = list_serial_ports_internal().unwrap_or_default();
    let pcans = list_pcan_channels_internal().unwrap_or_default();
    serde_json::json!({
        "serial": serials,
        "pcan": pcans
    })
}

fn resolve_session_id(state: &SerialManager, explicit_id: Option<String>) -> String {
    if let Some(sid) = explicit_id {
        if !sid.trim().is_empty() {
            return sid;
        }
    }
    if let Ok(map) = state.sessions.lock() {
        if let Some(first_id) = map.keys().next() {
            return first_id.clone();
        }
    }
    "s1".to_string()
}

pub fn open_serial_from_api(
    sink: &Arc<dyn EventSink>,
    state: &SerialManager,
    req: ApiSerialOpenReq,
) -> Result<String, String> {
    let sid = resolve_session_id(state, req.session_id);
    let config = SerialConfigDto {
        port_name: req.port_name.clone(),
        baud_rate: req.baud_rate.unwrap_or(115200),
        parity: req.parity.unwrap_or_else(|| "None".to_string()),
        data_bits: req.data_bits.unwrap_or(8),
        stop_bits: req.stop_bits.unwrap_or(1),
        flow_control: req.flow_control.unwrap_or_else(|| "None".to_string()),
    };

    open_serial_port_internal(sink, state, sid.clone(), config.clone())?;

    sink.emit(TransportEvent::McpSessionOpened {
        session_id: sid,
        port_name: config.port_name.clone(),
        conn_type: "serial".to_string(),
        baud_rate: config.baud_rate,
    });

    Ok(format!(
        "已連線串口 {} @ {} bps",
        config.port_name, config.baud_rate
    ))
}

pub fn open_pcan_from_api(
    sink: &Arc<dyn EventSink>,
    state: &SerialManager,
    req: ApiPcanOpenReq,
) -> Result<String, String> {
    let sid = resolve_session_id(state, req.session_id);
    let channel_name = req.channel.unwrap_or_else(|| "PCAN_USBBUS1".to_string());
    let baud_rate = req.baud_rate.unwrap_or(500000);

    let pcan_config = PcanConfigDto {
        channel: channel_name.clone(),
        baud_rate,
    };

    open_pcan_channel_internal(sink, state, sid.clone(), pcan_config)?;

    sink.emit(TransportEvent::McpSessionOpened {
        session_id: sid,
        port_name: channel_name.clone(),
        conn_type: "pcan".to_string(),
        baud_rate,
    });

    Ok(format!(
        "已連線 PCAN 通道 {} @ {} bps",
        channel_name, baud_rate
    ))
}

pub fn close_session_by_id(
    sink: &Arc<dyn EventSink>,
    state: &SerialManager,
    session_id: Option<String>,
) -> Result<String, String> {
    let sid = resolve_session_id(state, session_id);
    close_session_internal(state, &sid);

    sink.emit(TransportEvent::McpSessionClosed {
        session_id: sid.clone(),
    });

    Ok(format!("階段 {} 已關閉連線", sid))
}

pub fn send_serial_from_api(
    sink: &Arc<dyn EventSink>,
    state: &SerialManager,
    req: ApiSerialSendReq,
) -> Result<usize, String> {
    let sid = resolve_session_id(state, req.session_id);

    let mut bytes = if let Some(raw) = req.data {
        raw
    } else if let Some(hex_str) = req.data_hex {
        parse_hex_string(&hex_str)?
    } else if let Some(txt) = req.text {
        txt.into_bytes()
    } else {
        return Err("請提供 text 或 dataHex 或 data 數據".to_string());
    };

    if req.append_crlf.unwrap_or(false) {
        bytes.push(0x0d);
        bytes.push(0x0a);
    }

    if bytes.is_empty() {
        return Err("數據為空".to_string());
    }

    let len = write_serial_bytes_internal(sink, state, sid.clone(), bytes.clone())?;

    sink.emit(TransportEvent::ExternalTx {
        session_id: sid,
        data: bytes,
    });

    Ok(len)
}

pub fn send_pcan_from_api(
    sink: &Arc<dyn EventSink>,
    state: &SerialManager,
    req: ApiPcanSendReq,
) -> Result<usize, String> {
    let sid = resolve_session_id(state, req.session_id);

    let bytes = if let Some(raw) = req.data {
        raw
    } else if let Some(hex_str) = req.data_hex {
        parse_hex_string(&hex_str)?
    } else {
        Vec::new()
    };

    if bytes.len() > 8 {
        return Err(format!(
            "Classic CAN 數據長度最多 8 Bytes（目前 {} Bytes）",
            bytes.len()
        ));
    }

    let frame = PcanTxFrameDto {
        id: req.id,
        extended: req.extended.unwrap_or(false),
        rtr: req.rtr.unwrap_or(false),
        data: bytes.clone(),
    };

    let len = write_pcan_frame_internal(state, sid.clone(), frame.clone())?;

    sink.emit(TransportEvent::ExternalPcanTx {
        session_id: sid,
        id: frame.id,
        extended: frame.extended,
        rtr: frame.rtr,
        dlc: bytes.len(),
        data: bytes,
    });

    Ok(len)
}

fn parse_hex_string(input: &str) -> Result<Vec<u8>, String> {
    let clean: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ',' && *c != '-')
        .collect();
    let clean = clean.trim_start_matches("0x").trim_start_matches("0X");
    if clean.len() % 2 != 0 {
        return Err("Hex 字符數量必須為偶數".to_string());
    }
    let mut bytes = Vec::with_capacity(clean.len() / 2);
    for i in (0..clean.len()).step_by(2) {
        let b = u8::from_str_radix(&clean[i..i + 2], 16)
            .map_err(|e| format!("無效的 Hex 格式 '{}': {}", &clean[i..i + 2], e))?;
        bytes.push(b);
    }
    Ok(bytes)
}
