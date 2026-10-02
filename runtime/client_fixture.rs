use codex_http_client::{HttpClientBuilder, HttpClientFactory, HttpClientTlsConfig, ClientRouteClass, HttpTransport, OutboundProxyPolicy, Request, RequestCompression, ReqwestTransport};
use codex_websocket_client::{WebSocketConnector, WebSocketTlsMode};
use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    codex_utils_rustls_provider::ensure_rustls_crypto_provider();
    let base = std::env::args().nth(1).ok_or("Missing loopback fixture URL")?;
    if !base.starts_with("http://127.0.0.1:") && !base.starts_with("https://127.0.0.1:") { return Err("Fixture requires loopback upstream".into()); }
    let mode = std::env::args().nth(2).unwrap_or_default();
    let factory = HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault);
    let pem = std::env::args().nth(3).map(std::fs::read).transpose()?;
    let client = match &pem {
        Some(pem) => HttpClientBuilder::new().build_with_tls(&factory, ClientRouteClass::Api, HttpClientTlsConfig::default().with_root_certificate_pem(pem)?),
        None => HttpClientBuilder::new().build_direct()?,
    };
    let transport = ReqwestTransport::from_http_client(client.clone());
    let original = serde_json::json!({"model":"fixture-model","type":"response.create","input":[{"content":[{"text":"old"}]}]});
    if mode == "blocked" {
        let request = Request::new("POST".parse()?, format!("{base}/backend-api/codex/responses")).with_json(&original);
        if transport.stream(request).await.is_ok() { return Err("Expected rejection before upstream send".into()); }
        println!("blocked before upstream send"); return Ok(());
    }
    let request = Request::new("POST".parse()?, format!("{base}/backend-api/codex/responses"))
        .with_json(&original).with_compression(RequestCompression::Zstd).into_prepared()?;
    let mut response = transport.stream(request).await?;
    let mut raw = Vec::new();
    while let Some(chunk) = response.bytes.next().await { raw.extend_from_slice(&chunk?); }
    assert!(String::from_utf8(raw)?.contains("response.in_progress"));
    let response = client.request("PUT".parse()?, format!("{base}/metadata/update")).json(&serde_json::json!({"text":"old","model":"fixture-model"})).send().await?;
    assert_eq!(response.url().path(), "/metadata/update");
    assert_eq!(response.json::<serde_json::Value>().await?["ok"], true);
    let _ = client.get(format!("{base}/metadata/list")).send().await?.bytes().await?;
    let _ = client.post(format!("{base}/raw")).body("raw body fixture").send().await?.text().await?;
    let ws = base.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1) + "/backend-api/codex/responses";
    let tls_mode = match &pem {
        Some(pem) => {
            use rustls::pki_types::pem::PemObject;
            let mut roots = rustls::RootCertStore::empty();
            roots.add(rustls::pki_types::CertificateDer::from_pem_slice(pem)?)?;
            WebSocketTlsMode::Rustls(std::sync::Arc::new(rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth()))
        }
        None => WebSocketTlsMode::TungsteniteDefault,
    };
    let connector = WebSocketConnector::new_with_tls_mode(&factory, tls_mode)?;
    let (mut socket, _) = connector.connect_loopback_direct(ws.into_client_request()?, WebSocketConfig::default()).await?;
    socket.send(Message::Text(original.to_string().into())).await?;
    let mut count = 0;
    while let Some(message) = socket.next().await {
        if let Message::Text(text) = message? {
            count += 1;
            if text.contains("response.completed") { break; }
        }
    }
    assert_eq!(count, 5);
    socket.close().await?;
    // Let the bounded observation worker drain; the harness checks event completeness.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    println!("HTTP zstd + shared HTTP + WebSocket fixture passed");
    Ok(())
}
