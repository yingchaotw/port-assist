/// Format a byte slice as uppercase space-separated hex (e.g. `"01 03 00"`).
pub fn bytes_to_hex_string(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(bytes.len() * 3 - 1);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        use std::fmt::Write;
        let _ = write!(out, "{:02X}", b);
    }
    out
}

/// Convert a byte slice to printable ASCII (`0x20..=0x7E`, others replaced with `'.'`).
pub fn format_printable_ascii(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| {
            if (0x20..=0x7e).contains(&b) {
                b as char
            } else {
                '.'
            }
        })
        .collect()
}

/// Parse a hex string (allowing whitespace, `,`, `-`, and optional `0x` prefix) into bytes.
pub fn parse_hex_string(input: &str) -> Result<Vec<u8>, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hex_roundtrip_and_ascii() {
        let data = [0x01, 0x0A, 0x41, 0x7E, 0xFF];
        assert_eq!(bytes_to_hex_string(&data), "01 0A 41 7E FF");
        assert_eq!(format_printable_ascii(&data), "..A~.");
        assert_eq!(parse_hex_string("0x01 0a-41,7E ff").unwrap(), data);
        assert!(parse_hex_string("01A").is_err());
    }
}
