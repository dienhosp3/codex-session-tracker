'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(process.argv[2]||'.runtime-build/codex');
const revision=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(revision!=='ff6aec96948b70d94983af2641a6b67c94faeff5')throw new Error('Runtime source must match Codex rust-v0.159.2 exactly.');
function edit(file,changes){
  const target=path.join(root,'codex-rs',file);let source=cp.execFileSync('git',['show','HEAD:codex-rs/'+file],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}).replace(/\r\n/g,'\n');
  for(const [from,to] of changes){if(!source.includes(from))throw new Error('Source anchor missing: '+file);source=source.replace(from,to);}
  fs.writeFileSync(target,source);
}
fs.copyFileSync('runtime/tracker_hook.rs',path.join(root,'codex-rs/http-client/src/tracker_hook.rs'));
edit('chatgpt/src/lib.rs', [['pub mod ', '#![recursion_limit = "256"]\npub mod ']]);
edit('http-client/Cargo.toml',[[ '[dependencies]','[dependencies]\nbase64 = { workspace = true }' ]]);
edit('http-client/src/lib.rs',[[ 'mod transport;','mod transport;\npub mod tracker_hook;' ]]);
edit('http-client/src/request.rs',[
  ['pub struct Request {','pub struct Request {\n    pub tracker_request_id: Option<String>,'],
  ['        Self {\n            method,','        Self {\n            tracker_request_id: None,\n            method,'],
  ['    pub fn into_prepared(mut self) -> Result<Self, String> {','    pub fn into_prepared(mut self) -> Result<Self, String> {\n        self.tracker_prepare()?;'],
  ['    pub fn prepare_body_for_send(&self) -> Result<PreparedRequestBody, String> {',`    pub fn tracker_prepare(&mut self) -> Result<(), String> {
        if self.tracker_request_id.is_some() { return Ok(()); }
        let original = match self.body.as_ref() {
            Some(RequestBody::Json(body)) => serde_json::to_string(body).map_err(|error| error.to_string())?,
            Some(RequestBody::EncodedJson(body)) if !body.prepared => String::from_utf8(body.bytes.to_vec()).map_err(|_| "Tracker requires JSON UTF-8")?,
            Some(RequestBody::EncodedJson(_)) => return Ok(()),
            Some(RequestBody::Raw(body)) => {
                if let Some(result) = crate::tracker_hook::prepare_raw(self.method.as_str(), &self.url, body, false)? {
                    self.tracker_request_id = Some(result.request_id);
                }
                return Ok(());
            },
            None => String::new(),
        };
        if let Some(result) = crate::tracker_hook::prepare(self.method.as_str(), &self.url, "http", original.clone())? {
            self.tracker_request_id = Some(result.request_id);
            if result.body_json != original {
                self.body = Some(RequestBody::EncodedJson(EncodedJsonBody { bytes: Bytes::from(result.body_json), trace_bytes: None, prepared: false }));
                self.headers.remove(http::header::CONTENT_LENGTH);
            }
        }
        Ok(())
    }
    pub fn prepare_body_for_send(&self) -> Result<PreparedRequestBody, String> {`]
]);
edit('codex-client/src/provider.rs',[[ '        Request {\n            method,','        Request {\n            tracker_request_id: None,\n            method,' ]]);
edit('http-client/src/request_builder.rs',[
  ['        match self.backend {\n            HttpClientBackend::Routed(pool) => pool.send(self.request?).await,',`        let mut draft = self.request?;
        let method = draft.request.method().to_string();
        let url = draft.request.url().to_string();
        let original = draft.request.body().and_then(|body| body.as_bytes());
        let json = original.and_then(|bytes| std::str::from_utf8(bytes).ok())
            .filter(|text| serde_json::from_str::<serde_json::Value>(text).is_ok());
        let prepared = match json {
            Some(json) => crate::tracker_hook::prepare(&method, &url, "http", json.to_owned()),
            None => crate::tracker_hook::prepare_raw(&method, &url, original.unwrap_or_default(), draft.request.body().is_some() && original.is_none()),
        }.map_err(HttpError::Build)?;
        let tracker = prepared.as_ref().and_then(|value| crate::tracker_hook::Observation::new(Some(value.request_id.clone()), &method, &url, "http"));
        if let (Some(prepared), Some(original)) = (&prepared, json) {
            if prepared.body_json != original {
                *draft.request.body_mut() = Some(prepared.body_json.clone().into());
                draft.request.headers_mut().remove(http::header::CONTENT_LENGTH);
                for update in &mut draft.headers {
                    if let HeaderUpdate::Replace(headers) = update { headers.remove(http::header::CONTENT_LENGTH); }
                }
                draft.headers.retain(|update| !matches!(update, HeaderUpdate::Append(name, _) if *name == http::header::CONTENT_LENGTH));
            }
        }
        let response = match self.backend {
            HttpClientBackend::Routed(pool) => pool.send(draft).await,`],
  ['                Ok(client.execute(self.request?.build(&client)?).await?.into())','                Ok(client.execute(draft.build(&client)?).await?.into())'],
  ['        }\n    }\n}\n\n#[cfg(test)]',`        };
        match response {
            Ok(response) => Ok(response.with_tracker(tracker)),
            Err(error) => { if let Some(tracker) = tracker { tracker.error(); } Err(error) }
        }
    }
}

#[cfg(test)]`]
]);
edit('http-client/src/response.rs',[
  ['impl HttpResponse {',`impl HttpResponse {
    pub(crate) fn with_tracker(self, tracker: Option<crate::tracker_hook::Observation>) -> Self {
        use reqwest::ResponseBuilderExt;
        let Some(tracker) = tracker else { return self; };
        tracker.sent(); tracker.headers(self.inner.status().as_u16(), self.inner.headers());
        let url = self.inner.url().clone();
        let mut response: http::Response<reqwest::Body> = self.inner.into();
        response.extensions_mut().extend(http::Response::builder().url(url).body(()).expect("valid response URL").into_parts().0.extensions);
        let response = response.map(|inner| reqwest::Body::wrap(crate::tracker_hook::TrackedBody { inner: Box::pin(inner), tracker }));
        Self { inner: reqwest::Response::from(response), permit: self.permit }
    }`]
]);
edit('http-client/src/transport.rs',[
  ['    async fn send(&self, req: Request) -> Result<HttpResponse, TransportError> {','    async fn send(&self, mut req: Request) -> Result<HttpResponse, TransportError> {\n        req.tracker_prepare().map_err(TransportError::Build)?;'],
  ['        let Request {\n            method,','        let Request {\n            tracker_request_id: _,\n            method,'],
  ['        let resp = self.send(req).await?;', '        let resp = self.send(req).await.map_err(|error| { if let Some(tracker) = &tracker { tracker.error(); } error })?.with_tracker(tracker);'],
  ['        let resp = self.send(req).await?;', '        let resp = self.send(req).await.map_err(|error| { if let Some(tracker) = &tracker { tracker.error(); } error })?.with_tracker(tracker);'],
  ['    async fn execute(&self, req: Request) -> Result<Response, TransportError> {','    async fn execute(&self, mut req: Request) -> Result<Response, TransportError> {\n        req.tracker_prepare().map_err(TransportError::Build)?;\n        let tracker = crate::tracker_hook::Observation::new(req.tracker_request_id.clone(), req.method.as_str(), &req.url, "http");'],
  ['    async fn stream(&self, req: Request) -> Result<StreamResponse, TransportError> {','    async fn stream(&self, mut req: Request) -> Result<StreamResponse, TransportError> {\n        req.tracker_prepare().map_err(TransportError::Build)?;\n        let tracker = crate::tracker_hook::Observation::new(req.tracker_request_id.clone(), req.method.as_str(), &req.url, "http");'],
]);
edit('codex-api/src/endpoint/responses_websocket.rs',[]);
edit('websocket-client/Cargo.toml', [['[dependencies]', '[dependencies]\nserde_json = { workspace = true }']]);
edit('websocket-client/src/lib.rs',[
  ['pub struct WebSocketConnection {','pub struct WebSocketConnection {\n    tracker_url: String,\n    tracker: Option<codex_http_client::tracker_hook::Observation>,\n    tracker_pending: Option<codex_http_client::tracker_hook::Observation>,'],
  ['            inner: Some(inner),','            tracker_url: String::new(),\n            tracker: None,\n            tracker_pending: None,\n            inner: Some(inner),'],
  ['        Ok((WebSocketConnection::new(inner, permit), response))',`        let mut connection = WebSocketConnection::new(inner, permit);
        connection.tracker_url = url.to_string();
        Ok((connection, response))`],
  ['        if matches!(&next, Poll::Ready(None)) {',`        if let Some(tracker) = &connection.tracker {
            match &next {
                Poll::Ready(Some(Ok(Message::Text(text)))) => tracker.chunk(text.as_bytes()),
                Poll::Ready(Some(Err(_))) => tracker.error(),
                Poll::Ready(None) => tracker.finished(),
                _ => {}
            }
        }
        if matches!(&next, Poll::Ready(None)) {`],
  ['    fn start_send(self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {', '    fn start_send(self: Pin<&mut Self>, mut message: Message) -> Result<(), Self::Error> {'],
  ['        match &mut connection.inner {\n            Some(stream) => Pin::new(stream).start_send(message),',`        if let Message::Text(text) = &message {
            let control = serde_json::from_str::<serde_json::Value>(text).ok()
                .and_then(|value| value["type"].as_str().map(str::to_owned)).as_deref() == Some("response.interrupt");
            if let Some(result) = codex_http_client::tracker_hook::prepare("GET", &connection.tracker_url, "websocket", text.to_string())
                .map_err(|error| WebSocketError::Io(io::Error::other(error)))? {
                let observation = codex_http_client::tracker_hook::Observation::new(Some(result.request_id), "GET", &connection.tracker_url, "websocket");
                if !control { connection.tracker = observation.clone(); }
                connection.tracker_pending = observation;
                message = Message::Text(result.body_json.into());
            }
        }
        match &mut connection.inner {
            Some(stream) => Pin::new(stream).start_send(message),`],
  ['            Some(stream) => Pin::new(stream).poll_flush(context),',`            Some(stream) => {
                let result = Pin::new(stream).poll_flush(context);
                if let Poll::Ready(result) = &result {
                    if let Some(tracker) = connection.tracker_pending.take() {
                        if result.is_ok() { tracker.sent(); } else { tracker.error(); }
                    }
                }
                result
            },`]
]);
console.log('Patched Codex 0.159.2 client JSON and raw response paths.');
const examples=path.join(root,'codex-rs/websocket-client/examples');
fs.mkdirSync(examples,{recursive:true});
fs.copyFileSync('runtime/client_fixture.rs',path.join(examples,'tracker_client_fixture.rs'));
