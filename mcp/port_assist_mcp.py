#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PortAssist Model Context Protocol (MCP) Server
Allows AI Agents (Claude Desktop, Cursor, Antigravity, etc.) to interact with
Hardware Serial COM ports and PCAN-USB CAN 2.0 channels via PortAssist.

Zero external pip dependencies: uses standard library only.
"""

import sys
import json
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional

PORTASSIST_API_BASE = "http://127.0.0.1:18080/api"

TOOLS = [
    {
        "name": "portassist_status",
        "description": "Check PortAssist application status, currently open sessions (COM port or PCAN channel), and connection health.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "portassist_list_devices",
        "description": "List all hardware Serial COM ports and PCAN-USB hardware channels currently connected to this PC.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "portassist_connect_pcan",
        "description": "Open and connect to a PCAN-USB channel (e.g., PCAN_USBBUS1) at a specified baud rate (e.g. 500000). The PortAssist GUI will synchronize and display incoming frames in real-time.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "channel": {
                    "type": "string",
                    "description": "PCAN channel handle name, e.g. 'PCAN_USBBUS1' (default: 'PCAN_USBBUS1')"
                },
                "baud_rate": {
                    "type": "integer",
                    "description": "CAN Bitrate in bps (e.g. 500000 for 500 kbps, 250000, 1000000). Default: 500000"
                }
            },
            "required": []
        }
    },
    {
        "name": "portassist_connect_serial",
        "description": "Open and connect to a Serial COM port (RS232/422/485) with configurable baud rate and serial parameters.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "port_name": {
                    "type": "string",
                    "description": "COM port name, e.g. 'COM1', 'COM3' or '/dev/ttyUSB0'"
                },
                "baud_rate": {
                    "type": "integer",
                    "description": "Baud rate (e.g. 115200, 9600, 38400). Default: 115200"
                },
                "parity": {
                    "type": "string",
                    "enum": ["None", "Odd", "Even"],
                    "description": "Parity bit. Default: 'None'"
                },
                "data_bits": {
                    "type": "integer",
                    "enum": [5, 6, 7, 8],
                    "description": "Data bits. Default: 8"
                },
                "stop_bits": {
                    "type": "integer",
                    "enum": [1, 2],
                    "description": "Stop bits. Default: 1"
                }
            },
            "required": ["port_name"]
        }
    },
    {
        "name": "portassist_disconnect",
        "description": "Close the currently active Serial or PCAN communication session.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "Optional session ID to close. If omitted, closes the active session."
                }
            },
            "required": []
        }
    },
    {
        "name": "portassist_send_can",
        "description": "Transmit a CAN 2.0 frame through the connected PCAN-USB channel. The sent frame will be immediately rendered in the PortAssist user interface.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "CAN ID in hex (e.g. '123', '0x123', '18FF1234') or decimal integer string"
                },
                "data_hex": {
                    "type": "string",
                    "description": "CAN payload bytes in hex string (0 to 8 bytes), e.g. '01 02 03 04 05 06 07 08' or '01020304'"
                },
                "extended": {
                    "type": "boolean",
                    "description": "True for 29-bit CAN ID (Extended Frame), false for standard 11-bit ID. Default: false"
                },
                "rtr": {
                    "type": "boolean",
                    "description": "True for Remote Transmission Request (RTR) frame. Default: false"
                }
            },
            "required": ["id"]
        }
    },
    {
        "name": "portassist_send_serial",
        "description": "Transmit raw text or hex bytes through the connected Serial COM port.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "ASCII / UTF-8 string to send (optional if data_hex is provided)"
                },
                "data_hex": {
                    "type": "string",
                    "description": "Hex byte string to send (e.g. 'AA BB 01 02'), optional if text is provided"
                },
                "append_crlf": {
                    "type": "boolean",
                    "description": "Whether to append \\r\\n (CRLF) at the end. Default: false"
                }
            },
            "required": []
        }
    },
    {
        "name": "portassist_read_rx",
        "description": "Retrieve recently received packets or CAN frames from PortAssist's receive buffer.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of recent records to return (1-200). Default: 50"
                },
                "kind": {
                    "type": "string",
                    "enum": ["all", "pcan", "serial", "net"],
                    "description": "Filter by kind: 'all', 'pcan', 'serial', or 'net'. Default: 'all'"
                },
                "clear": {
                    "type": "boolean",
                    "description": "Whether to clear the receive buffer after fetching. Default: false"
                }
            },
            "required": []
        }
    },
    {
        "name": "portassist_clear_rx",
        "description": "Clear PortAssist's internal receive buffer.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    }
]


def call_api(endpoint: str, method: str = "GET", payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = f"{PORTASSIST_API_BASE}/{endpoint.lstrip('/')}"
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            body = response.read().decode("utf-8")
            if not body:
                return {"status": "ok"}
            return json.loads(body)
    except urllib.error.URLError as e:
        if "refused" in str(e).lower() or "10061" in str(e):
            raise RuntimeError(
                "⚠️ PortAssist 未在執行中 (無法連線至 http://127.0.0.1:18080)。\n"
                "請先啟動 PortAssist 應用程式 (port-assist.exe)，再由 AI 進行硬體控制與收發。"
            )
        raise RuntimeError(f"PortAssist API 連線失敗 ({endpoint}): {e}")
    except Exception as e:
        raise RuntimeError(f"PortAssist 呼叫錯誤: {e}")


def handle_tool_call(name: str, arguments: Dict[str, Any]) -> str:
    if name == "portassist_status":
        res = call_api("status")
        sessions = res.get("sessions", [])
        if not sessions:
            return "PortAssist 運作正常，目前沒有任何開啟中的通訊連線 (閒置狀態)。"
        lines = ["PortAssist 運作正常，目前連線狀態："]
        for s in sessions:
            lines.append(f"- 階段 ID: {s.get('sessionId')}, 通訊埠/通道: {s.get('portName')}, 狀態: {'連線中' if s.get('isOpen') else '已關閉'}")
        return "\n".join(lines)

    elif name == "portassist_list_devices":
        res = call_api("devices")
        serials = res.get("serial", [])
        pcans = res.get("pcan", [])
        lines = ["【偵測到的硬體設備】"]
        lines.append("\n■ 實體串口 (COM Ports):")
        if serials:
            for s in serials:
                lines.append(f"  • {s.get('label', s.get('name'))}")
        else:
            lines.append("  (未偵測到串口)")

        lines.append("\n■ PCAN-USB 硬體通道:")
        if pcans:
            for p in pcans:
                lines.append(f"  • {p.get('label', p.get('name'))}")
        else:
            lines.append("  (未偵測到 PCAN 硬體)")
        return "\n".join(lines)

    elif name == "portassist_connect_pcan":
        channel = arguments.get("channel", "PCAN_USBBUS1")
        baud_rate = int(arguments.get("baud_rate", 500000))
        res = call_api("open_pcan", method="POST", payload={"channel": channel, "baudRate": baud_rate})
        if res.get("error"):
            return f"❌ PCAN 連線失敗: {res['error']}"
        return f"✅ PCAN 連線成功！已連接硬體通道 {channel} @ {baud_rate} bps。\nPortAssist 畫面已同步切換，收發數據皆會即時在畫面上更新。"

    elif name == "portassist_connect_serial":
        port_name = arguments.get("port_name", "")
        baud_rate = int(arguments.get("baud_rate", 115200))
        parity = arguments.get("parity", "None")
        data_bits = int(arguments.get("data_bits", 8))
        stop_bits = int(arguments.get("stop_bits", 1))
        res = call_api("open_serial", method="POST", payload={
            "portName": port_name,
            "baudRate": baud_rate,
            "parity": parity,
            "dataBits": data_bits,
            "stopBits": stop_bits,
            "flowControl": "None"
        })
        if res.get("error"):
            return f"❌ 串口連線失敗: {res['error']}"
        return f"✅ 串口連線成功！已開啟 {port_name} @ {baud_rate} bps ({data_bits},{parity[0] if parity else 'N'},{stop_bits})。\nPortAssist 畫面已同步連線。"

    elif name == "portassist_disconnect":
        session_id = arguments.get("session_id")
        res = call_api("close", method="POST", payload={"sessionId": session_id})
        if res.get("error"):
            return f"❌ 關閉連線失敗: {res['error']}"
        return "✅ 已成功中斷硬體通訊連線。"

    elif name == "portassist_send_can":
        raw_id = arguments.get("id")
        if isinstance(raw_id, str):
            clean_id = raw_id.strip()
            if clean_id.lower().startswith("0x"):
                can_id = int(clean_id, 16)
            else:
                can_id = int(clean_id, 16) if any(c in "abcdefABCDEF" for c in clean_id) else int(clean_id)
        else:
            can_id = int(raw_id)

        data_hex = arguments.get("data_hex", "").replace(" ", "").replace(",", "").replace("0x", "")
        extended = bool(arguments.get("extended", False))
        rtr = bool(arguments.get("rtr", False))

        res = call_api("send_pcan", method="POST", payload={
            "id": can_id,
            "dataHex": data_hex,
            "extended": extended,
            "rtr": rtr
        })
        if res.get("error"):
            return f"❌ 發送 CAN 幀失敗: {res['error']}"

        id_str = f"0x{can_id:08X}" if extended else f"0x{can_id:03X}"
        formatted_data = " ".join([data_hex[i:i+2].upper() for i in range(0, len(data_hex), 2)]) or "(無數據/RTR)"
        return f"✅ CAN 幀傳送成功！\n- ID: {id_str} ({'Extended 29-bit' if extended else 'Standard 11-bit'})\n- 類型: {'RTR' if rtr else 'Data'}\n- 數據: {formatted_data}\n（PortAssist 畫面已同步記錄）"

    elif name == "portassist_send_serial":
        text = arguments.get("text")
        data_hex = arguments.get("data_hex")
        append_crlf = bool(arguments.get("append_crlf", False))

        payload = {"appendCrlf": append_crlf}
        if text is not None:
            payload["text"] = text
        if data_hex is not None:
            payload["dataHex"] = data_hex

        res = call_api("send_serial", method="POST", payload=payload)
        if res.get("error"):
            return f"❌ 串口傳送失敗: {res['error']}"
        bytes_sent = res.get("bytesSent", 0)
        return f"✅ 串口數據傳送成功 (已傳送 {bytes_sent} Bytes)。\n（PortAssist 畫面已同步記錄）"

    elif name == "portassist_read_rx":
        limit = int(arguments.get("limit", 50))
        kind = arguments.get("kind", "all")
        clear = bool(arguments.get("clear", False))

        res = call_api(f"rx?limit={limit}&kind={kind}&clear={'true' if clear else 'false'}")
        records = res.get("records", [])
        if not records:
            return "緩衝區內無新接收的數據。"

        lines = [f"【共讀取到 {len(records)} 筆接收記錄】"]
        for r in records:
            kind_str = r.get("kind", "").upper()
            if kind_str == "PCAN":
                id_hex = r.get("idHex", "")
                data_hex = r.get("dataHex", "")
                ext_str = "Ext" if r.get("extended") else "Std"
                rtr_str = " RTR" if r.get("rtr") else ""
                lines.append(f"[{kind_str}] ID:0x{id_hex} ({ext_str}{rtr_str}) DLC:{r.get('dlc', 0)} Data: [{data_hex}]")
            else:
                hex_str = r.get("dataHex", "")
                txt_str = r.get("text", "")
                txt_display = f" | ASCII: '{txt_str}'" if txt_str and any(c.isprintable() for c in txt_str) else ""
                lines.append(f"[{kind_str}] Hex: [{hex_str}]{txt_display}")

        return "\n".join(lines)

    elif name == "portassist_clear_rx":
        res = call_api("clear_rx", method="POST", payload={})
        return "✅ 已清空接收緩衝區記錄。"

    else:
        raise ValueError(f"未知的工具: {name}")


def main():
    """Main JSON-RPC stdio loop for Model Context Protocol"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue

        req_id = req.get("id")
        method = req.get("method")
        params = req.get("params", {})

        if method == "initialize":
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {}
                    },
                    "serverInfo": {
                        "name": "port-assist-mcp",
                        "version": "1.0.0"
                    }
                }
            }
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()

        elif method == "notifications/initialized":
            # Client notification - no response required
            pass

        elif method == "ping":
            resp = {"jsonrpc": "2.0", "id": req_id, "result": {}}
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()

        elif method == "tools/list":
            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "tools": TOOLS
                }
            }
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()

        elif method == "tools/call":
            tool_name = params.get("name")
            tool_args = params.get("arguments", {})
            try:
                result_text = handle_tool_call(tool_name, tool_args)
                is_error = False
            except Exception as e:
                result_text = str(e)
                is_error = True

            resp = {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": result_text
                        }
                    ],
                    "isError": is_error
                }
            }
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()

        else:
            if req_id is not None:
                resp = {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32601,
                        "message": f"Method not found: {method}"
                    }
                }
                sys.stdout.write(json.dumps(resp) + "\n")
                sys.stdout.flush()


if __name__ == "__main__":
    main()
