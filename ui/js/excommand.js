(function (global) {
  const codec =
    (global.PortAssist && global.PortAssist.codec) ||
    (typeof require !== "undefined" ? require("./codec") : null);

  const DEFAULT_SCPI_TEMPLATES = [
    { enabled: true, name: "查詢設備型號 (IDN)", format: "ASCII", payload: "*IDN?\\r\\n" },
    { enabled: true, name: "清除錯誤暫存器 (CLS)", format: "ASCII", payload: "*CLS\\r\\n" },
    { enabled: true, name: "查詢系統錯誤 (ERR)", format: "ASCII", payload: ":SYST:ERR?\\r\\n" },
    { enabled: true, name: "量測即時電壓 (Volt)", format: "ASCII", payload: ":MEAS:VOLT?\\r\\n" },
    { enabled: true, name: "量測即時電流 (Curr)", format: "ASCII", payload: ":MEAS:CURR?\\r\\n" },
    { enabled: false, name: "量測即時功率 (Power)", format: "ASCII", payload: ":MEAS:POW?\\r\\n" },
    { enabled: false, name: "查詢輸出狀態 (Output)", format: "ASCII", payload: ":OUTP?\\r\\n" },
    { enabled: false, name: "設備復位 (Reset)", format: "ASCII", payload: "*RST\\r\\n" },
  ];

  function parseDataListRowPayload(row) {
    if (row.format === "HEX") {
      return codec.parseHexInput(row.payload).bytes;
    }
    const unescaped = String(row.payload || "")
      .replace(/\\r/g, "\r")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
    return codec.utf8TextToBytes(unescaped);
  }

  function parseExCommandIni(text) {
    const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (i === 0 && trimmed === "Serial Assistant ExCommand") continue;

      const firstComma = rawLine.indexOf(",");
      if (firstComma === -1) continue;
      const secondComma = rawLine.indexOf(",", firstComma + 1);
      if (secondComma === -1) continue;

      const isHex = rawLine.slice(0, firstComma).trim().toLowerCase() === "true";
      const addNewline = rawLine.slice(firstComma + 1, secondComma).trim().toLowerCase() === "true";
      const rest = rawLine.slice(secondComma + 1);

      const notesMarker = "((:Notes:))";
      const notesIdx = rest.indexOf(notesMarker);
      let payload = notesIdx >= 0 ? rest.slice(0, notesIdx) : rest;
      const note = notesIdx >= 0 ? rest.slice(notesIdx + notesMarker.length).trim() : "";

      if (payload.trim().length === 0 && note.length === 0) continue;

      const format = isHex ? "HEX" : "ASCII";
      if (format === "HEX") {
        payload = payload.trim();
        if (addNewline && payload.length > 0 && !/0d\s+0a$/i.test(payload)) {
          payload = `${payload} 0D 0A`;
        }
      } else {
        if (
          addNewline &&
          payload.length > 0 &&
          !payload.endsWith("\\r\\n") &&
          !payload.endsWith("\\n")
        ) {
          payload = `${payload}\\r\\n`;
        }
      }

      rows.push({
        enabled: payload.trim().length > 0,
        name: note,
        format,
        payload,
      });
    }
    return rows;
  }

  function serializeExCommandIni(rows) {
    const lines = ["Serial Assistant ExCommand"];
    for (const row of rows || []) {
      const isHex = row.format === "HEX";
      let payload = row.payload ?? "";
      let addNewline = false;

      if (isHex) {
        payload = payload.trim();
      } else if (payload.endsWith("\\r\\n")) {
        addNewline = true;
        payload = payload.slice(0, -4);
      }

      const notePart =
        row.name && row.name.trim().length > 0 ? `((:Notes:))${row.name.trim()}` : "";
      lines.push(
        `${isHex ? "True" : "False"},${addNewline ? "True" : "False"},${payload}${notePart}`
      );
    }
    return lines.join("\r\n") + "\r\n";
  }

  const api = {
    DEFAULT_SCPI_TEMPLATES,
    parseDataListRowPayload,
    parseExCommandIni,
    serializeExCommandIni,
  };

  global.PortAssist = global.PortAssist || {};
  global.PortAssist.excommand = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
