(function (global) {
  const HEX2_TABLE = Array.from({ length: 256 }, (_, i) =>
    i.toString(16).toUpperCase().padStart(2, "0")
  );
  const ASCII_TABLE = Array.from({ length: 256 }, (_, i) =>
    i >= 0x20 && i <= 0x7e ? String.fromCharCode(i) : "."
  );

  const toHex2 = (b) => HEX2_TABLE[b & 0xff];
  const toHex8 = (n) => n.toString(16).toUpperCase().padStart(8, "0");
  const toPrintableAscii = (b) => ASCII_TABLE[b & 0xff];

  const bytesToHexString = (bytes, wrap16 = false) => {
    if (!bytes || bytes.length === 0) return "";
    if (!wrap16) {
      return bytes.map(toHex2).join(" ");
    }
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const slice = bytes.slice(i, i + 16);
      lines.push(slice.map(toHex2).join(" "));
    }
    return lines.join("\n");
  };

  const bytesToUtf8Text = (bytes) => {
    if (!bytes || bytes.length === 0) return "";
    try {
      return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
    } catch {
      return bytes.map((b) => String.fromCharCode(b)).join("");
    }
  };

  const utf8TextToBytes = (text) => Array.from(new TextEncoder().encode(text));

  const parseHexInput = (raw) => {
    const cleaned = String(raw || "").replace(/[^0-9a-fA-F]/g, "");
    const bytes = [];
    for (let i = 0; i < cleaned.length; i += 2) {
      const pair = cleaned.substring(i, i + 2);
      bytes.push(parseInt(pair, 16));
    }
    return {
      bytes,
      hasOddNibble: cleaned.length % 2 !== 0,
    };
  };

  const formatDateToTimeStr = (d) => {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  };

  const formatTimestamp = () => formatDateToTimeStr(new Date());

  const api = {
    HEX2_TABLE,
    ASCII_TABLE,
    toHex2,
    toHex8,
    toPrintableAscii,
    bytesToHexString,
    bytesToUtf8Text,
    utf8TextToBytes,
    parseHexInput,
    formatDateToTimeStr,
    formatTimestamp,
  };

  global.PortAssist = global.PortAssist || {};
  global.PortAssist.codec = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
