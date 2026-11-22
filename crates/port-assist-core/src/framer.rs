use crate::codec::bytes_to_hex_string;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum FrameDirection {
    Rx,
    Tx,
}

impl FrameDirection {
    pub fn as_str(&self) -> &'static str {
        match self {
            FrameDirection::Rx => "RX",
            FrameDirection::Tx => "TX",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FrameRule {
    TimeoutMaxlen,
    Delimiter,
    FixedLen,
}

impl Default for FrameRule {
    fn default() -> Self {
        Self::TimeoutMaxlen
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramingConfig {
    pub enabled: bool,
    pub rule: FrameRule,
    pub timeout_ms: f64,
    pub max_len: usize,
    pub delim_bytes: Vec<u8>,
    pub baud_rate: u32,
    pub show_tx_inline: bool,
    pub is_pcan: bool,
}

impl Default for FramingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            rule: FrameRule::TimeoutMaxlen,
            timeout_ms: 20.0,
            max_len: 0,
            delim_bytes: vec![0x0d, 0x0a],
            baud_rate: 115_200,
            show_tx_inline: true,
            is_pcan: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawChunk {
    pub dir: FrameDirection,
    pub bytes: Vec<u8>,
    pub perf_ms: f64,
    pub can_meta: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentedFrame {
    pub id: usize,
    pub dir: FrameDirection,
    pub start_idx: usize,
    pub length: usize,
    pub closed: bool,
    pub perf_ms: f64,
    pub last_perf_ms: f64,
    pub can_meta: Option<String>,
    #[serde(skip)]
    fixed_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedRowEntry {
    pub key: String,
    pub id_str: String,
    pub raw_id: u64,
    pub type_str: String,
    pub dlc: usize,
    pub data: Vec<u8>,
    pub prev_data: Vec<u8>,
    pub count: u64,
    pub last_perf_ms: f64,
    pub cycle_ms: f64,
}

/// Pure Rust O(1) incremental frame segmentation & Fixed-table grouping engine.
#[derive(Debug, Default)]
pub struct FrameEngine {
    pub config: FramingConfig,
    pub view_bytes: Vec<u8>,
    pub byte_frame_ids: Vec<usize>,
    pub frames: Vec<SegmentedFrame>,
    pub raw_chunks: Vec<RawChunk>,
    pub fixed_map: HashMap<String, FixedRowEntry>,
}

impl FrameEngine {
    pub fn new(config: FramingConfig) -> Self {
        Self {
            config,
            ..Default::default()
        }
    }

    pub fn clear(&mut self) {
        self.view_bytes.clear();
        self.byte_frame_ids.clear();
        self.frames.clear();
        self.raw_chunks.clear();
        self.fixed_map.clear();
    }

    pub fn recalculate(&mut self, config: FramingConfig) {
        self.config = config;
        let chunks = std::mem::take(&mut self.raw_chunks);
        self.view_bytes.clear();
        self.byte_frame_ids.clear();
        self.frames.clear();
        if !self.config.is_pcan {
            self.fixed_map.clear();
        }
        for chunk in chunks {
            self.push_chunk(chunk);
        }
    }

    pub fn push_chunk(&mut self, chunk: RawChunk) {
        if chunk.bytes.is_empty() {
            return;
        }
        self.raw_chunks.push(chunk.clone());
        self.append_chunk_internal(&chunk);
    }

    fn append_chunk_internal(&mut self, chunk: &RawChunk) {
        let len = chunk.bytes.len();
        if len == 0 {
            return;
        }

        if chunk.dir == FrameDirection::Tx {
            if !self.config.show_tx_inline {
                return;
            }
            let start_idx = self.view_bytes.len();
            self.view_bytes.extend_from_slice(&chunk.bytes);
            let fid = self.frames.len();
            self.byte_frame_ids.extend(std::iter::repeat_n(fid, len));
            self.frames.push(SegmentedFrame {
                id: fid,
                dir: FrameDirection::Tx,
                start_idx,
                length: len,
                closed: true,
                perf_ms: chunk.perf_ms,
                last_perf_ms: chunk.perf_ms,
                can_meta: chunk.can_meta.clone(),
                fixed_key: None,
            });
            if !self.config.is_pcan {
                self.upsert_fixed_for_frame(FrameDirection::Tx, &chunk.bytes, chunk.perf_ms, None);
            }
            return;
        }

        let use_timeout = self.config.enabled
            && matches!(self.config.rule, FrameRule::TimeoutMaxlen | FrameRule::Delimiter)
            && self.config.timeout_ms > 0.0;
        let timeout_ms = self.config.timeout_ms.max(1.0);
        let max_len = if !self.config.enabled {
            0
        } else if self.config.rule == FrameRule::FixedLen {
            self.config.max_len.max(1)
        } else {
            self.config.max_len
        };
        let delim = if self.config.enabled && self.config.rule == FrameRule::Delimiter {
            self.config.delim_bytes.as_slice()
        } else {
            &[]
        };

        if let Some(tail) = self.frames.last_mut() {
            if tail.dir == FrameDirection::Rx
                && !tail.closed
                && use_timeout
                && (chunk.perf_ms - tail.last_perf_ms) > timeout_ms
            {
                tail.closed = true;
            }
        }

        let baud = self.config.baud_rate.max(300) as f64;
        let ms_per_byte = 10_000.0 / baud;

        if delim.is_empty() {
            let mut offset = 0usize;
            while offset < len {
                let need_new = match self.frames.last() {
                    Some(f) => f.closed || f.dir != FrameDirection::Rx,
                    None => true,
                };
                if need_new {
                    let fid = self.frames.len();
                    let t = chunk.perf_ms + (offset as f64) * ms_per_byte;
                    self.frames.push(SegmentedFrame {
                        id: fid,
                        dir: FrameDirection::Rx,
                        start_idx: self.view_bytes.len(),
                        length: 0,
                        closed: false,
                        perf_ms: t,
                        last_perf_ms: t,
                        can_meta: chunk.can_meta.clone(),
                        fixed_key: None,
                    });
                }

                let fid = self.frames.len() - 1;
                let cur_len = self.frames[fid].length;
                let remaining = len - offset;
                let take = if max_len > 0 {
                    remaining.min(max_len.saturating_sub(cur_len).max(1))
                } else {
                    remaining
                };
                let end_offset = offset + take;

                self.view_bytes.extend_from_slice(&chunk.bytes[offset..end_offset]);
                self.byte_frame_ids.extend(std::iter::repeat_n(fid, take));

                let frame = &mut self.frames[fid];
                frame.length += take;
                frame.last_perf_ms = chunk.perf_ms + (end_offset as f64) * ms_per_byte;
                if max_len > 0 && frame.length >= max_len {
                    frame.closed = true;
                }

                if !self.config.is_pcan {
                    let start = self.frames[fid].start_idx;
                    let flen = self.frames[fid].length;
                    let last_ms = self.frames[fid].last_perf_ms;
                    let slice = self.view_bytes[start..start + flen].to_vec();
                    self.upsert_fixed_for_frame(FrameDirection::Rx, &slice, last_ms, Some(fid));
                }

                offset = end_offset;
            }
            return;
        }

        let mut touched = Vec::new();
        for (i, &b) in chunk.bytes.iter().enumerate() {
            let need_new = match self.frames.last() {
                Some(f) => f.closed || f.dir != FrameDirection::Rx,
                None => true,
            };
            if need_new {
                let fid = self.frames.len();
                let t = chunk.perf_ms + (i as f64) * ms_per_byte;
                self.frames.push(SegmentedFrame {
                    id: fid,
                    dir: FrameDirection::Rx,
                    start_idx: self.view_bytes.len(),
                    length: 0,
                    closed: false,
                    perf_ms: t,
                    last_perf_ms: t,
                    can_meta: chunk.can_meta.clone(),
                    fixed_key: None,
                });
            }

            let fid = self.frames.len() - 1;
            if touched.last().copied() != Some(fid) {
                touched.push(fid);
            }

            self.view_bytes.push(b);
            self.byte_frame_ids.push(fid);

            let frame = &mut self.frames[fid];
            frame.length += 1;
            frame.last_perf_ms = chunk.perf_ms;

            if max_len > 0 && frame.length >= max_len {
                frame.closed = true;
            } else if frame.length >= delim.len() {
                let base = self.view_bytes.len() - delim.len();
                if &self.view_bytes[base..] == delim {
                    frame.closed = true;
                }
            }
        }

        if !self.config.is_pcan {
            for fid in touched {
                let start = self.frames[fid].start_idx;
                let flen = self.frames[fid].length;
                let last_ms = self.frames[fid].last_perf_ms;
                let slice = self.view_bytes[start..start + flen].to_vec();
                self.upsert_fixed_for_frame(FrameDirection::Rx, &slice, last_ms, Some(fid));
            }
        }
    }

    fn upsert_fixed_for_frame(
        &mut self,
        dir: FrameDirection,
        frame_bytes: &[u8],
        perf_ms: f64,
        frame_idx: Option<usize>,
    ) {
        let (key, id_str, raw_id) = derive_fixed_identity(dir, frame_bytes);
        let data_slice = frame_bytes[..frame_bytes.len().min(32)].to_vec();

        if let Some(fid) = frame_idx {
            if let Some(prev_key) = self.frames[fid].fixed_key.as_ref() {
                if prev_key != &key {
                    if let Some(prev_entry) = self.fixed_map.get(prev_key) {
                        if prev_entry.count <= 1 {
                            self.fixed_map.remove(prev_key);
                        }
                    }
                    self.frames[fid].fixed_key = None;
                }
            }
        }

        let is_same_open_frame = frame_idx
            .and_then(|fid| self.frames[fid].fixed_key.as_ref())
            .map(|k| k == &key)
            .unwrap_or(false);

        if let Some(entry) = self.fixed_map.get_mut(&key) {
            if is_same_open_frame {
                entry.dlc = frame_bytes.len();
                entry.data = data_slice;
                entry.last_perf_ms = perf_ms;
            } else {
                entry.count += 1;
                entry.cycle_ms = (perf_ms - entry.last_perf_ms).max(0.0);
                entry.last_perf_ms = perf_ms;
                entry.dlc = frame_bytes.len();
                entry.prev_data = std::mem::replace(&mut entry.data, data_slice);
            }
        } else {
            self.fixed_map.insert(
                key.clone(),
                FixedRowEntry {
                    key: key.clone(),
                    id_str,
                    raw_id,
                    type_str: "SERIAL".to_string(),
                    dlc: frame_bytes.len(),
                    data: data_slice,
                    prev_data: Vec::new(),
                    count: 1,
                    last_perf_ms: perf_ms,
                    cycle_ms: 0.0,
                },
            );
        }

        if let Some(fid) = frame_idx {
            self.frames[fid].fixed_key = Some(key);
        }
    }
}

pub fn derive_fixed_identity(dir: FrameDirection, frame_bytes: &[u8]) -> (String, String, u64) {
    let prefix = dir.as_str();
    if frame_bytes.is_empty() {
        return (
            format!("{}_EMPTY", prefix),
            format!("[{}]", prefix),
            if dir == FrameDirection::Tx { 1 } else { 0 },
        );
    }

    let sample_len = frame_bytes.len().min(32);
    let is_ascii = frame_bytes[..sample_len]
        .iter()
        .all(|&b| (0x20..=0x7e).contains(&b) || b == b'\r' || b == b'\n' || b == b'\t');

    if is_ascii && frame_bytes.len() >= 2 {
        let head = String::from_utf8_lossy(&frame_bytes[..frame_bytes.len().min(24)]);
        let trimmed = head.trim();
        let token: String = trimmed
            .chars()
            .take(12)
            .take_while(|c| c.is_ascii_alphanumeric() || "_+*?#-".contains(*c))
            .collect();
        if !token.is_empty() {
            let mut hash: u64 = 0;
            for b in token.bytes() {
                hash = hash.wrapping_mul(31).wrapping_add(b as u64);
            }
            let base = if dir == FrameDirection::Tx {
                0x2000_0000
            } else {
                0x1000_0000
            };
            return (
                format!("{}_ASC_{}", prefix, token),
                format!("{} {}", prefix, token),
                base + (hash & 0x0fff_ffff),
            );
        }
    }

    let hdr = &frame_bytes[..frame_bytes.len().min(2)];
    let hdr_hex = bytes_to_hex_string(hdr);
    let numeric_hdr = if hdr.len() >= 2 {
        ((hdr[0] as u64) << 8) | (hdr[1] as u64)
    } else {
        hdr[0] as u64
    };
    let base = if dir == FrameDirection::Tx {
        0x10000
    } else {
        0
    };
    (
        format!("{}_HEX_{}", prefix, hdr_hex),
        format!("{} {}", prefix, hdr_hex),
        base + numeric_hdr,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timeout_and_fixed_grouping() {
        let mut engine = FrameEngine::new(FramingConfig {
            timeout_ms: 20.0,
            show_tx_inline: false,
            ..Default::default()
        });

        engine.push_chunk(RawChunk {
            dir: FrameDirection::Rx,
            bytes: vec![0x01, 0x03, 0x02, 0x00, 0x10],
            perf_ms: 10.0,
            can_meta: None,
        });
        engine.push_chunk(RawChunk {
            dir: FrameDirection::Rx,
            bytes: vec![0x01, 0x06, 0x00, 0x01, 0x00, 0x05],
            perf_ms: 50.0,
            can_meta: None,
        });
        engine.push_chunk(RawChunk {
            dir: FrameDirection::Rx,
            bytes: vec![0x01, 0x03, 0x02, 0x00, 0x11],
            perf_ms: 110.0,
            can_meta: None,
        });
        // TX should be ignored when show_tx_inline = false
        engine.push_chunk(RawChunk {
            dir: FrameDirection::Tx,
            bytes: b"AT+GMR\r\n".to_vec(),
            perf_ms: 120.0,
            can_meta: None,
        });

        assert_eq!(engine.frames.len(), 3);
        assert_eq!(engine.fixed_map.len(), 2);
        assert_eq!(engine.fixed_map["RX_HEX_01 03"].count, 2);
        assert_eq!(engine.fixed_map["RX_HEX_01 06"].count, 1);
    }

    #[test]
    fn test_delimiter_framing() {
        let mut engine = FrameEngine::new(FramingConfig {
            rule: FrameRule::Delimiter,
            delim_bytes: vec![0x0d, 0x0a],
            ..Default::default()
        });

        engine.push_chunk(RawChunk {
            dir: FrameDirection::Rx,
            bytes: b"AT+GMR\r\nOK\r\n".to_vec(),
            perf_ms: 10.0,
            can_meta: None,
        });

        assert_eq!(engine.frames.len(), 2);
        assert_eq!(engine.frames[0].length, 8);
        assert_eq!(engine.frames[1].length, 4);
        assert!(engine.fixed_map.contains_key("RX_ASC_AT+GMR"));
        assert!(engine.fixed_map.contains_key("RX_ASC_OK"));
    }
}
