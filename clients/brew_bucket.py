"""brew-bucket client. Requires `requests`.

    pip install requests

    from brew_bucket import BrewBucket
    bb = BrewBucket(base_url=os.environ["BREW_BUCKET_URL"],
                    api_key=os.environ["BREW_BUCKET_KEY"])
    bb.put_file("backups", "db/nightly.sql.gz", "/tmp/nightly.sql.gz")
"""
import hashlib
import os
from urllib.parse import quote

import requests


class BrewBucketError(RuntimeError):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class BrewBucket:
    def __init__(self, base_url, api_key, timeout=300):
        if not base_url or not api_key:
            raise ValueError("base_url and api_key are required")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers["X-API-Key"] = api_key

    def _url(self, path):
        return f"{self.base_url}/api/v1{path}"

    @staticmethod
    def _encode(key):
        return "/".join(quote(part, safe="") for part in key.split("/"))

    def _check(self, res):
        if res.status_code >= 400:
            try:
                message = res.json().get("error", res.text)
            except ValueError:
                message = res.text
            raise BrewBucketError(message, res.status_code)
        return res

    def list(self, bucket, prefix="", cursor="", limit=200):
        res = self.session.get(self._url(f"/b/{bucket}/o"),
                               params={"prefix": prefix, "cursor": cursor, "limit": limit},
                               timeout=self.timeout)
        return self._check(res).json()

    def put_file(self, bucket, key, path, content_type="application/octet-stream", metadata=None):
        headers = {"Content-Type": content_type, "Content-Length": str(os.path.getsize(path))}
        for k, v in (metadata or {}).items():
            headers[f"X-Meta-{k}"] = str(v)
        # requests streams a file object rather than reading it into memory.
        with open(path, "rb") as fh:
            res = self.session.put(self._url(f"/b/{bucket}/o/{self._encode(key)}"),
                                   data=fh, headers=headers, timeout=self.timeout)
        return self._check(res).json()

    def put_bytes(self, bucket, key, payload, content_type="application/octet-stream"):
        res = self.session.put(self._url(f"/b/{bucket}/o/{self._encode(key)}"),
                               data=payload, headers={"Content-Type": content_type},
                               timeout=self.timeout)
        return self._check(res).json()

    def get_file(self, bucket, key, dest, version=None):
        params = {"version": version} if version else None
        with self.session.get(self._url(f"/b/{bucket}/o/{self._encode(key)}"),
                              params=params, stream=True, timeout=self.timeout) as res:
            self._check(res)
            with open(dest, "wb") as fh:
                for chunk in res.iter_content(chunk_size=1024 * 1024):
                    fh.write(chunk)
        return dest

    def delete(self, bucket, key, all_versions=False):
        params = {"all": "true"} if all_versions else None
        res = self.session.delete(self._url(f"/b/{bucket}/o/{self._encode(key)}"),
                                  params=params, timeout=self.timeout)
        return self._check(res).json()

    def share(self, bucket, key, expires_hours=168, max_hits=None):
        res = self.session.post(self._url("/shares"),
                                json={"bucket": bucket, "key": key,
                                      "expires_hours": expires_hours, "max_hits": max_hits},
                                timeout=self.timeout)
        return self._check(res).json()


def sha256_file(path, chunk=1024 * 1024):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()
