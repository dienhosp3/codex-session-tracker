//! Local Codex Tracker instrumentation. Disabled unless explicit loopback
//! configuration is inherited or published privately by Tracker. Authentication
//! headers are excluded; request/response bodies are captured as requested.
use base64::Engine;
use serde_json::Value;
use serde_json::json;
use std::io::Read;
use std::io::Write;
use std::net::Ipv4Addr;
use std::net::SocketAddrV4;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc::SyncSender;
use std::sync::mpsc::TrySendError;
use std::sync::mpsc::sync_channel;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const LIMIT: usize = 64 * 1024 * 1024;
static SEQUENCE: AtomicU64 = AtomicU64::new(1);
static QUEUE: OnceLock<SyncSender<Value>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);

struct Config {
    port: u16,
    token: String,
}
fn config() -> Result<Option<Config>, String> {
    // The private temporary bridge also covers VS Code activation order and restarts.
    let directory = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf));
    let managed = directory
        .as_ref()
        .is_some_and(|dir| dir.join("tracker-runtime.json").exists());
    let from_file = directory
        .and_then(|dir| std::fs::read(dir.join("tracker-bridge.json")).ok())
        .filter(|bytes| bytes.len() < 4096)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let port = from_file
        .as_ref()
        .and_then(|value| value["port"].as_u64())
        .and_then(|port| u16::try_from(port).ok())
        .or_else(|| {
            std::env::var("CODEX_TRACKER_GATEWAY_PORT")
                .ok()?
                .parse::<u16>()
                .ok()
        });
    let token = from_file
        .as_ref()
        .and_then(|value| value["token"].as_str())
        .map(str::to_owned)
        .or_else(|| std::env::var("CODEX_TRACKER_GATEWAY_TOKEN").ok());
    match (port, token) {
        (Some(port), Some(token))
            if port > 0 && token.len() >= 16 && !token.contains(['\r', '\n']) =>
        {
            Ok(Some(Config { port, token }))
        }
        _ if managed => {
            Err("Tracker Gateway unavailable; managed runtime request was not sent".into())
        }
        _ => Ok(None),
    }
}
fn request_id() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn post(path: &str, value: &Value) -> Result<Value, String> {
    let Some(config) = config()? else {
        return Err("Tracker hook is disabled".into());
    };
    let body = serde_json::to_vec(value).map_err(|_| "Tracker hook serialization failed")?;
    if body.len() > LIMIT {
        return Err("Tracker hook body exceeds 64 MiB".into());
    }
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, config.port);
    let mut stream = TcpStream::connect_timeout(&address.into(), Duration::from_secs(2))
        .map_err(|_| "Tracker Gateway unavailable; request was not sent")?;
    let timeout = Some(Duration::from_secs(10));
    stream
        .set_read_timeout(timeout)
        .map_err(|_| "Tracker read timeout setup failed")?;
    stream
        .set_write_timeout(timeout)
        .map_err(|_| "Tracker write timeout setup failed")?;
    let headers = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Codex-Gateway-Token: {}\r\n\r\n",
        body.len(),
        config.token
    );
    stream
        .write_all(headers.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|_| "Tracker Gateway write failed; upstream request was not sent")?;
    let mut wire = Vec::new();
    stream
        .take((LIMIT + 65536 + 1) as u64)
        .read_to_end(&mut wire)
        .map_err(
            |_| "Tracker Gateway acknowledgement unavailable; upstream request was not sent",
        )?;
    if wire.len() > LIMIT + 65536 {
        return Err("Tracker Gateway response exceeds limit".into());
    }
    let Some(end) = wire.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
        return Err("Malformed Tracker Gateway response".into());
    };
    if !wire.starts_with(b"HTTP/1.1 200 ") {
        return Err("Tracker JSON filter rejected request before upstream send".into());
    }
    serde_json::from_slice(&wire[end + 4..])
        .map_err(|_| "Malformed Tracker JSON acknowledgement".into())
}

pub struct Prepared {
    pub request_id: String,
    pub body_json: String,
}
pub fn prepare(
    method: &str,
    url: &str,
    protocol: &str,
    body_json: String,
) -> Result<Option<Prepared>, String> {
    prepare_content(method, url, protocol, body_json, None)
}
pub fn prepare_raw(
    method: &str,
    url: &str,
    bytes: &[u8],
    unavailable: bool,
) -> Result<Option<Prepared>, String> {
    prepare_content(
        method,
        url,
        "http",
        String::new(),
        Some(json!({
            "bodyBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"captureUnavailable":unavailable
        })),
    )
}
fn prepare_content(
    method: &str,
    url: &str,
    protocol: &str,
    body_json: String,
    extra: Option<Value>,
) -> Result<Option<Prepared>, String> {
    if config()?.is_none() {
        return Ok(None);
    }
    let id = request_id();
    let mut payload = json!({
        "schemaVersion":1,"requestId":id,"method":method,"url":url,"protocol":protocol,
        "bodyJson":body_json,"runtimeVersion":env!("CARGO_PKG_VERSION")
    });
    if let Some(Value::Object(extra)) = extra {
        payload.as_object_mut().unwrap().extend(extra);
    }
    let result = post("/instrumentation/v1/outbound", &payload)?;
    if result["schemaVersion"] != 1 || result["requestId"].as_str() != Some(&id) {
        return Err("Tracker JSON acknowledgement did not match this request".into());
    }
    let result_body = result["bodyJson"]
        .as_str()
        .ok_or("Tracker acknowledgement missing JSON")?;
    if !body_json.is_empty() {
        serde_json::from_str::<Value>(result_body).map_err(|_| "Tracker returned invalid JSON")?;
    }
    Ok(Some(Prepared {
        request_id: id,
        body_json: result_body.to_owned(),
    }))
}

#[derive(Clone, Debug)]
pub struct Observation {
    id: String,
    method: String,
    url: String,
    protocol: String,
    chunk_index: Arc<AtomicU64>,
}
impl Observation {
    pub fn new(id: Option<String>, method: &str, url: &str, protocol: &str) -> Option<Self> {
        config().ok()??;
        Some(Self {
            id: id.unwrap_or_else(request_id),
            method: method.into(),
            url: url.into(),
            protocol: protocol.into(),
            chunk_index: Arc::new(AtomicU64::new(0)),
        })
    }
    pub fn emit(&self, kind: &str, mut value: Value) {
        value["kind"] = json!(kind);
        value["requestId"] = json!(self.id);
        value["method"] = json!(self.method);
        value["url"] = json!(self.url);
        value["protocol"] = json!(self.protocol);
        enqueue(value);
    }
    pub fn chunk(&self, bytes: &[u8]) {
        let index = self.chunk_index.fetch_add(1, Ordering::Relaxed);
        // Preserve each client body frame / WebSocket message as one observation.
        // Oversized bridge messages are reported as capture gaps, never resegmented.
        if bytes.len() > LIMIT {
            DROPPED.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.emit("response_chunk",json!({
            "bytes":base64::engine::general_purpose::STANDARD.encode(bytes),
            "chunkIndex":index,
            "captureBoundary":if self.protocol == "websocket" { "websocket-message" } else { "http-client-body-frame" }
        }));
    }
    pub fn headers(&self, status: u16, headers: &http::HeaderMap) {
        let mut safe = serde_json::Map::new();
        for name in ["content-type", "content-encoding", "content-length"] {
            if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
                safe.insert(name.into(), json!(value));
            }
        }
        self.emit(
            "response_headers",
            json!({"statusCode":status,"headers":safe}),
        );
    }
    pub fn sent(&self) {
        self.emit("sent", json!({}));
    }
    pub fn finished(&self) {
        self.emit("finished", json!({}));
    }
    pub fn error(&self) {
        self.emit("error", json!({"error":"Upstream transport failed"}));
    }
}
fn enqueue(value: Value) {
    let sender = QUEUE.get_or_init(|| {
        let (sender, receiver) = sync_channel::<Value>(256);
        std::thread::spawn(move || {
            while let Ok(event) = receiver.recv() {
                let lost = DROPPED.swap(0, Ordering::Relaxed);
                if lost > 0
                    && post(
                        "/instrumentation/v1/observe",
                        &json!({"kind":"dropped","count":lost}),
                    )
                    .is_err()
                {
                    DROPPED.fetch_add(lost, Ordering::Relaxed);
                }
                if post("/instrumentation/v1/observe", &event).is_err() {
                    DROPPED.fetch_add(1, Ordering::Relaxed);
                }
            }
        });
        sender
    });
    if let Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) = sender.try_send(value) {
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
}

pub struct TrackedBody<B> {
    pub inner: std::pin::Pin<Box<B>>,
    pub tracker: Observation,
}
impl<B: http_body::Body<Data = bytes::Bytes>> http_body::Body for TrackedBody<B> {
    type Data = bytes::Bytes;
    type Error = B::Error;
    fn poll_frame(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let body = self.get_mut();
        let result = body.inner.as_mut().poll_frame(cx);
        match &result {
            std::task::Poll::Ready(Some(Ok(frame))) => {
                if let Some(bytes) = frame.data_ref() {
                    body.tracker.chunk(bytes);
                }
            }
            std::task::Poll::Ready(Some(Err(_))) => body.tracker.error(),
            std::task::Poll::Ready(None) => body.tracker.finished(),
            _ => {}
        }
        result
    }
    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
}
