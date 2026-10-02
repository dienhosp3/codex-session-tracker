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

function run(root) {
  root = path.resolve(root || '');
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
    lib = replaceOnce(lib, 'mod tls_backend_fallback;\n', 'mod tls_backend_fallback;\nmod tap;\n', 'http-client tap module');
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
        // hands it to TLS. It is fail-open: observation/mutation can never make the
        // Tracker a hard dependency for normal Codex networking.
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
  write(responseFile, response);

  fs.copyFileSync(path.join(__dirname, 'src', 'tap.rs'), tapTarget);

  return {
    expectedTag: EXPECTED_TAG,
    expectedCommit: EXPECTED_COMMIT,
    patched: [
      path.relative(root, cargoFile),
      path.relative(root, libFile),
      path.relative(root, clientFile),
      path.relative(root, responseFile),
      path.relative(root, tapTarget)
    ]
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
