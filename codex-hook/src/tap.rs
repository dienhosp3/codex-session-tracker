//! Codex Session Tracker HTTP hook.
//!
//! This module is intentionally transport-local: it observes and optionally mutates
//! requests after Codex has built them but before reqwest hands them to TLS. Response
//! bodies are observed after TLS while application code consumes them.
//!
//! Configuration is read from CODEX_HOME/codex-session-tracker-http-hook.json.
//! Event delivery is best-effort and must never make Codex networking depend on the
//! Tracker being available. Mutation preflight is opt-in and fails open.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Cursor;
use std::io::Write;
use std::net::SocketAddr;
use std::net::TcpStream;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc::SyncSender;
use std::sync::mpsc::TrySendError;
use std::sync::mpsc::sync_channel;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use http::HeaderMap;
use http::HeaderName;
use http::HeaderValue;
use reqwest::Request;
use reqwest::Response;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

const CONFIG_FILE: &str = "codex-session-tracker-http-hook.json";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(80);
const PREFLIGHT_TIMEOUT: Duration = Duration::from_millis(50);
const CONFIG_CACHE_TTL: Duration = Duration::from_millis(250);
const EVENT_QUEUE_CAPACITY: usize = 2048;

static REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);
static EMITTER: OnceLock<SyncSender<QueuedEvent>> = OnceLock::new();
static CONFIG_CACHE: OnceLock<Mutex<ConfigCache>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TapConfig {
    #[serde(default)]
    enabled: bool,
    host: String,
    port: u16,
    token: String,
    #[serde(default)]
    mutation_enabled: bool,
    #[serde(default = "default_max_body_bytes")]
    max_body_bytes: usize,
}

fn default_max_body_bytes() -> usize {
    16 * 1024 * 1024
}

#[derive(Debug, Clone)]
pub(crate) struct TapContext {
    pub(crate) request_id: String,
    config: TapConfig,
    method: String,
    url: String,
    content_type: String,
    response_ended: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TapBody {
    pub(crate) encoding: String,
    pub(crate) content: String,
    pub(crate) content_type: String,
    pub(crate) total_bytes: usize,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TapEvent {
    phase: String,
    direction: String,
    request_id: String,
    method: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_code: Option<u16>,
    headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<TapBody>,
    logical: bool,
    mutation_applied: bool,
    at: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct EventEnvelope<'a> {
    token: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    event: &'a TapEvent,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreflightRequest<'a> {
    request_id: &'a str,
    method: &'a str,
    url: &'a str,
    headers: HashMap<String, String>,
    body: Option<TapBody>,
}

#[derive(Debug, Serialize)]
struct PreflightEnvelope<'a> {
    token: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    request: PreflightRequest<'a>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MutationDecision {
    #[serde(default)]
    action: String,
    body: Option<TapBody>,
    #[serde(default)]
    set_headers: HashMap<String, String>,
    #[serde(default)]
    remove_headers: Vec<String>,
}

#[derive(Debug, Clone)]
struct QueuedEvent {
    addr: SocketAddr,
    line: String,
}

fn config_path() -> Option<PathBuf> {
    if let Some(explicit) = env::var_os("CODEX_HTTP_HOOK_CONFIG") {
        return Some(PathBuf::from(explicit));
    }
    let home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("USERPROFILE")
                .or_else(|| env::var_os("HOME"))
                .map(|path| PathBuf::from(path).join(".codex"))
        })?;
    Some(home.join(CONFIG_FILE))
}

#[derive(Default)]
struct ConfigCache {
    checked_at: Option<Instant>,
    path: Option<PathBuf>,
    modified: Option<SystemTime>,
    config: Option<TapConfig>,
}

fn parse_config(path: &PathBuf) -> Option<TapConfig> {
    let text = fs::read_to_string(path).ok()?;
    let mut config: TapConfig = serde_json::from_str(&text).ok()?;
    if !config.enabled
        || config.token.is_empty()
        || config.host != "127.0.0.1"
        || config.port == 0
    {
        return None;
    }
    config.max_body_bytes = config
        .max_body_bytes
        .clamp(1024, 64 * 1024 * 1024);
    Some(config)
}

fn load_config() -> Option<TapConfig> {
    let path = config_path()?;
    let now = Instant::now();
    let cache = CONFIG_CACHE.get_or_init(|| Mutex::new(ConfigCache::default()));
    let mut cache = cache.lock().ok()?;

    if cache
        .checked_at
        .is_some_and(|checked| now.duration_since(checked) < CONFIG_CACHE_TTL)
        && cache.path.as_ref() == Some(&path)
    {
        return cache.config.clone();
    }

    let modified = fs::metadata(&path).and_then(|meta| meta.modified()).ok();
    if cache.path.as_ref() == Some(&path) && cache.modified == modified {
        cache.checked_at = Some(now);
        return cache.config.clone();
    }

    let config = parse_config(&path);
    cache.checked_at = Some(now);
    cache.path = Some(path);
    cache.modified = modified;
    cache.config = config.clone();
    config
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn request_id() -> String {
    let seq = REQUEST_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{seq}", std::process::id(), now_ms())
}

fn socket_addr(config: &TapConfig) -> Option<SocketAddr> {
    format!("{}:{}", config.host, config.port).parse().ok()
}

fn emitter() -> &'static SyncSender<QueuedEvent> {
    EMITTER.get_or_init(|| {
        let (tx, rx) = sync_channel::<QueuedEvent>(EVENT_QUEUE_CAPACITY);
        let _ = thread::Builder::new()
            .name("codex-http-hook".to_string())
            .spawn(move || {
                let mut stream: Option<(SocketAddr, TcpStream)> = None;
                while let Ok(item) = rx.recv() {
                    let needs_connect = stream
                        .as_ref()
                        .is_none_or(|(addr, socket)| *addr != item.addr || socket.peer_addr().is_err());
                    if needs_connect {
                        stream = TcpStream::connect_timeout(&item.addr, CONNECT_TIMEOUT)
                            .ok()
                            .map(|socket| (item.addr, socket));
                    }
                    let Some((_, socket)) = stream.as_mut() else {
                        continue;
                    };
                    if socket.write_all(item.line.as_bytes()).is_err()
                        || socket.write_all(b"\n").is_err()
                    {
                        stream = None;
                        if let Ok(mut socket) = TcpStream::connect_timeout(&item.addr, CONNECT_TIMEOUT)
                        {
                            let _ = socket.write_all(item.line.as_bytes());
                            let _ = socket.write_all(b"\n");
                            stream = Some((item.addr, socket));
                        }
                    }
                }
            });
        tx
    })
}

fn enqueue_event(config: &TapConfig, event: &TapEvent) {
    let Some(addr) = socket_addr(config) else {
        return;
    };
    let Ok(line) = serde_json::to_string(&EventEnvelope {
        token: &config.token,
        kind: "event",
        event,
    }) else {
        return;
    };
    match emitter().try_send(QueuedEvent { addr, line }) {
        Ok(()) | Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
    }
}

fn sensitive_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization"
            | "cookie"
            | "set-cookie"
            | "proxy-authorization"
            | "x-api-key"
            | "api-key"
    )
}

fn capture_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (name, value) in headers {
        let key = name.as_str().to_string();
        let rendered = if sensitive_header(&key) {
            "[REDACTED]".to_string()
        } else {
            value.to_str().unwrap_or("<binary>").to_string()
        };
        out.insert(key, rendered);
    }
    out
}

fn content_type(headers: &HeaderMap) -> String {
    headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn logical_request_bytes(request: &Request) -> Option<Vec<u8>> {
    let body = request.body()?.as_bytes()?;
    let encoding = request
        .headers()
        .get(http::header::CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if encoding.eq_ignore_ascii_case("zstd") {
        return zstd::stream::decode_all(Cursor::new(body)).ok();
    }
    Some(body.to_vec())
}

fn tap_body(bytes: &[u8], content_type: &str, max_bytes: usize) -> TapBody {
    let total_bytes = bytes.len();
    let slice = if bytes.len() > max_bytes {
        &bytes[..max_bytes]
    } else {
        bytes
    };
    match std::str::from_utf8(slice) {
        Ok(text) => TapBody {
            encoding: "utf8".to_string(),
            content: text.to_string(),
            content_type: content_type.to_string(),
            total_bytes,
            truncated: total_bytes > slice.len(),
        },
        Err(_) => TapBody {
            encoding: "base64".to_string(),
            content: BASE64.encode(slice),
            content_type: content_type.to_string(),
            total_bytes,
            truncated: total_bytes > slice.len(),
        },
    }
}

fn body_bytes(body: &TapBody) -> Option<Vec<u8>> {
    match body.encoding.as_str() {
        "base64" => BASE64.decode(body.content.as_bytes()).ok(),
        "utf8" | "" => Some(body.content.as_bytes().to_vec()),
        _ => None,
    }
}

fn emit_request_event(
    config: &TapConfig,
    context: &TapContext,
    request: &Request,
    body: Option<TapBody>,
    phase: &str,
    mutation_applied: bool,
) {
    enqueue_event(
        config,
        &TapEvent {
            phase: phase.to_string(),
            direction: "out".to_string(),
            request_id: context.request_id.clone(),
            method: context.method.clone(),
            url: context.url.clone(),
            status_code: None,
            headers: capture_headers(request.headers()),
            body,
            logical: true,
            mutation_applied,
            at: now_ms(),
            error: None,
        },
    );
}

fn mutation_preflight(
    config: &TapConfig,
    request_id: &str,
    method: &str,
    url: &str,
    headers: HashMap<String, String>,
    body: Option<TapBody>,
) -> Option<MutationDecision> {
    if !config.mutation_enabled {
        return None;
    }
    let addr = socket_addr(config)?;
    let mut socket = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).ok()?;
    let _ = socket.set_read_timeout(Some(PREFLIGHT_TIMEOUT));
    let _ = socket.set_write_timeout(Some(PREFLIGHT_TIMEOUT));
    let envelope = PreflightEnvelope {
        token: &config.token,
        kind: "preflight",
        request: PreflightRequest {
            request_id,
            method,
            url,
            headers,
            body,
        },
    };
    let mut line = serde_json::to_vec(&envelope).ok()?;
    line.push(b'\n');
    socket.write_all(&line).ok()?;
    let mut reader = BufReader::new(socket);
    let mut response = String::new();
    reader.read_line(&mut response).ok()?;
    serde_json::from_str(response.trim()).ok()
}

fn request_preflight(
    config: &TapConfig,
    context: &TapContext,
    request: &Request,
    body: Option<TapBody>,
) -> Option<MutationDecision> {
    mutation_preflight(
        config,
        &context.request_id,
        &context.method,
        &context.url,
        capture_headers(request.headers()),
        body,
    )
}

fn apply_decision(request: &mut Request, decision: &MutationDecision) -> bool {
    let action = decision.action.to_ascii_lowercase();
    if action != "replace" && action != "modify" {
        return false;
    }
    let mut changed = false;

    for name in &decision.remove_headers {
        if let Ok(name) = HeaderName::from_str(name) {
            request.headers_mut().remove(name);
            changed = true;
        }
    }
    for (name, value) in &decision.set_headers {
        let Ok(name) = HeaderName::from_str(name) else {
            continue;
        };
        if name == http::header::HOST || name == http::header::CONTENT_LENGTH {
            continue;
        }
        let Ok(value) = HeaderValue::from_str(value) else {
            continue;
        };
        request.headers_mut().insert(name, value);
        changed = true;
    }

    if let Some(body) = decision.body.as_ref().and_then(body_bytes) {
        let encoding = request
            .headers()
            .get(http::header::CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let wire = if encoding.eq_ignore_ascii_case("zstd") {
            zstd::stream::encode_all(Cursor::new(body), 3).ok()
        } else {
            Some(body)
        };
        if let Some(wire) = wire {
            *request.body_mut() = Some(reqwest::Body::from(wire));
            request.headers_mut().remove(http::header::CONTENT_LENGTH);
            changed = true;
        }
    }

    changed
}

pub(crate) fn intercept_outbound(request: &mut Request) -> Option<TapContext> {
    let config = load_config()?;
    let context = TapContext {
        request_id: request_id(),
        method: request.method().to_string(),
        url: request.url().to_string(),
        content_type: content_type(request.headers()),
        config: config.clone(),
        response_ended: Arc::new(AtomicBool::new(false)),
    };

    let original_bytes = logical_request_bytes(request);
    let original_body = original_bytes
        .as_deref()
        .map(|bytes| tap_body(bytes, &context.content_type, config.max_body_bytes));

    emit_request_event(
        &config,
        &context,
        request,
        original_body.clone(),
        "outbound_request",
        false,
    );

    let mut mutation_applied = false;
    if let Some(decision) = request_preflight(&config, &context, request, original_body)
        && apply_decision(request, &decision)
    {
        mutation_applied = true;
    }

    if mutation_applied {
        let final_body = logical_request_bytes(request)
            .as_deref()
            .map(|bytes| tap_body(bytes, &content_type(request.headers()), config.max_body_bytes));
        emit_request_event(
            &config,
            &context,
            request,
            final_body,
            "outbound_mutated",
            true,
        );
    }

    Some(context)
}

pub(crate) fn attach_response_context(response: &mut Response, mut context: TapContext) {
    let status_code = response.status().as_u16();
    let headers = capture_headers(response.headers());
    context.content_type = content_type(response.headers());
    let event = TapEvent {
        phase: "response_headers".to_string(),
        direction: "in".to_string(),
        request_id: context.request_id.clone(),
        method: context.method.clone(),
        url: context.url.clone(),
        status_code: Some(status_code),
        headers,
        body: None,
        logical: true,
        mutation_applied: false,
        at: now_ms(),
        error: None,
    };
    enqueue_event(&context.config, &event);
    response.extensions_mut().insert(context);
}

pub(crate) fn response_context(response: &Response) -> Option<TapContext> {
    response.extensions().get::<TapContext>().cloned()
}

pub(crate) fn emit_response_chunk(context: &TapContext, bytes: &Bytes) {
    enqueue_event(
        &context.config,
        &TapEvent {
            phase: "response_chunk".to_string(),
            direction: "in".to_string(),
            request_id: context.request_id.clone(),
            method: context.method.clone(),
            url: context.url.clone(),
            status_code: None,
            headers: HashMap::new(),
            body: Some(tap_body(
                bytes,
                &context.content_type,
                context.config.max_body_bytes,
            )),
            logical: true,
            mutation_applied: false,
            at: now_ms(),
            error: None,
        },
    );
}

pub(crate) fn emit_response_end(context: &TapContext) {
    if context.response_ended.swap(true, Ordering::AcqRel) {
        return;
    }
    enqueue_event(
        &context.config,
        &TapEvent {
            phase: "response_end".to_string(),
            direction: "in".to_string(),
            request_id: context.request_id.clone(),
            method: context.method.clone(),
            url: context.url.clone(),
            status_code: None,
            headers: HashMap::new(),
            body: None,
            logical: true,
            mutation_applied: false,
            at: now_ms(),
            error: None,
        },
    );
}

pub(crate) fn emit_request_error(context: &TapContext, error: &str) {
    enqueue_event(
        &context.config,
        &TapEvent {
            phase: "request_error".to_string(),
            direction: "in".to_string(),
            request_id: context.request_id.clone(),
            method: context.method.clone(),
            url: context.url.clone(),
            status_code: None,
            headers: HashMap::new(),
            body: None,
            logical: true,
            mutation_applied: false,
            at: now_ms(),
            error: Some(error.to_string()),
        },
    );
}


fn emit_websocket_event(
    config: &TapConfig,
    request_id: &str,
    url: &str,
    phase: &str,
    direction: &str,
    body: Option<TapBody>,
    mutation_applied: bool,
) {
    enqueue_event(
        config,
        &TapEvent {
            phase: phase.to_string(),
            direction: direction.to_string(),
            request_id: request_id.to_string(),
            method: "WS".to_string(),
            url: url.to_string(),
            status_code: None,
            headers: HashMap::new(),
            body,
            logical: true,
            mutation_applied,
            at: now_ms(),
            error: None,
        },
    );
}

/// Tracker-only hook used by codex-websocket-client before Tungstenite serializes
/// a text frame. It intentionally fails open: any unavailable/invalid mutation
/// response leaves the original frame untouched.
#[doc(hidden)]
pub fn tracker_intercept_websocket_text(url: &str, original: String) -> String {
    let Some(config) = load_config() else {
        return original;
    };
    let id = request_id();
    let body = tap_body(
        original.as_bytes(),
        "application/json; charset=utf-8",
        config.max_body_bytes,
    );
    emit_websocket_event(
        &config,
        &id,
        url,
        "websocket_outbound",
        "out",
        Some(body.clone()),
        false,
    );
    let Some(decision) = mutation_preflight(
        &config,
        &id,
        "WS",
        url,
        HashMap::new(),
        Some(body),
    ) else {
        return original;
    };
    if !matches!(decision.action.to_ascii_lowercase().as_str(), "replace" | "modify") {
        return original;
    }
    let Some(replacement) = decision.body.as_ref().and_then(body_bytes) else {
        return original;
    };
    let Ok(replacement) = String::from_utf8(replacement) else {
        return original;
    };
    emit_websocket_event(
        &config,
        &id,
        url,
        "websocket_outbound_mutated",
        "out",
        Some(tap_body(
            replacement.as_bytes(),
            "application/json; charset=utf-8",
            config.max_body_bytes,
        )),
        true,
    );
    replacement
}

#[doc(hidden)]
pub fn tracker_observe_websocket_text(url: &str, text: &str) {
    let Some(config) = load_config() else {
        return;
    };
    emit_websocket_event(
        &config,
        &request_id(),
        url,
        "websocket_inbound",
        "in",
        Some(tap_body(
            text.as_bytes(),
            "application/json; charset=utf-8",
            config.max_body_bytes,
        )),
        false,
    );
}

#[doc(hidden)]
pub fn tracker_intercept_websocket_binary(url: &str, original: &[u8]) -> Vec<u8> {
    let Some(config) = load_config() else {
        return original.to_vec();
    };
    let id = request_id();
    let body = tap_body(
        original,
        "application/octet-stream",
        config.max_body_bytes,
    );
    emit_websocket_event(
        &config,
        &id,
        url,
        "websocket_binary_outbound",
        "out",
        Some(body.clone()),
        false,
    );
    let Some(decision) = mutation_preflight(
        &config,
        &id,
        "WS",
        url,
        HashMap::new(),
        Some(body),
    ) else {
        return original.to_vec();
    };
    if !matches!(decision.action.to_ascii_lowercase().as_str(), "replace" | "modify") {
        return original.to_vec();
    }
    let Some(replacement) = decision.body.as_ref().and_then(body_bytes) else {
        return original.to_vec();
    };
    emit_websocket_event(
        &config,
        &id,
        url,
        "websocket_binary_outbound_mutated",
        "out",
        Some(tap_body(
            &replacement,
            "application/octet-stream",
            config.max_body_bytes,
        )),
        true,
    );
    replacement
}

#[doc(hidden)]
pub fn tracker_observe_websocket_binary(url: &str, bytes: &[u8]) {
    let Some(config) = load_config() else {
        return;
    };
    emit_websocket_event(
        &config,
        &request_id(),
        url,
        "websocket_binary_inbound",
        "in",
        Some(tap_body(
            bytes,
            "application/octet-stream",
            config.max_body_bytes,
        )),
        false,
    );
}
