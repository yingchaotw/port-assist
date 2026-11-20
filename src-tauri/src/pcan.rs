use libloading::Library;
use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::sync::Arc;

pub const PCAN_ERROR_OK: u32 = 0x00000;
pub const PCAN_ERROR_QRCVEMPTY: u32 = 0x00020;

pub const PCAN_MESSAGE_STANDARD: u8 = 0x00;
pub const PCAN_MESSAGE_RTR: u8 = 0x01;
pub const PCAN_MESSAGE_EXTENDED: u8 = 0x02;
pub const PCAN_MESSAGE_STATUS: u8 = 0x80;

pub const PCAN_CHANNEL_CONDITION: u8 = 0x0D;
pub const PCAN_ATTACHED_CHANNELS_COUNT: u8 = 0x2A;
pub const PCAN_ATTACHED_CHANNELS: u8 = 0x2B;

#[allow(dead_code)]
pub const PCAN_CHANNEL_UNAVAILABLE: u32 = 0;
pub const PCAN_CHANNEL_AVAILABLE: u32 = 1;
pub const PCAN_CHANNEL_OCCUPIED: u32 = 2;
pub const PCAN_CHANNEL_PCANVIEW: u32 = PCAN_CHANNEL_AVAILABLE | PCAN_CHANNEL_OCCUPIED;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct TPCANChannelInformation {
    pub channel_handle: u16,
    pub device_type: u8,
    pub controller_number: u8,
    pub device_features: u32,
    pub device_name: [u8; 33],
    pub device_id: u32,
    pub channel_condition: u32,
}

pub const PCAN_USB_CHANNELS: &[(u16, &str)] = &[
    (0x51, "PCAN_USBBUS1"),
    (0x52, "PCAN_USBBUS2"),
    (0x53, "PCAN_USBBUS3"),
    (0x54, "PCAN_USBBUS4"),
    (0x55, "PCAN_USBBUS5"),
    (0x56, "PCAN_USBBUS6"),
    (0x57, "PCAN_USBBUS7"),
    (0x58, "PCAN_USBBUS8"),
];

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct TPCANMsg {
    pub id: u32,
    pub msg_type: u8,
    pub len: u8,
    pub data: [u8; 8],
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct TPCANTimestamp {
    pub millis: u32,
    pub millis_overflow: u16,
    pub micros: u16,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PcanConfigDto {
    pub channel: String,
    pub baud_rate: u32,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PcanTxFrameDto {
    pub id: u32,
    pub extended: bool,
    pub rtr: bool,
    pub data: Vec<u8>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CanRxFrameDto {
    pub perf_ms: f64,
    pub id: u32,
    pub extended: bool,
    pub rtr: bool,
    pub dlc: u8,
    pub data: Vec<u8>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CanRxBatchEventDto {
    pub session_id: String,
    pub batch_now_ms: f64,
    pub frames: Vec<CanRxFrameDto>,
}

type FnCanInitialize = unsafe extern "system" fn(u16, u16, u8, u32, u16) -> u32;
type FnCanUninitialize = unsafe extern "system" fn(u16) -> u32;
type FnCanRead = unsafe extern "system" fn(u16, *mut TPCANMsg, *mut TPCANTimestamp) -> u32;
type FnCanWrite = unsafe extern "system" fn(u16, *mut TPCANMsg) -> u32;
type FnCanGetValue = unsafe extern "system" fn(u16, u8, *mut c_void, u32) -> u32;

pub struct PcanLib {
    _lib: Library,
    fn_initialize: FnCanInitialize,
    fn_uninitialize: FnCanUninitialize,
    fn_read: FnCanRead,
    fn_write: FnCanWrite,
    fn_get_value: FnCanGetValue,
}

unsafe impl Send for PcanLib {}
unsafe impl Sync for PcanLib {}

impl PcanLib {
    pub fn load() -> Result<Arc<Self>, String> {
        #[cfg(target_os = "windows")]
        let mut candidate_paths: Vec<std::path::PathBuf> = vec![
            std::path::PathBuf::from("PCANBasic.dll"),
            std::path::PathBuf::from(r"C:\Windows\System32\PCANBasic.dll"),
            std::path::PathBuf::from(r"D:\USBCAN卡资料_PCAN\04-二次开发\PCAN\x64\PCANBasic.dll"),
        ];
        #[cfg(target_os = "windows")]
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidate_paths.insert(0, dir.join("PCANBasic.dll"));
            }
        }
        #[cfg(target_os = "macos")]
        let candidate_paths: Vec<std::path::PathBuf> = vec![
            std::path::PathBuf::from("/usr/local/lib/libPCBUSB.dylib"),
            std::path::PathBuf::from("/opt/homebrew/lib/libPCBUSB.dylib"),
            std::path::PathBuf::from("libPCBUSB.dylib"),
        ];
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        let candidate_paths: Vec<std::path::PathBuf> = vec![
            std::path::PathBuf::from("libPCBUSB.so"),
            std::path::PathBuf::from("libpcanbasic.so"),
        ];

        for path in candidate_paths {
            if let Ok(lib) = unsafe { Library::new(&path) } {
                unsafe {
                    let fn_initialize = *lib
                        .get::<FnCanInitialize>(b"CAN_Initialize\0")
                        .map_err(|e| format!("找不到 CAN_Initialize: {}", e))?;
                    let fn_uninitialize = *lib
                        .get::<FnCanUninitialize>(b"CAN_Uninitialize\0")
                        .map_err(|e| format!("找不到 CAN_Uninitialize: {}", e))?;
                    let fn_read = *lib
                        .get::<FnCanRead>(b"CAN_Read\0")
                        .map_err(|e| format!("找不到 CAN_Read: {}", e))?;
                    let fn_write = *lib
                        .get::<FnCanWrite>(b"CAN_Write\0")
                        .map_err(|e| format!("找不到 CAN_Write: {}", e))?;
                    let fn_get_value = *lib
                        .get::<FnCanGetValue>(b"CAN_GetValue\0")
                        .map_err(|e| format!("找不到 CAN_GetValue: {}", e))?;

                    return Ok(Arc::new(Self {
                        _lib: lib,
                        fn_initialize,
                        fn_uninitialize,
                        fn_read,
                        fn_write,
                        fn_get_value,
                    }));
                }
            }
        }

        #[cfg(target_os = "macos")]
        let hint = "請確認已安裝 MacCAN (libPCBUSB.dylib 於 /usr/local/lib/)";
        #[cfg(target_os = "windows")]
        let hint = "請確認已安裝 PEAK-System PCAN-Basic 驅動與 PCANBasic.dll";
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        let hint = "請確認已安裝 PCAN-Basic 函式庫";

        Err(format!("無法載入 PCAN 驅動函式庫（{}）", hint))
    }

    pub fn initialize(&self, channel: u16, btr0btr1: u16) -> u32 {
        unsafe { (self.fn_initialize)(channel, btr0btr1, 0, 0, 0) }
    }

    pub fn uninitialize(&self, channel: u16) -> u32 {
        unsafe { (self.fn_uninitialize)(channel) }
    }

    pub fn read(&self, channel: u16) -> Result<Option<TPCANMsg>, u32> {
        let mut msg = TPCANMsg::default();
        let mut ts = TPCANTimestamp::default();
        let status = unsafe { (self.fn_read)(channel, &mut msg, &mut ts) };
        if status == PCAN_ERROR_OK {
            Ok(Some(msg))
        } else if status == PCAN_ERROR_QRCVEMPTY {
            Ok(None)
        } else {
            Err(status)
        }
    }

    pub fn write(&self, channel: u16, msg: &mut TPCANMsg) -> u32 {
        unsafe { (self.fn_write)(channel, msg as *mut TPCANMsg) }
    }

    pub fn get_channel_condition(&self, channel: u16) -> Result<u32, u32> {
        let mut cond: u32 = 0;
        let status = unsafe {
            (self.fn_get_value)(
                channel,
                PCAN_CHANNEL_CONDITION,
                &mut cond as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        if status == PCAN_ERROR_OK {
            Ok(cond)
        } else {
            Err(status)
        }
    }

    pub fn get_attached_channels(&self) -> Result<Vec<TPCANChannelInformation>, u32> {
        let mut count: u32 = 0;
        let status = unsafe {
            (self.fn_get_value)(
                0,
                PCAN_ATTACHED_CHANNELS_COUNT,
                &mut count as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        if status != PCAN_ERROR_OK || count == 0 {
            return Ok(Vec::new());
        }
        let mut buffer = vec![
            TPCANChannelInformation {
                channel_handle: 0,
                device_type: 0,
                controller_number: 0,
                device_features: 0,
                device_name: [0u8; 33],
                device_id: 0,
                channel_condition: 0,
            };
            count as usize
        ];
        let bytes_len = (count as usize * std::mem::size_of::<TPCANChannelInformation>()) as u32;
        let status2 = unsafe {
            (self.fn_get_value)(
                0,
                PCAN_ATTACHED_CHANNELS,
                buffer.as_mut_ptr() as *mut c_void,
                bytes_len,
            )
        };
        if status2 == PCAN_ERROR_OK {
            Ok(buffer)
        } else {
            Err(status2)
        }
    }
}

pub fn parse_channel_handle(name: &str) -> Result<u16, String> {
    let upper = name.trim().to_uppercase();
    for &(handle, label) in PCAN_USB_CHANNELS {
        if upper == label {
            return Ok(handle);
        }
    }
    Err(format!("不支援的 PCAN 通道: {}", name))
}

pub fn baud_to_btr0btr1(baud: u32) -> Result<u16, String> {
    match baud {
        1_000_000 => Ok(0x0014),
        800_000 => Ok(0x0016),
        500_000 => Ok(0x001C),
        250_000 => Ok(0x011C),
        125_000 => Ok(0x031C),
        100_000 => Ok(0x432F),
        50_000 => Ok(0x472F),
        20_000 => Ok(0x532F),
        10_000 => Ok(0x672F),
        _ => Err(format!("不支援的 Classic CAN 波特率: {} bps", baud)),
    }
}

pub fn format_pcan_error(status: u32) -> String {
    match status {
        0x00001 => "PCAN_ERROR_XMTFULL (發送緩衝區已滿)".to_string(),
        0x00002 => "PCAN_ERROR_OVERRUN (CAN 控制器溢位)".to_string(),
        0x00004 => "PCAN_ERROR_BUSLIGHT (匯流排錯誤計數過高)".to_string(),
        0x00008 => "PCAN_ERROR_BUSHEAVY (匯流排嚴重錯誤)".to_string(),
        0x00010 => "PCAN_ERROR_BUSOFF (匯流排已關閉 Bus-Off)".to_string(),
        0x00200 => "PCAN_ERROR_HWINUSE (硬體通道已被佔用)".to_string(),
        0x00800 => "PCAN_ERROR_NETINUSE (網路已被使用或波特率衝突)".to_string(),
        0x01400 => "PCAN_ERROR_NODRIVER (未載入驅動程式)".to_string(),
        0x01C00 => "PCAN_ERROR_ILLHW (找不到對應的 PCAN 硬體)".to_string(),
        0x04000 => "PCAN_ERROR_INITIALIZE (通道尚未初始化)".to_string(),
        0x80000 => "PCAN_ERROR_ILLMODE (驅動狀態錯誤: 已被 PCAN-View/其他程式佔用，或需重新拔插 USB)".to_string(),
        0x8000000 => "PCAN_ERROR_ILLOPERATION (不支援此操作模式)".to_string(),
        _ => format!("PCAN 錯誤碼: 0x{:05X}", status),
    }
}
