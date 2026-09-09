import requests
import platform
from typing import Any, Dict, Optional, Union
try:
    from browser import FormData  # For Pyodide/browser compatibility
except ImportError:
    from requests_toolbelt.multipart.encoder import MultipartEncoder as FormData  # For Node-like environments

class DeepJSONClient:
    def __init__(self, config: Dict[str, Any]):
        self.base_url = config.get('base_url')
        self.token = config.get('token')
        self.storage = config.get('storage', 'memory')
        
        # Transmission options
        self.binary = False
        self.overwrite_key = False
        self.get_body = False
        
        # Platform detection
        self.is_node = platform.system() != "Emscripten"
        
        # Configure session
        self.session = requests.Session()
        self.session.headers.update({
            'Accept': 'application/json',
            'User-Agent': 'DeepJSONClient/1.0'
        })
        self.timeout = config.get('timeout', 10.0)

    # Authentication methods
    def login(self, username: str, password: str) -> Dict[str, Any]:
        try:
            response = self.session.post(
                f"{self.base_url}/auth/login",
                json={'username': username, 'password': password},
                timeout=self.timeout
            )
            response.raise_for_status()
            data = response.json()
            self.token = data.get('token')
            return data
        except requests.RequestException as error:
            self._handle_error(error)

    def get_token(self) -> Optional[str]:
        return self.token

    def is_binary(self) -> bool:
        return self.binary

    def set_binary(self, true_or_false: bool) -> 'DeepJSONClient':
        self.binary = true_or_false
        return self

    def is_overwrite_key(self) -> bool:
        return self.overwrite_key

    def set_overwrite_key(self, true_or_false: bool) -> 'DeepJSONClient':
        self.overwrite_key = true_or_false
        return self

    def has_get_body(self) -> bool:
        return self.get_body

    def set_get_body(self, true_or_false: bool) -> 'DeepJSONClient':
        self.get_body = true_or_false
        return self

    # Core CRUD operations
    def get(self, key: str, value: str = '') -> Any:
        headers = {}
        params = {}
        http_method = "GET"
        if self.get_body:
            headers['X-Method-Override'] = "GET"
            http_method = "POST"
        if self.binary:
            params['binary'] = True
            params['token'] = self.token
        return self._request(http_method, f"/keys/{key}", params=params, data=value, headers=headers)

    def post(self, key: str, value: Any) -> Any:
        headers = {}
        if self.overwrite_key:
            headers['X-Override-Existing'] = 'true'
        return self._request('POST', f"/keys/{key}", data=value, headers=headers)

    def put(self, key: str, value: Any) -> Any:
        headers = {}
        return self._request('PUT', f"/keys/{key}", data=value, headers=headers)

    def delete(self, key: str) -> Any:
        headers = {}
        return self._request('DELETE', f"/keys/{key}", headers=headers)

    def move(self, key: str, params: Dict[str, Any], key_to: str) -> Any:
        headers = {
            'X-Method-Override': "MOVE",
            'X-Move-Target': key_to
        }
        return self._request('POST', f"/keys/{key}", params=params, headers=headers)

    # Universal file upload
    def upload_file(self, key: str, file: Any, options: Dict[str, Any] = {}) -> Any:
        if self.is_node:
            # Node-like FormData handling
            form = FormData(fields={
                'file': (file.name, file.stream(), 'application/octet-stream')
            })
            headers = {
                'Content-Type': form.content_type,
                'X-Override-Existing': 'true' if options.get('overwrite') else 'false'
            }
        else:
            # Browser-like FormData handling
            form = FormData()
            form.append('file', file, file.name)
            headers = {'X-Override-Existing': 'true' if options.get('overwrite') else 'false'}

        return self._request('POST', f"/keys/{key}", data=form, headers=headers)

    # Admin methods
    def list_keys(self, filters: Dict[str, Any]) -> Any:
        return self._request('GET', '/admin/keys', params=filters)

    # Private methods
    def _request(self, method: str, path: str, params: Optional[Dict] = None, 
                data: Any = None, headers: Optional[Dict] = None) -> Any:
        try:
            request_headers = {
                **(headers or {}),
                **({'Authorization': f"Bearer {self.token}"} if self.token else {})
            }
            
            # Handle FormData and content type
            if isinstance(data, FormData):
                request_headers.update({'Content-Type': data.content_type})
            else:
                request_headers["Content-Type"] = "text/plain; charset=utf-8"

            # Prepare request
            response = self.session.request(
                method=method,
                url=f"{self.base_url}{path}",
                params=params or {},
                data=data,
                headers=request_headers,
                timeout=self.timeout
            )
            
            self._reset_flags()
            response.raise_for_status()
            return response.json()
        except requests.RequestException as error:
            self._handle_error(error)

    def _reset_flags(self):
        self.binary = False
        self.overwrite_key = False
        self.get_body = False

    def _handle_error(self, error: requests.RequestException):
        if hasattr(error, 'response') and error.response:
            err = Exception(f"API Error: {error.response.status_code} {error.response.reason}")
            err.status = error.response.status_code
            try:
                err.details = error.response.json()
            except ValueError:
                err.details = error.response.text
            raise err
        elif isinstance(error, requests.ConnectionError):
            raise Exception('Network Error: No response from server')
        else:
            raise Exception(f"Request Error: {str(error)}")