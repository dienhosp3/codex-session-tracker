'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_TAG = 'rust-v0.159.2';
const EXPECTED_COMMIT = 'ff6aec96948b70d94983af2641a6b67c94faeff5';

function fail(message) {
  throw new Error(message);
}

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) fail('Patch anchor not found: ' + label);
  if (source.indexOf(before, index + before.length) >= 0) fail('Patch anchor is ambiguous: ' + label);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.writeFileSync(file, content.replace(/\r?\n/g, '\n'), 'utf8');
}

function patchHttpClient(root) {
  const crate = path.join(root, 'codex-rs', 'http-client');
  const cargoFile = path.join(crate, 'Cargo.toml');
  const libFile = path.join(crate, 'src', 'lib.rs');
  const clientFile = path.join(crate, 'src', 'client.rs');
  const responseFile = path.join(crate, 'src', 'response.rs');
  const tapTarget = path.join(crate, 'src', 'tap.rs');

  for (const file of [cargoFile, libFile, clientFile, responseFile]) {
    if (!fs.existsSync(file)) fail('Expected Codex source file not found: ' + file);
  }

  let cargo = read(cargoFile);
  if (!cargo.includes('base64 = { workspace = true }')) {
    cargo = replaceOnce(
      cargo,
      'bytes = { workspace = true }\n',
      'bytes = { workspace = true }\nbase64 = { workspace = true }\n',
      'http-client base64 dependency'
    );
  }
  write(cargoFile, cargo);

  let lib = read(libFile);
  if (!/^mod tap;$/m.test(lib)) {
    lib = replaceOnce(
      lib,
      'mod tls_backend_fallback;\n',
      'mod tls_backend_fallback;\nmod tap;\n',
      'http-client tap module'
    );
  }
  if (!lib.includes('tracker_intercept_websocket_text')) {
    lib = replaceOnce(
      lib,
      'pub use crate::route_aware_client_pool::RouteAwareClientPool;\n',
      '#[doc(hidden)]\npub use crate::tap::tracker_intercept_websocket_binary;\n#[doc(hidden)]\npub use crate::tap::tracker_intercept_websocket_text;\n#[doc(hidden)]\npub use crate::tap::tracker_observe_websocket_binary;\n#[doc(hidden)]\npub use crate::tap::tracker_observe_websocket_text;\npub use crate::route_aware_client_pool::RouteAwareClientPool;\n',
      'http-client hidden websocket hook exports'
    );
  }
  write(libFile, lib);

  let client = read(clientFile);
  if (!client.includes('use crate::tap;')) {
    client = replaceOnce(
      client,
      'use crate::RequestBuilder;\n',
      'use crate::RequestBuilder;\nuse crate::tap;\n',
      'client tap import'
    );
  }

  const oldExecute = `    pub(crate) async fn execute_without_request_logging(
        &self,
        mut request: reqwest::Request,
    ) -> Result<reqwest::Response, reqwest::Error> {
        apply_default_headers(request.headers_mut(), &self.default_headers);
        request.headers_mut().extend(trace_headers());
        self.inner.execute(request).await
    }`;

  const newExecute = `    pub(crate) async fn execute_without_request_logging(
        &self,
        mut request: reqwest::Request,
    ) -> Result<reqwest::Response, reqwest::Error> {
        apply_default_headers(request.headers_mut(), &self.default_headers);
        request.headers_mut().extend(trace_headers());

        // Tracker hook runs after Codex has finalized the request but before reqwest
        // hands it to TLS. Observation is non-blocking; mutation is fail-open and
        // bounded to a short loopback preflight.
        let tap_context = tap::intercept_outbound(&mut request);
        match self.inner.execute(request).await {
            Ok(mut response) => {
                if let Some(context) = tap_context {
                    tap::attach_response_context(&mut response, context);
                }
                Ok(response)
            }
            Err(error) => {
                if let Some(context) = tap_context.as_ref() {
                    tap::emit_request_error(context, &error.to_string());
                }
                Err(error)
            }
        }
    }`;

  if (!client.includes('tap::intercept_outbound(&mut request)')) {
    client = replaceOnce(client, oldExecute, newExecute, 'TransportClient execute hook');
  }
  write(clientFile, client);

  let response = read(responseFile);
  if (!response.includes('use crate::tap;')) {
    response = replaceOnce(
      response,
      'use crate::NetworkPolicy;\n',
      'use crate::NetworkPolicy;\nuse crate::tap;\n',
      'response tap import'
    );
  }

  const oldIntoHttp = `    pub fn into_http_response(
        self,
    ) -> http::Response<impl http_body::Body<Data = Bytes, Error = HttpError> + Send> {
        let response: http::Response<reqwest::Body> = self.inner.into();
        let revoked = self.permit.clone();
        response.map(|body| PolicyBody {
            body: Some(Box::pin(body)),
            permit: self.permit,
            revoked: async move { revoked.revoked().await }.boxed(),
        })
    }`;

  const newIntoHttp = `    pub fn into_http_response(
        self,
    ) -> http::Response<impl http_body::Body<Data = Bytes, Error = HttpError> + Send> {
        let tap_context = tap::response_context(&self.inner);
        let response: http::Response<reqwest::Body> = self.inner.into();
        let revoked = self.permit.clone();
        response.map(|body| PolicyBody {
            body: Some(Box::pin(body)),
            permit: self.permit,
            revoked: async move { revoked.revoked().await }.boxed(),
            tap_context,
        })
    }`;

  if (!response.includes('tap_context,\n        })')) {
    response = replaceOnce(response, oldIntoHttp, newIntoHttp, 'HttpResponse into_http_response hook');
  }

  const oldBytes = `    pub async fn bytes(self) -> Result<Bytes, HttpError> {
        Ok(Box::pin(self.permit.run(self.inner.bytes())).await??)
    }`;
  const newBytes = `    pub async fn bytes(self) -> Result<Bytes, HttpError> {
        let tap_context = tap::response_context(&self.inner);
        let bytes = Box::pin(self.permit.run(self.inner.bytes())).await??;
        if let Some(context) = tap_context.as_ref() {
            tap::emit_response_chunk(context, &bytes);
            tap::emit_response_end(context);
        }
        Ok(bytes)
    }`;
  if (!response.includes('tap::emit_response_chunk(context, &bytes);')) {
    response = replaceOnce(response, oldBytes, newBytes, 'HttpResponse bytes hook');
  }

  const oldText = `    pub async fn text(self) -> Result<String, HttpError> {
        Ok(Box::pin(self.permit.run(self.inner.text())).await??)
    }`;
  const newText = `    pub async fn text(self) -> Result<String, HttpError> {
        let tap_context = tap::response_context(&self.inner);
        let text = Box::pin(self.permit.run(self.inner.text())).await??;
        if let Some(context) = tap_context.as_ref() {
            tap::emit_response_chunk(context, &Bytes::copy_from_slice(text.as_bytes()));
            tap::emit_response_end(context);
        }
        Ok(text)
    }`;
  if (!response.includes('Bytes::copy_from_slice(text.as_bytes())')) {
    response = replaceOnce(response, oldText, newText, 'HttpResponse text hook');
  }

  const oldJson = `    pub async fn json<T: DeserializeOwned>(self) -> Result<T, HttpError> {
        Ok(Box::pin(self.permit.run(self.inner.json())).await??)
    }`;
  const newJson = `    pub async fn json<T: DeserializeOwned>(self) -> Result<T, HttpError> {
        let bytes = self.bytes().await?;
        serde_json::from_slice(&bytes).map_err(|error| HttpError::Build(error.to_string()))
    }`;
  if (!response.includes('serde_json::from_slice(&bytes)')) {
    response = replaceOnce(response, oldJson, newJson, 'HttpResponse json hook');
  }

  const oldChunk = `    pub async fn chunk(&mut self) -> Result<Option<Bytes>, HttpError> {
        Ok(Box::pin(self.permit.run(self.inner.chunk())).await??)
    }`;
  const newChunk = `    pub async fn chunk(&mut self) -> Result<Option<Bytes>, HttpError> {
        let tap_context = tap::response_context(&self.inner);
        let chunk = Box::pin(self.permit.run(self.inner.chunk())).await??;
        if let Some(context) = tap_context.as_ref() {
            match chunk.as_ref() {
                Some(bytes) => tap::emit_response_chunk(context, bytes),
                None => tap::emit_response_end(context),
            }
        }
        Ok(chunk)
    }`;
  if (!response.includes('match chunk.as_ref()')) {
    response = replaceOnce(response, oldChunk, newChunk, 'HttpResponse chunk hook');
  }

  const oldStream = `    pub fn bytes_stream(self) -> impl Stream<Item = Result<Bytes, HttpError>> + Send + Unpin {
        Box::pin(stream::try_unfold(
            (Box::pin(self.inner.bytes_stream()), self.permit),
            |(mut body, permit)| async move {
                let next = permit.run(body.next()).await?;
                next.transpose()
                    .map(|next| next.map(|bytes| (bytes, (body, permit))))
                    .map_err(HttpError::from)
            },
        ))
    }`;
  const newStream = `    pub fn bytes_stream(self) -> impl Stream<Item = Result<Bytes, HttpError>> + Send + Unpin {
        let tap_context = tap::response_context(&self.inner);
        Box::pin(stream::try_unfold(
            (Box::pin(self.inner.bytes_stream()), self.permit, tap_context),
            |(mut body, permit, tap_context)| async move {
                let next = permit.run(body.next()).await?;
                match next.transpose().map_err(HttpError::from)? {
                    Some(bytes) => {
                        if let Some(context) = tap_context.as_ref() {
                            tap::emit_response_chunk(context, &bytes);
                        }
                        Ok(Some((bytes, (body, permit, tap_context))))
                    }
                    None => {
                        if let Some(context) = tap_context.as_ref() {
                            tap::emit_response_end(context);
                        }
                        Ok(None)
                    }
                }
            },
        ))
    }`;
  if (!response.includes('(Box::pin(self.inner.bytes_stream()), self.permit, tap_context)')) {
    response = replaceOnce(response, oldStream, newStream, 'HttpResponse stream hook');
  }

  const oldPolicyBody = `struct PolicyBody<B> {
    body: Option<Pin<Box<B>>>,
    permit: NetworkPermit,
    revoked: BoxFuture<'static, ()>,
}`;
  const newPolicyBody = `struct PolicyBody<B> {
    body: Option<Pin<Box<B>>>,
    permit: NetworkPermit,
    revoked: BoxFuture<'static, ()>,
    tap_context: Option<tap::TapContext>,
}`;
  if (!response.includes('tap_context: Option<tap::TapContext>')) {
    response = replaceOnce(response, oldPolicyBody, newPolicyBody, 'PolicyBody tap context');
  }

  const oldPolicyPoll = `        inner
            .as_mut()
            .poll_frame(cx)
            .map(|frame| frame.map(|frame| frame.map_err(HttpError::from)))`;

  const newPolicyPoll = `        match inner.as_mut().poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(context) = body.tap_context.as_ref()
                    && let Some(bytes) = frame.data_ref()
                {
                    tap::emit_response_chunk(context, bytes);
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(error))) => {
                if let Some(context) = body.tap_context.as_ref() {
                    tap::emit_request_error(context, &error.to_string());
                    tap::emit_response_end(context);
                }
                Poll::Ready(Some(Err(HttpError::from(error))))
            }
            Poll::Ready(None) => {
                if let Some(context) = body.tap_context.as_ref() {
                    tap::emit_response_end(context);
                }
                body.body = None;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }`;

  if (!response.includes('frame.data_ref()')) {
    response = replaceOnce(response, oldPolicyPoll, newPolicyPoll, 'PolicyBody poll_frame hook');
  }

  write(responseFile, response);
  fs.copyFileSync(path.join(__dirname, 'src', 'tap.rs'), tapTarget);

  return [cargoFile, libFile, clientFile, responseFile, tapTarget];
}

function patchWebsocketClient(root) {
  const file = path.join(root, 'codex-rs', 'websocket-client', 'src', 'lib.rs');
  if (!fs.existsSync(file)) fail('Expected Codex websocket source file not found: ' + file);
  let source = read(file);

  if (!source.includes('tracker_intercept_websocket_text')) {
    source = replaceOnce(
      source,
      'use codex_http_client::OutboundProxyRoute;\n',
      'use codex_http_client::OutboundProxyRoute;\nuse codex_http_client::tracker_intercept_websocket_binary;\nuse codex_http_client::tracker_intercept_websocket_text;\nuse codex_http_client::tracker_observe_websocket_binary;\nuse codex_http_client::tracker_observe_websocket_text;\n',
      'websocket tracker hook imports'
    );
  }

  if (!source.includes('WebSocketConnection::new(inner, permit, uri.to_string())')) {
    source = replaceOnce(
      source,
      'Ok((WebSocketConnection::new(inner, permit), response))',
      'Ok((WebSocketConnection::new(inner, permit, uri.to_string()), response))',
      'websocket connection URL'
    );
  }

  if (!source.includes('hook_url: String,')) {
    source = replaceOnce(
      source,
      '    read_terminated: bool,\n}',
      '    read_terminated: bool,\n    hook_url: String,\n}',
      'websocket hook URL field'
    );
  }

  if (!source.includes('fn new(inner: ConnectionInner, permit: NetworkPermit, hook_url: String)')) {
    source = replaceOnce(
      source,
      '    fn new(inner: ConnectionInner, permit: NetworkPermit) -> Self {',
      '    fn new(inner: ConnectionInner, permit: NetworkPermit, hook_url: String) -> Self {',
      'websocket connection constructor'
    );
    source = replaceOnce(
      source,
      '            read_terminated: false,\n        }',
      '            read_terminated: false,\n            hook_url,\n        }',
      'websocket constructor hook URL'
    );
  }

  const oldPollTail = `        if matches!(&next, Poll::Ready(None)) {
            connection.read_terminated = true;
        }
        next`;
  const newPollTail = `        match &next {
            Poll::Ready(Some(Ok(Message::Text(text)))) => {
                tracker_observe_websocket_text(&connection.hook_url, text.as_ref());
            }
            Poll::Ready(Some(Ok(Message::Binary(bytes)))) => {
                tracker_observe_websocket_binary(&connection.hook_url, bytes.as_ref());
            }
            _ => {}
        }
        if matches!(&next, Poll::Ready(None)) {
            connection.read_terminated = true;
        }
        next`;
  if (!source.includes('tracker_observe_websocket_text(&connection.hook_url')) {
    source = replaceOnce(source, oldPollTail, newPollTail, 'websocket inbound plaintext hook');
  }

  const oldStartSend = `    fn start_send(self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        let connection = self.get_mut();
        if let Err(error) = connection.permit.check() {
            connection.inner = None;
            return Err(policy_error(error));
        }
        match &mut connection.inner {
            Some(stream) => Pin::new(stream).start_send(message),
            None => Err(WebSocketError::ConnectionClosed),
        }
    }`;

  const newStartSend = `    fn start_send(self: Pin<&mut Self>, message: Message) -> Result<(), Self::Error> {
        let connection = self.get_mut();
        if let Err(error) = connection.permit.check() {
            connection.inner = None;
            return Err(policy_error(error));
        }
        let message = match message {
            Message::Text(text) => Message::Text(
                tracker_intercept_websocket_text(&connection.hook_url, text.to_string()).into(),
            ),
            Message::Binary(bytes) => Message::Binary(
                tracker_intercept_websocket_binary(&connection.hook_url, bytes.as_ref()).into(),
            ),
            other => other,
        };
        match &mut connection.inner {
            Some(stream) => Pin::new(stream).start_send(message),
            None => Err(WebSocketError::ConnectionClosed),
        }
    }`;

  if (!source.includes('tracker_intercept_websocket_text(&connection.hook_url')) {
    source = replaceOnce(source, oldStartSend, newStartSend, 'websocket outbound plaintext hook');
  }

  write(file, source);
  return [file];
}

function run(root) {
  root = path.resolve(root || '');
  const patched = [
    ...patchHttpClient(root),
    ...patchWebsocketClient(root)
  ];

  return {
    expectedTag: EXPECTED_TAG,
    expectedCommit: EXPECTED_COMMIT,
    patched: patched.map(file => path.relative(root, file))
  };
}

if (require.main === module) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: node codex-hook/apply_patch.js <openai-codex-source-root>');
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(run(root), null, 2));
  } catch (error) {
    console.error(error && error.stack || String(error));
    process.exit(1);
  }
}

module.exports = { run, replaceOnce, EXPECTED_TAG, EXPECTED_COMMIT };
