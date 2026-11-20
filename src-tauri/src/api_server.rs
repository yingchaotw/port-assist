use crate::main_helpers::{
    close_session_by_id, get_active_sessions_summary, list_all_devices, open_pcan_from_api,
    open_serial_from_api, send_pcan_from_api, send_serial_from_api, ApiPcanOpenReq,
    ApiPcanSendReq, ApiSerialOpenReq, ApiSerialSendReq,
};
use crate::SerialManager;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub fn start_api_server(app: AppHandle, is_running: Arc<AtomicBool>) {
    thread::spawn(move || {
        let bind_addr = "127.0.0.1:18080";
        let listener = match TcpListener::bind(bind_addr) {
            Ok(l) => {
                eprintln!("[PortAssist API] Server successfully listening on http://{}", bind_addr);
                l
            }
            Err(e) => {
                eprintln!("[PortAssist API] Failed to bind to {}: {}", bind_addr, e);
                return;
            }
        };

        let _ = listener.set_nonblocking(true);

        while is_running.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let app_clone = app.clone();
                    thread::spawn(move || {
                        handle_connection(stream, app_clone);
                    });
                }
                Err(ref e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(e) => {
                    eprintln!("[PortAssist API] Accept error: {}", e);
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
        eprintln!("[PortAssist API] Server stopped.");
    });
}

fn handle_connection(mut stream: TcpStream, app: AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));

    let mut buf = Vec::with_capacity(4096);
    let mut temp = [0u8; 1024];
    let mut header_end_pos = None;

    loop {
        match stream.read(&mut temp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&temp[..n]);
                if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
                    header_end_pos = Some(pos);
                    break;
                }
                if buf.len() > 65536 {
                    send_response(&mut stream, 413, "Payload Too Large", b"Request too large");
                    return;
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                break;
            }
            Err(_) => return,
        }
    }

    let header_end = match header_end_pos {
        Some(pos) => pos,
        None => {
            send_response(&mut stream, 400, "Bad Request", b"Malformed HTTP request");
            return;
        }
    };

    let header_bytes = &buf[..header_end];
    let header_str = match std::str::from_utf8(header_bytes) {
        Ok(s) => s,
        Err(_) => {
            send_response(&mut stream, 400, "Bad Request", b"Invalid UTF-8 in headers");
            return;
        }
    };

    let mut lines = header_str.lines();
    let request_line = match lines.next() {
        Some(l) => l,
        None => return,
    };

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let full_path = parts.next().unwrap_or("/");

    if method == "OPTIONS" {
        send_cors_preflight(&mut stream);
        return;
    }

    let (path, query) = match full_path.split_once('?') {
        Some((p, q)) => (p, q),
        None => (full_path, ""),
    };

    // Find Content-Length
    let mut content_length = 0usize;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                if let Ok(len) = v.trim().parse::<usize>() {
                    content_length = len;
                }
            }
        }
    }

    let body_start = header_end + 4;
    let mut body_bytes = buf[body_start..].to_vec();
    while body_bytes.len() < content_length {
        match stream.read(&mut temp) {
            Ok(0) => break,
            Ok(n) => {
                body_bytes.extend_from_slice(&temp[..n]);
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                break;
            }
            Err(_) => break,
        }
    }

    let state = app.state::<SerialManager>();

    match (method, path) {
        ("GET", "/api/status") => {
            let sessions = get_active_sessions_summary(&state);
            let resp = json!({
                "status": "ok",
                "sessions": sessions,
            });
            send_json_response(&mut stream, 200, &resp);
        }

        ("GET", "/api/devices") => {
            let devs = list_all_devices();
            send_json_response(&mut stream, 200, &devs);
        }

        ("POST", "/api/open_serial") => {
            match serde_json::from_slice::<ApiSerialOpenReq>(&body_bytes) {
                Ok(req) => match open_serial_from_api(&app, &state, req) {
                    Ok(msg) => {
                        send_json_response(&mut stream, 200, &json!({"status": "ok", "message": msg}));
                    }
                    Err(e) => {
                        send_json_response(&mut stream, 400, &json!({"status": "error", "error": e}));
                    }
                },
                Err(e) => {
                    send_json_response(&mut stream, 400, &json!({"status": "error", "error": format!("Invalid JSON: {}", e)}));
                }
            }
        }

        ("POST", "/api/open_pcan") => {
            match serde_json::from_slice::<ApiPcanOpenReq>(&body_bytes) {
                Ok(req) => match open_pcan_from_api(&app, &state, req) {
                    Ok(msg) => {
                        send_json_response(&mut stream, 200, &json!({"status": "ok", "message": msg}));
                    }
                    Err(e) => {
                        send_json_response(&mut stream, 400, &json!({"status": "error", "error": e}));
                    }
                },
                Err(e) => {
                    send_json_response(&mut stream, 400, &json!({"status": "error", "error": format!("Invalid JSON: {}", e)}));
                }
            }
        }

        ("POST", "/api/close") => {
            let session_id_opt = serde_json::from_slice::<serde_json::Value>(&body_bytes)
                .ok()
                .and_then(|v| v.get("sessionId").and_then(|s| s.as_str()).map(|s| s.to_string()));

            match close_session_by_id(&app, &state, session_id_opt) {
                Ok(msg) => {
                    send_json_response(&mut stream, 200, &json!({"status": "ok", "message": msg}));
                }
                Err(e) => {
                    send_json_response(&mut stream, 400, &json!({"status": "error", "error": e}));
                }
            }
        }

        ("POST", "/api/send_serial") => {
            match serde_json::from_slice::<ApiSerialSendReq>(&body_bytes) {
                Ok(req) => match send_serial_from_api(&app, &state, req) {
                    Ok(bytes_sent) => {
                        send_json_response(&mut stream, 200, &json!({"status": "ok", "bytesSent": bytes_sent}));
                    }
                    Err(e) => {
                        send_json_response(&mut stream, 400, &json!({"status": "error", "error": e}));
                    }
                },
                Err(e) => {
                    send_json_response(&mut stream, 400, &json!({"status": "error", "error": format!("Invalid JSON: {}", e)}));
                }
            }
        }

        ("POST", "/api/send_pcan") => {
            match serde_json::from_slice::<ApiPcanSendReq>(&body_bytes) {
                Ok(req) => match send_pcan_from_api(&app, &state, req) {
                    Ok(bytes_sent) => {
                        send_json_response(&mut stream, 200, &json!({"status": "ok", "bytesSent": bytes_sent}));
                    }
                    Err(e) => {
                        send_json_response(&mut stream, 400, &json!({"status": "error", "error": e}));
                    }
                },
                Err(e) => {
                    send_json_response(&mut stream, 400, &json!({"status": "error", "error": format!("Invalid JSON: {}", e)}));
                }
            }
        }

        ("GET", "/api/rx") => {
            let query_map = parse_query(query);
            let limit = query_map
                .get("limit")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(50)
                .min(200);
            let kind = query_map.get("kind").map(|s| s.as_str()).unwrap_or("all");
            let should_clear = query_map
                .get("clear")
                .map(|s| s == "true" || s == "1")
                .unwrap_or(false);

            let records: Vec<_> = if let Ok(mut hist) = state.rx_history.lock() {
                let filtered: Vec<_> = hist
                    .iter()
                    .filter(|r| kind == "all" || r.kind.eq_ignore_ascii_case(kind))
                    .rev()
                    .take(limit)
                    .cloned()
                    .collect();
                if should_clear {
                    hist.clear();
                }
                filtered.into_iter().rev().collect()
            } else {
                Vec::new()
            };

            send_json_response(&mut stream, 200, &json!({"records": records}));
        }

        ("POST", "/api/clear_rx") => {
            if let Ok(mut hist) = state.rx_history.lock() {
                hist.clear();
            }
            send_json_response(&mut stream, 200, &json!({"status": "ok"}));
        }

        _ => {
            send_response(&mut stream, 404, "Not Found", b"404 Not Found");
        }
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            map.insert(k.to_string(), v.to_string());
        }
    }
    map
}

fn send_cors_preflight(stream: &mut TcpStream) {
    let resp = "HTTP/1.1 204 No Content\r\n\
                Access-Control-Allow-Origin: *\r\n\
                Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
                Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
                Content-Length: 0\r\n\
                Connection: close\r\n\r\n";
    let _ = stream.write_all(resp.as_bytes());
}

fn send_json_response(stream: &mut TcpStream, status_code: u16, value: &serde_json::Value) {
    let body = serde_json::to_vec(value).unwrap_or_default();
    let status_text = match status_code {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Response",
    };
    send_response(stream, status_code, status_text, &body);
}

fn send_response(stream: &mut TcpStream, status_code: u16, status_text: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {} {}\r\n\
        Content-Type: application/json; charset=utf-8\r\n\
        Access-Control-Allow-Origin: *\r\n\
        Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
        Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
        Content-Length: {}\r\n\
        Connection: close\r\n\r\n",
        status_code,
        status_text,
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
}
