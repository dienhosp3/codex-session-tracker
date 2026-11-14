"""Local JSON IPC SDK. Requires the shared Node runtime; no browser dependencies."""
import json
import os
from pathlib import Path
import socket
import time
import uuid
import subprocess
import logging
from logging.handlers import RotatingFileHandler
import threading

_diagnostic_lock = threading.Lock()


class CoreError(RuntimeError):
    def __init__(self, error):
        super().__init__(error.get('message', 'Core request failed'))
        self.code = error.get('code', 'CORE_FAILED')
        self.details = error.get('details', {})


def inspect_launcher_file(bat_path, core_path=None, node_path='node'):
    """Use the shared static parser; never start Chrome or a runtime."""
    root = resolve_runtime(core_path)
    result=subprocess.run([node_path,str(root/'src/launcher-inspect.js'),str(bat_path)],capture_output=True,text=True,encoding='utf-8',timeout=20)
    try:value=json.loads(result.stdout)
    except ValueError:raise CoreError({'code':'BAT_INSPECTION_FAILED','message':result.stderr.strip() or 'Static BAT inspection failed'})
    if value.get('error'):raise CoreError(value['error'])
    return value['result']


def shared_runtime_home():
    configured = os.environ.get('AHUST_CHATGPT_RUNTIME_HOME')
    if configured:
        return Path(configured).expanduser().resolve()
    base = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local')) if os.name == 'nt' else Path.home() / '.local/share'
    return base / 'AHUST/ChatGPTCore/runtime'


def resolve_runtime(core_path=None, runtime_home=None):
    """Locate code only. Never start or stop a runtime or change its data home."""
    explicit = core_path or os.environ.get('AHUST_CHATGPT_CORE_PATH')
    expected_version = None
    if explicit:
        root = Path(explicit).expanduser().resolve()
    else:
        installation = Path(runtime_home or shared_runtime_home()).resolve()
        manifest_path = installation / 'current.json'
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        except FileNotFoundError:
            root = Path(__file__).resolve().parents[2]
            if not (root / 'src/server.js').is_file():
                raise CoreError({'code': 'CORE_RUNTIME_MISSING', 'message': 'Install the shared ChatGPT Core runtime before starting this application', 'details': {'manifestPath': str(manifest_path)}})
        except (OSError, ValueError) as error:
            raise CoreError({'code': 'CORE_RUNTIME_MANIFEST_INVALID', 'message': 'Cannot read the shared runtime activation manifest', 'details': {'manifestPath': str(manifest_path)}}) from error
        else:
            relative = manifest.get('runtimePath') if isinstance(manifest, dict) else None
            if not isinstance(relative, str) or Path(relative).is_absolute() or manifest.get('manifestVersion') != 1 or manifest.get('contractVersion') != '1' or not isinstance(manifest.get('version'), str):
                raise CoreError({'code': 'CORE_RUNTIME_MANIFEST_INVALID', 'message': 'Unsupported shared runtime activation manifest'})
            root = (installation / relative).resolve()
            if root == installation / 'versions' or installation / 'versions' not in root.parents:
                raise CoreError({'code': 'CORE_RUNTIME_MANIFEST_INVALID', 'message': 'The activated runtime must belong to its versions directory'})
            expected_version = manifest['version']
    try:
        metadata = json.loads((root / 'package.json').read_text(encoding='utf-8'))
        valid = metadata.get('name') == '@ahust/chatgpt-core' and (not expected_version or metadata.get('version') == expected_version) and (root / 'src/server.js').is_file()
        if not valid:
            raise ValueError('Incomplete runtime installation')
    except (OSError, ValueError, AttributeError) as error:
        raise CoreError({'code': 'CORE_RUNTIME_INVALID', 'message': 'The selected ChatGPT Core installation is incomplete', 'details': {'runtimePath': str(root)}}) from error
    return root


def _capabilities(value):
    if value is None:
        return []
    if not isinstance(value, (list, tuple)) or not all(isinstance(action, str) and action for action in value):
        raise CoreError({'code': 'INVALID_CAPABILITIES', 'message': 'Capabilities must be a list of action names'})
    return list(dict.fromkeys(value))


class ChatGPTClient:
    def __init__(self, consumer, home=None, node_path='node', core_path=None, required_capabilities=None, runtime_home=None):
        self.consumer = consumer
        self.home = Path(home or os.environ.get('AHUST_CHATGPT_HOME') or (Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local')) / 'AHUST/ChatGPTCore' if os.name == 'nt' else Path.home() / '.local/share/AHUST/ChatGPTCore')).expanduser().resolve()
        self.node_path = node_path
        self.sdk_path = Path(__file__).resolve().parents[2]
        self.core_path = Path(core_path).resolve() if core_path else None
        self.runtime_home = str(runtime_home) if runtime_home else None
        self.required_capabilities = _capabilities(required_capabilities)
        self.description = None

    def negotiate(self, required_capabilities=None):
        required = self.required_capabilities if required_capabilities is None else _capabilities(required_capabilities)
        description = self.request('health.check', timeout=15)
        if description.get('protocolVersion') != '1' or description.get('contractVersion') != '1':
            raise CoreError({'code': 'CORE_CONTRACT_UNSUPPORTED', 'message': 'The runtime does not provide the required public contract', 'details': {'version': description.get('version'), 'requiredContract': '1', 'actualContract': description.get('contractVersion')}})
        capabilities = description.get('capabilities') or {}
        if not isinstance(capabilities, dict):
            capabilities = {}
        missing = [action for action in required if not isinstance(capabilities.get(action), int) or capabilities[action] < 1]
        if missing:
            raise CoreError({'code': 'CORE_CAPABILITY_MISSING', 'message': 'The runtime is missing required capabilities', 'details': {'version': description.get('version'), 'missing': missing}})
        self.description = description
        return description

    def request(self, action, args=None, request_id=None, timeout=None, recover_timeouts=None):
        command = {'protocolVersion': '1', 'consumer': self.consumer, 'requestId': request_id or str(uuid.uuid4()), 'action': action, 'args': args or {}}
        if timeout is None:
            timeout = 600
        if recover_timeouts not in (None, 0):
            raise CoreError({'code': 'INVALID_RECOVERY_POLICY', 'message': 'Automatic timeout recovery was removed; inspect the durable operation or explicitly repeat its request ID'})
        try:
            if os.name != 'nt' and action != 'health.check' and self.required_capabilities:
                self.negotiate()
            try:
                return self._exchange(command, timeout)
            except (FileNotFoundError, ConnectionRefusedError):
                # Connection was never established. Node serializes startup;
                # a lost response after dispatch is not retried here.
                return self._run_bridge(command, timeout)
            except TimeoutError as error:
                raise CoreError({'code': 'CLIENT_TIMEOUT', 'message': 'Core request timed out; inspect its operation before starting new work'}) from error
        except CoreError as error:
            if error.code in ('CLIENT_TIMEOUT', 'CONNECTION_LOST', 'CORE_START_FAILED', 'CORE_BRIDGE_FAILED', 'CORE_BRIDGE_RESPONSE_INVALID'):
                self.description = None
            error.details.update(action=action, requestId=command['requestId'])
            if error.code in ('CLIENT_TIMEOUT', 'CONNECTION_LOST'):
                error.details.update(requestMayBeRunning=True, recoveryAttempts=0)
            raise

    def _exchange(self, command, timeout):
        if os.name == 'nt':
            # A one-shot Node bridge supplies deadlines for Windows named pipes.
            return self._run_bridge(command, timeout)
        token = (self.home / 'runtime.token').read_text(encoding='utf-8').strip()
        message = (json.dumps({'token': token, 'command': command}, ensure_ascii=False) + '\n').encode('utf-8')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(str(self.home / 'runtime.sock'))
            client.sendall(message)
            chunks = b''
            while b'\n' not in chunks:
                chunk = client.recv(65536)
                if not chunk:
                    raise CoreError({'code': 'CONNECTION_LOST', 'message': 'Core disconnected; reuse request_id for recovery'})
                chunks += chunk
                if len(chunks) > 64 * 1024 * 1024:
                    raise CoreError({'code': 'RESPONSE_TOO_LARGE', 'message': 'Core response too large'})
            return self._unwrap(json.loads(chunks.split(b'\n', 1)[0]))

    def _run_bridge(self, command, timeout):
        script = self.sdk_path / 'src/python_bridge.js'
        try:
            bridge_input = {'home': str(self.home), 'command': command, 'timeoutMs': int(timeout * 1000),
                            'runtimePath': str(self.core_path) if self.core_path else None,
                            'runtimeHome': self.runtime_home, 'requiredCapabilities': self.required_capabilities}
            result = subprocess.run([self.node_path, str(script)], input=json.dumps(bridge_input), text=True, encoding='utf-8', errors='replace', capture_output=True, timeout=timeout + 20, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        except subprocess.TimeoutExpired as error:
            raise self._bridge_error(command, 'CLIENT_TIMEOUT', 'Core bridge timed out; recover using the same requestId before sending again', cause=type(error).__name__) from error
        except OSError as error:
            raise self._bridge_error(command, 'CORE_BRIDGE_FAILED', 'Could not launch the core bridge', cause=type(error).__name__, dispatched=False) from error
        try:
            response = json.loads(result.stdout)
        except (ValueError, TypeError) as error:
            raise self._bridge_error(command, 'CORE_BRIDGE_FAILED', 'Core bridge exited without a valid response; inspect the diagnostic log and recover using the same requestId', returncode=result.returncode, stdoutBytes=len((result.stdout or '').encode('utf-8')), stderr=(result.stderr or '')[-4000:]) from error
        valid = isinstance(response, dict) and ((response.get('status') == 'completed' and 'result' in response and result.returncode == 0) or (response.get('status') == 'failed' and isinstance(response.get('error'), dict) and isinstance(response['error'].get('message'), str) and isinstance(response['error'].get('code'), str)))
        if not valid:
            raise self._bridge_error(command, 'CORE_BRIDGE_RESPONSE_INVALID', 'Core bridge returned an invalid response envelope; recover using the same requestId', returncode=result.returncode, stderr=(result.stderr or '')[-4000:])
        if response['status'] == 'failed' and response['error']['code'] == 'CORE_BRIDGE_LOAD_FAILED':
            error = response['error']
            raise self._bridge_error(command, error['code'], error['message'], **error.get('details', {}))
        return self._unwrap(response)

    def _bridge_error(self, command, code, message, **details):
        identity = str(uuid.uuid4())
        path = self.home / 'logs/python-bridge.jsonl'
        fields = {'time': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'diagnosticId': identity, 'code': code, 'action': command['action'], 'requestId': command['requestId'], 'nodePath': self.node_path, 'bridgePath': str(self.sdk_path / 'src/python_bridge.js'), **details}
        try:
            with _diagnostic_lock:
                path.parent.mkdir(parents=True, exist_ok=True)
                handler = RotatingFileHandler(path, maxBytes=1024 * 1024, backupCount=3, encoding='utf-8')
                try:
                    handler.emit(logging.LogRecord('ahust.bridge', logging.ERROR, '', 0, json.dumps(fields, ensure_ascii=False), (), None))
                finally:
                    handler.close()
            details.update(diagnosticId=identity, logPath=str(path))
        except OSError:
            pass
        return CoreError({'code': code, 'message': message, 'details': {'action': command['action'], 'requestId': command['requestId'], **{k: v for k, v in details.items() if k != 'stderr'}}})

    @staticmethod
    def _unwrap(response):
        if response.get('status') == 'failed':
            raise CoreError(response['error'])
        return response['result']
